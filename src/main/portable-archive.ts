import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import { PORTABLE_LIMITS } from '../shared/portable-backup'
import { assertUnlinkedPath, openVerifiedFile, readBoundedFile } from './file-boundary'

export interface PortableArchiveOptions {
  signal?: AbortSignal
  /** Completed entries (including the manifest), not bytes. */
  onProgress?: (done: number, total: number) => void
}
export interface PortableArchiveAsset { hash: string; path: string; size: number }
const hashPattern = /^[a-f0-9]{64}$/
const aborted = () => new Error('备份操作已取消')
function checkAbort(options: PortableArchiveOptions) { if (options.signal?.aborted) throw aborted() }
function validSize(value: number, limit: number) { return Number.isSafeInteger(value) && value >= 0 && value <= limit }

// File paths are constructed by the host; a ZIP entry name is never a disk path.
function pinnedDirectory(directory: string) {
  const canonical = assertUnlinkedPath(directory)
  const stat = fs.statSync(canonical, { bigint: true })
  if (!stat.isDirectory()) throw new Error('备份目录无效')
  const verify = () => {
    const current = assertUnlinkedPath(directory)
    const next = fs.statSync(current, { bigint: true })
    if (path.relative(current, canonical) !== '' || next.dev !== stat.dev || next.ino !== stat.ino || !next.isDirectory())
      throw new Error('备份目录已变化，请重试')
  }
  return { canonical, verify }
}
function removeOwned(file: string, identity: fs.BigIntStats, directory: ReturnType<typeof pinnedDirectory>) {
  try {
    directory.verify()
    const stat = fs.lstatSync(file, { bigint: true })
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) fs.unlinkSync(file)
  } catch { /* Preserve unknown/replaced paths; never clean up somebody else's file. */ }
}

/** Publish a complete ZIP atomically; failure leaves an existing destination intact. */
export async function writePortableArchive(destination: string, manifest: unknown, assets: PortableArchiveAsset[], options: PortableArchiveOptions = {}): Promise<void> {
  checkAbort(options)
  if (!Array.isArray(assets) || assets.length > PORTABLE_LIMITS.files) throw new Error('备份文件数量超过限制')
  const unique = new Set<string>()
  let totalBytes = 0
  for (const asset of assets) {
    if (!asset || !hashPattern.test(asset.hash) || unique.has(asset.hash) ||
      typeof asset.path !== 'string' || !validSize(asset.size, PORTABLE_LIMITS.assetBytes)) throw new Error('备份资源清单无效')
    unique.add(asset.hash)
    totalBytes += asset.size
    if (totalBytes > PORTABLE_LIMITS.totalAssetBytes) throw new Error('备份资源总大小超过限制')
  }
  const text = JSON.stringify(manifest)
  if (typeof text !== 'string' || Buffer.byteLength(text) > PORTABLE_LIMITS.manifestBytes) throw new Error('备份清单超过大小限制或无效')
  const directory = pinnedDirectory(path.dirname(destination))
  const target = path.join(directory.canonical, path.basename(destination))
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error('备份目标不是普通文件')
  const temporary = path.join(directory.canonical, `.portable-${randomUUID()}.tmp`)
  directory.verify()
  const fd = fs.openSync(temporary, 'wx', 0o600)
  const identity = fs.fstatSync(fd, { bigint: true })
  const zip = new yazl.ZipFile()
  const output = zip.outputStream as Readable
  let input: Readable | undefined
  let written = 0, done = 0, closed = false, published = false
  const fail = (error: Error) => { input?.destroy(error); output.destroy(error) }
  zip.on('error', fail)
  const onAbort = () => { zip.emit('error', aborted()) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    written += chunk.length
    callback(written > PORTABLE_LIMITS.archiveBytes ? new Error('备份包超过大小限制') : null, chunk)
  } })
  const stream = fs.createWriteStream(temporary, { fd, autoClose: false })
  // pipeline destroys the writable (and its fd) on failure even with autoClose:false.
  stream.once('close', () => { closed = true })
  const completed = pipeline(output, limit, stream)
  // Observe immediately: synchronous manifest/asset validation can fail before awaiting it.
  void completed.catch(() => {})
  try {
    zip.addBuffer(Buffer.from(text), 'manifest.json', { compress: true, mode: 0o100600 })
    done++
    options.onProgress?.(done, assets.length + 1)
    for (const asset of assets) {
      zip.addReadStreamLazy(`assets/${asset.hash}`, { size: asset.size, compress: true, mode: 0o100600 }, (callback) => {
        try {
          checkAbort(options)
          // At most one 32 MiB resource is materialized; yazl requests entries serially.
          const bytes = readBoundedFile(asset.path, PORTABLE_LIMITS.assetBytes)
          if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.hash)
            throw new Error('备份资源已变化或校验失败')
          checkAbort(options)
          input = Readable.from([bytes])
          input.on('error', (error) => zip.emit('error', error))
          input.once('end', () => {
            try { done++; options.onProgress?.(done, assets.length + 1) }
            catch (error) { zip.emit('error', error) }
          })
          callback(null, input)
        } catch (error) { callback(error, undefined as never) }
      })
    }
    zip.end()
    await completed
    checkAbort(options)
    fs.fsyncSync(fd)
    directory.verify()
    const current = fs.lstatSync(temporary, { bigint: true })
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== BigInt(written))
      throw new Error('备份临时文件已变化')
    fs.closeSync(fd); closed = true
    checkAbort(options)
    // rename replaces an existing file only after the full archive was synced.
    fs.renameSync(temporary, target)
    published = true
  } catch (error) {
    fail(error instanceof Error ? error : new Error('备份写入失败'))
    await completed.catch(() => {})
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (!closed) {
      try { fs.closeSync(fd) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error }
    }
    if (!published) removeOwned(temporary, identity, directory)
  }
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off('entry', entry); zip.off('end', end); zip.off('error', error) }
    const entry = (value: yauzl.Entry) => { cleanup(); resolve(value) }
    const end = () => { cleanup(); resolve(null) }
    const error = (cause: Error) => { cleanup(); reject(cause) }
    zip.once('entry', entry); zip.once('end', end); zip.once('error', error)
    zip.readEntry()
  })
}
function validateEntry(entry: yauzl.Entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & ~0x080e) !== 0 ||
    ![0, 8].includes(entry.compressionMethod) || (mode !== 0 && mode !== 0x8000) ||
    (entry.externalFileAttributes & 0x10) !== 0 ||
    !entry.fileNameRaw.equals(Buffer.from(entry.fileName, 'utf8')) ||
    !validSize(entry.compressedSize, PORTABLE_LIMITS.archiveBytes))
    throw new Error('备份包含加密、链接或不支持的 ZIP 条目')
  if (entry.fileName !== 'manifest.json' && !/^assets\/[a-f0-9]{64}$/.test(entry.fileName)) throw new Error('备份包含无效文件路径')
  const maximum = entry.fileName === 'manifest.json' ? PORTABLE_LIMITS.manifestBytes : PORTABLE_LIMITS.assetBytes
  if (!validSize(entry.uncompressedSize, maximum)) throw new Error('备份文件解压后超过大小限制')
}

/** Read sequentially with actual-byte limits; the caller owns the empty staging directory. */
export async function readPortableArchive(source: string, stagingDir: string, options: PortableArchiveOptions = {}): Promise<{ manifest: unknown; assets: Map<string, { path: string; size: number }> }> {
  checkAbort(options)
  const directory = pinnedDirectory(stagingDir)
  if (fs.readdirSync(directory.canonical).length !== 0) throw new Error('备份暂存目录必须为空')
  const file = openVerifiedFile(source, PORTABLE_LIMITS.archiveBytes)
  let zip: yauzl.ZipFile | undefined, input: Readable | undefined, zipError: Error | undefined
  const created: Array<{ path: string; identity: fs.BigIntStats; completed?: fs.BigIntStats }> = []
  let successful = false
  const onAbort = () => { const error = aborted(); input?.destroy(error); zip?.emit('error', error) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromFd(file.fd,
      { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, value) => error ? reject(error) : resolve(value)))
    zip.on('error', (error: Error) => { zipError = error; input?.destroy(error) })
    if (!validSize(zip.entryCount, PORTABLE_LIMITS.files + 1) || zip.entryCount === 0) throw new Error('备份文件数量超过限制或为空')
    const seen = new Set<string>(), assets = new Map<string, { path: string; size: number }>()
    let manifest: unknown, totalBytes = 0, done = 0
    for (;;) {
      checkAbort(options)
      if (zipError) throw zipError
      const entry = await nextEntry(zip)
      if (!entry) break
      validateEntry(entry)
      if (seen.has(entry.fileName) || seen.size >= PORTABLE_LIMITS.files + 1) throw new Error('备份包含重复条目或过多文件')
      seen.add(entry.fileName)
      const metadata = entry.fileName === 'manifest.json'
      if (!metadata && assets.size >= PORTABLE_LIMITS.files) throw new Error('备份资源数量超过限制')
      const header = await zip.readLocalFileHeaderPromise(entry)
      if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod ||
        header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) throw new Error('ZIP 文件头与清单不一致')
      input = await zip.openReadStreamPromise(entry)
      const chunks: Buffer[] = [], hash = createHash('sha256')
      let size = 0, checksum = 0, destination: number | undefined, assetPath = ''
      if (!metadata) {
        directory.verify()
        assetPath = path.join(directory.canonical, entry.fileName.slice('assets/'.length))
        destination = fs.openSync(assetPath, 'wx', 0o600)
        created.push({ path: assetPath, identity: fs.fstatSync(destination, { bigint: true }) })
      }
      try {
        for await (const value of input) {
          checkAbort(options)
          if (zipError) throw zipError
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          size += chunk.length
          if (size > (metadata ? PORTABLE_LIMITS.manifestBytes : PORTABLE_LIMITS.assetBytes)) throw new Error('备份实际解压大小超过限制')
          if (!metadata && (totalBytes += chunk.length) > PORTABLE_LIMITS.totalAssetBytes) throw new Error('备份资源实际总大小超过限制')
          checksum = crc32(chunk, checksum)
          if (metadata) chunks.push(chunk)
          else {
            hash.update(chunk)
            let offset = 0
            while (offset < chunk.length) {
              const written = fs.writeSync(destination!, chunk, offset, chunk.length - offset)
              if (!written) throw new Error('备份资源写入中断')
              offset += written
            }
          }
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('备份文件大小或 CRC 校验失败')
        if (metadata) {
          try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
          catch { throw new Error('备份清单不是有效 UTF-8 JSON') }
        } else {
          const key = entry.fileName.slice('assets/'.length)
          if (hash.digest('hex') !== key) throw new Error('备份资源 SHA-256 校验失败')
          fs.fsyncSync(destination!)
          created[created.length - 1].completed = fs.fstatSync(destination!, { bigint: true })
          assets.set(key, { path: assetPath, size })
        }
      } finally { input.destroy(); input = undefined; if (destination !== undefined) fs.closeSync(destination) }
      options.onProgress?.(++done, zip.entryCount)
    }
    if (!seen.has('manifest.json')) throw new Error('备份缺少 manifest.json')
    checkAbort(options)
    if (zipError) throw zipError
    file.verify()
    directory.verify()
    for (const item of created) {
      const canonical = assertUnlinkedPath(item.path), stat = fs.statSync(canonical, { bigint: true }), expected = item.completed
      if (!expected || path.relative(canonical, item.path) !== '' || stat.dev !== expected.dev || stat.ino !== expected.ino ||
        stat.size !== expected.size || stat.mtimeNs !== expected.mtimeNs || stat.ctimeNs !== expected.ctimeNs)
        throw new Error('暂存资源在校验后已变化，请重试')
    }
    successful = true
    return { manifest, assets }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    input?.destroy()
    let closeError: Error | undefined
    if (zip) await new Promise<void>((resolve) => {
      const cleanup = () => { zip!.off('close', close); zip!.off('error', error) }
      const close = () => { cleanup(); resolve() }
      const error = (cause: Error) => { closeError = cause; cleanup(); resolve() }
      zip!.once('close', close); zip!.once('error', error); zip!.close()
    })
    else file.close()
    if (!successful || closeError) for (const item of created) removeOwned(item.path, item.identity, directory)
    if (successful && closeError) throw closeError
  }
}
