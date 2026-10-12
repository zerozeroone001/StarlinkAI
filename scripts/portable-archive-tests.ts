import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { readPortableArchive, writePortableArchive } from '../src/main/portable-archive'
import { readBoundedFile } from '../src/main/file-boundary'
import { PORTABLE_LIMITS } from '../src/shared/portable-backup'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture(t: TestContext) {
  const parent = path.resolve('.tmp/portable-archive-tests')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'case-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert.ok(path.basename(root).startsWith('case-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const staging = path.join(root, 'stage'); fs.mkdirSync(staging)
  return { root, staging, archive: path.join(root, 'backup.zip') }
}
type RawEntry = { name: string; bytes: Buffer; compressed?: boolean; flags?: number; mode?: number; method?: number; declared?: number; checksum?: number; localName?: string }
// Independent ZIP fixture writer: can construct invalid names/header metadata which yazl correctly refuses.
function rawZip(entries: RawEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name)
    const data = entry.compressed ? deflateRawSync(entry.bytes) : entry.bytes
    const sum = entry.checksum ?? crc32(entry.bytes), size = entry.declared ?? entry.bytes.length
    const flags = entry.flags ?? 0x800, method = entry.method ?? (entry.compressed ? 8 : 0)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(sum, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(localName.length, 26)
    local.push(lh, localName, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(sum, 16)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42)
    central.push(ch, name); offset += lh.length + localName.length + data.length
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dir, end])
}
const manifest = (): RawEntry => ({ name: 'manifest.json', bytes: Buffer.from('{"synthetic":true}') })
function asset(bytes = Buffer.from('synthetic attachment')): RawEntry { return { name: `assets/${hash(bytes)}`, bytes } }
async function rejectArchive(t: TestContext, entries: RawEntry[], pattern?: RegExp) {
  const f = fixture(t)
  fs.writeFileSync(f.archive, rawZip(entries))
  const before = fs.readFileSync(f.archive)
  await assert.rejects(readPortableArchive(f.archive, f.staging), pattern)
  assert.deepEqual(fs.readdirSync(f.staging), [])
  assert.deepEqual(fs.readFileSync(f.archive), before)
}

test('ZIP round trip preserves exact assets, UTF-8 metadata, progress and a prior destination', async (t) => {
  const f = fixture(t), bytes = Buffer.from('中文\0literal attachment'), source = path.join(f.root, 'source.bin')
  fs.writeFileSync(source, bytes); fs.writeFileSync(f.archive, 'prior backup')
  const progress: number[][] = [], metadata = { format: 'fixture', nested: { text: '中文' } }
  await writePortableArchive(f.archive, metadata, [{ hash: hash(bytes), path: source, size: bytes.length }], { onProgress: (a, b) => progress.push([a, b]) })
  const result = await readPortableArchive(f.archive, f.staging)
  assert.deepEqual(result.manifest, metadata)
  assert.equal(result.assets.size, 1)
  assert.deepEqual(fs.readFileSync(result.assets.get(hash(bytes))!.path), bytes)
  assert.deepEqual(progress.at(-1), [2, 2])
  assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.endsWith('.tmp')), [])
})
test('independent stored and deflated standard ZIPs both work, including empty assets', async (t) => {
  for (const compressed of [false, true]) {
    const f = fixture(t), value = asset(Buffer.alloc(0)); value.compressed = compressed
    fs.writeFileSync(f.archive, rawZip([value, { ...manifest(), compressed }]))
    const result = await readPortableArchive(f.archive, f.staging)
    assert.equal(result.assets.get(hash(Buffer.alloc(0)))!.size, 0)
  }
})
test('ZIP names cannot traverse, use absolute/drive/ADS paths, aliases, directories or unknown entries', async (t) => {
  for (const name of ['../outside', '/absolute', 'C:/private', 'assets\\private', 'assets/file:stream', 'assets/', 'credentials.json', `assets/${'A'.repeat(64)}`, `assets/${'a'.repeat(64)}/more`])
    await rejectArchive(t, [manifest(), { ...asset(), name }])
})
test('duplicate manifest/assets, missing manifest and symlink/device entries are rejected', async (t) => {
  await rejectArchive(t, [manifest(), manifest()])
  await rejectArchive(t, [manifest(), asset(), asset()])
  await rejectArchive(t, [asset()])
  for (const mode of [0o120777, 0o040755, 0o020600]) await rejectArchive(t, [manifest(), { ...asset(), mode }])
})
test('encrypted, unsupported compression, unknown flags and inconsistent local headers fail closed', async (t) => {
  await rejectArchive(t, [manifest(), { ...asset(), flags: 0x801 }])
  await rejectArchive(t, [manifest(), { ...asset(), flags: 0x820 }])
  await rejectArchive(t, [manifest(), { ...asset(), method: 99 }])
  await rejectArchive(t, [manifest(), { ...asset(), localName: '../private' }])
})
test('asset hashes, CRC and manifest JSON/UTF-8 must all validate', async (t) => {
  await rejectArchive(t, [manifest(), { ...asset(), name: `assets/${'0'.repeat(64)}` }], /SHA/)
  await rejectArchive(t, [{ ...manifest(), checksum: 0 }], /CRC/)
  await rejectArchive(t, [{ ...manifest(), bytes: Buffer.from('{') }], /JSON/)
  await rejectArchive(t, [{ ...manifest(), bytes: Buffer.from([0x22, 0xff, 0x22]) }], /UTF-8/)
})
test('truncated archives and declared per-file/manifest/archive limits are enforced before extraction', async (t) => {
  await rejectArchive(t, [manifest(), { ...asset(), compressed: true, declared: PORTABLE_LIMITS.assetBytes + 1 }])
  await rejectArchive(t, [{ ...manifest(), compressed: true, declared: PORTABLE_LIMITS.manifestBytes + 1 }])
  const f = fixture(t)
  fs.writeFileSync(f.archive, rawZip([manifest()]).subarray(0, -4))
  await assert.rejects(readPortableArchive(f.archive, f.staging))
  const fd = fs.openSync(f.archive, 'w'); fs.ftruncateSync(fd, PORTABLE_LIMITS.archiveBytes + 1); fs.closeSync(fd)
  await assert.rejects(readPortableArchive(f.archive, f.staging), /大小/)
  assert.deepEqual(fs.readdirSync(f.staging), [])
})
test('a real 33 MiB DEFLATE bomb with a forged small size cannot exceed resource limits', async (t) => {
  const bytes = Buffer.alloc(PORTABLE_LIMITS.assetBytes + 1024 * 1024, 65)
  await rejectArchive(t, [manifest(), { ...asset(bytes), compressed: true, declared: 1 }])
})
test('actual aggregate bytes and entry count are limited independently from manifest claims', async (t) => {
  const original = PORTABLE_LIMITS.totalAssetBytes
  ;(PORTABLE_LIMITS as { totalAssetBytes: number }).totalAssetBytes = 32 * 1024
  try {
    await rejectArchive(t, [manifest(), asset(Buffer.alloc(20 * 1024, 1)), asset(Buffer.alloc(20 * 1024, 2))], /总大小/)
  } finally { (PORTABLE_LIMITS as { totalAssetBytes: number }).totalAssetBytes = original }
  await rejectArchive(t, Array.from({ length: PORTABLE_LIMITS.files + 2 }, manifest), /数量/)
})
test('read cancellation cleans only its own files and leaves the source unchanged', async (t) => {
  const f = fixture(t), controller = new AbortController(), bytes = rawZip([manifest(), asset(), asset(Buffer.from('other'))])
  fs.writeFileSync(f.archive, bytes)
  await assert.rejects(readPortableArchive(f.archive, f.staging, { signal: controller.signal, onProgress: (done) => { if (done === 2) controller.abort() } }), /取消/)
  assert.deepEqual(fs.readdirSync(f.staging), [])
  assert.deepEqual(fs.readFileSync(f.archive), bytes)
})
test('nonempty or linked staging directories are rejected without modifying existing content', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.archive, rawZip([manifest()]))
  const marker = path.join(f.staging, 'keep'); fs.writeFileSync(marker, 'keep')
  await assert.rejects(readPortableArchive(f.archive, f.staging), /为空/)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep')
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(f.staging, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readPortableArchive(f.archive, linked), /链接/)
})
test('failed hash, wrong size and cancelled writes preserve the existing backup and remove temp files', async (t) => {
  const f = fixture(t), source = path.join(f.root, 'asset'); fs.writeFileSync(source, 'synthetic')
  const bytes = fs.readFileSync(source), correct = { path: source, hash: hash(bytes), size: bytes.length }
  fs.writeFileSync(f.archive, 'previous')
  for (const value of [{ ...correct, hash: '0'.repeat(64) }, { ...correct, size: 0 }]) {
    await assert.rejects(writePortableArchive(f.archive, {}, [value]), /变化|校验/)
    assert.equal(fs.readFileSync(f.archive, 'utf8'), 'previous')
  }
  const controller = new AbortController()
  await assert.rejects(writePortableArchive(f.archive, {}, [correct], { signal: controller.signal, onProgress: () => controller.abort() }), /取消/)
  assert.equal(fs.readFileSync(f.archive, 'utf8'), 'previous')
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false)
})
test('publish failure preserves the existing file, and a later retry can succeed', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.archive, 'previous')
  const rename = fs.renameSync
  fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => { if (String(args[1]) === f.archive) throw new Error('synthetic publish failure'); return rename(...args) }) as typeof rename
  try { await assert.rejects(writePortableArchive(f.archive, {}, []), /publish failure/) } finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(f.archive, 'utf8'), 'previous')
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false)
  await writePortableArchive(f.archive, {}, [])
  assert.deepEqual((await readPortableArchive(f.archive, f.staging)).manifest, {})
})
test('sync failures cannot publish a partial archive or leave restored assets behind', async (t) => {
  const f = fixture(t), sync = fs.fsyncSync
  fs.writeFileSync(f.archive, 'previous')
  fs.fsyncSync = (() => { throw new Error('synthetic disk sync failure') }) as typeof sync
  try { await assert.rejects(writePortableArchive(f.archive, {}, []), /disk sync failure/) }
  finally { fs.fsyncSync = sync }
  assert.equal(fs.readFileSync(f.archive, 'utf8'), 'previous')
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false)
  fs.writeFileSync(f.archive, rawZip([manifest(), asset()]))
  fs.fsyncSync = (() => { throw new Error('synthetic disk sync failure') }) as typeof sync
  try { await assert.rejects(readPortableArchive(f.archive, f.staging), /disk sync failure/) }
  finally { fs.fsyncSync = sync }
  assert.deepEqual(fs.readdirSync(f.staging), [])
})
test('source/archive and staged assets changed during an operation are detected', async (t) => {
  const f = fixture(t), entry = asset()
  fs.writeFileSync(f.archive, rawZip([manifest(), entry]))
  await assert.rejects(readPortableArchive(f.archive, f.staging, { onProgress: (done) => {
    if (done === 2) fs.appendFileSync(f.archive, 'changed')
  } }), /变化/)
  assert.deepEqual(fs.readdirSync(f.staging), [])
  fs.writeFileSync(f.archive, rawZip([manifest(), entry]))
  await assert.rejects(readPortableArchive(f.archive, f.staging, { onProgress: (done) => {
    if (done === 2) fs.appendFileSync(path.join(f.staging, hash(entry.bytes)), 'changed')
  } }), /变化/)
  assert.deepEqual(fs.readdirSync(f.staging), [])
})
test('cancellation during inflation stops before writing all expanded bytes', async (t) => {
  const f = fixture(t), controller = new AbortController(), bytes = Buffer.alloc(1024 * 1024, 65)
  fs.writeFileSync(f.archive, rawZip([manifest(), { ...asset(bytes), compressed: true }]))
  const write = fs.writeSync; let written = 0
  fs.writeSync = ((...args: any[]) => {
    const result = (write as any)(...args); written += result; controller.abort(); return result
  }) as typeof write
  try { await assert.rejects(readPortableArchive(f.archive, f.staging, { signal: controller.signal }), /取消/) }
  finally { fs.writeSync = write }
  assert.ok(written > 0 && written < bytes.length)
  assert.deepEqual(fs.readdirSync(f.staging), [])
})

test('bounded file reads accept exact limits and reject oversize/invalid bounds', (t) => {
  const f = fixture(t), file = path.join(f.root, 'file'); fs.writeFileSync(file, 'abc')
  assert.equal(readBoundedFile(file, 3).toString(), 'abc')
  assert.throws(() => readBoundedFile(file, 2), /大小/)
  assert.throws(() => readBoundedFile(file, NaN), /大小/)
})
test('a junction replaced between path validation and open cannot return outside data', (t) => {
  const f = fixture(t), inside = path.join(f.root, 'inside'), outside = path.join(f.root, 'outside')
  fs.mkdirSync(inside); fs.mkdirSync(outside)
  const file = path.join(inside, 'file'); fs.writeFileSync(file, 'approved'); fs.writeFileSync(path.join(outside, 'file'), 'private')
  const open = fs.openSync; let swapped = false
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (!swapped && String(args[0]) === file) { swapped = true; fs.renameSync(inside, inside + '-old'); fs.symlinkSync(outside, inside, process.platform === 'win32' ? 'junction' : 'dir') }
    return open(...args)
  }) as typeof open
  try { assert.throws(() => readBoundedFile(file, 100), /链接|变化/) } finally { fs.openSync = open }
  assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'private')
})
test('in-place changes and same-name replacement during reads never return mixed or stale bytes', (t) => {
  for (const mutation of ['grow', 'truncate', 'replace']) {
    const f = fixture(t), file = path.join(f.root, 'file'); fs.writeFileSync(file, 'abcdef')
    const read = fs.readSync; let changed = false
    fs.readSync = ((...args: any[]) => {
      const count = (read as any)(...args)
      if (!changed) {
        changed = true
        if (mutation === 'grow') fs.appendFileSync(file, 'more')
        else if (mutation === 'truncate') fs.truncateSync(file, 1)
        else { fs.renameSync(file, file + '-old'); fs.writeFileSync(file, 'abcdef') }
      }
      return count
    }) as typeof read
    try { assert.throws(() => readBoundedFile(file, 100), /变化|截断/) } finally { fs.readSync = read }
  }
})
