import fs from 'node:fs'
import path from 'node:path'

/** Both arguments must already be canonical when used as a filesystem boundary. */
export function isPathWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function realFileWithin(file: string, roots: string[]): string | null {
  try {
    const resolved = fs.realpathSync(file)
    if (!fs.statSync(resolved).isFile()) return null
    return roots.some(root => {
      try { return isPathWithin(fs.realpathSync(root), resolved) } catch { return false }
    }) ? resolved : null
  } catch { return null }
}

/** Validate each existing parent before creating the next component, including junctions. */
export function ensureDirectoryWithin(root: string, relative: string): string {
  const anchor = fs.realpathSync(root)
  const target = path.resolve(anchor, relative)
  if (!fs.statSync(anchor).isDirectory() || !isPathWithin(anchor, target))
    throw new Error('目录不在当前工作空间中')
  let current = anchor
  for (const part of path.relative(anchor, target).split(path.sep).filter(Boolean)) {
    const next = path.join(current, part)
    try { fs.mkdirSync(next) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    current = fs.realpathSync(next)
    if (!isPathWithin(anchor, current) || !fs.statSync(current).isDirectory())
      throw new Error('目录链接指向了当前工作空间之外')
  }
  return current
}

/** Reject links in every existing component, including Windows junctions. */
export function assertUnlinkedPath(file: string): string {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('文件路径包含链接，请使用原始文件')
  }
  return fs.realpathSync(absolute)
}

/** Create one component at a time without traversing an existing link. */
export function ensureUnlinkedDirectory(directory: string): string {
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    const before = fs.statSync(assertUnlinkedPath(current), { bigint: true })
    const next = path.join(current, part)
    try { fs.mkdirSync(next) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = fs.lstatSync(next), after = fs.statSync(assertUnlinkedPath(current), { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
      throw new Error('资源目录包含链接或已变化，请重试')
    current = next
  }
  return assertUnlinkedPath(current)
}

function unchanged(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.isFile()
}

/** A pinned descriptor; callers must verify after reading and close it exactly once. */
export function openVerifiedFile(file: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('文件大小限制无效')
  const canonical = assertUnlinkedPath(file)
  const before = fs.statSync(canonical, { bigint: true })
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('文件无法读取或超过大小限制')
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const verify = () => {
    const current = assertUnlinkedPath(file)
    if (path.relative(canonical, current) !== '' ||
      !unchanged(before, fs.fstatSync(fd, { bigint: true })) ||
      !unchanged(before, fs.statSync(current, { bigint: true })))
      throw new Error('读取期间文件或路径已变化，请重试')
  }
  try { verify() } catch (error) { fs.closeSync(fd); throw error }
  return { fd, size: Number(before.size), verify, close: () => fs.closeSync(fd) }
}

/** Bounded reads fail closed on replacement, link swaps, growth or truncation. */
export function readBoundedFile(file: string, maxBytes: number): Buffer {
  const source = openVerifiedFile(file, maxBytes)
  try {
    const buffer = Buffer.alloc(source.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = fs.readSync(source.fd, buffer, offset, buffer.length - offset, offset)
      if (!count) throw new Error('读取期间文件已截断，请重试')
      offset += count
    }
    source.verify()
    return buffer
  } finally { source.close() }
}
