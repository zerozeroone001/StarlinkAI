import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, isWorkspaceAttachment, type WorkspaceAttachment } from '../../shared/attachments'
import { assertUnlinkedPath, ensureDirectoryWithin, isPathWithin, openVerifiedFile } from '../file-boundary'

function inside(roots: string[], file: string) {
  const canonical = assertUnlinkedPath(file)
  if (!roots.some(root => isPathWithin(assertUnlinkedPath(root), canonical)))
    throw new Error('附件不在当前对话目录中')
  return canonical
}
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 2).toString() === 'BM') return 'image/bmp'
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon'
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return 'image/avif'
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, ''))) return 'image/svg+xml'
  return undefined
}
export async function uploadAttachment(cwd: string, input: { name: string; data: string }): Promise<WorkspaceAttachment> {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 ||
    /[\\/\x00-\x1f]/.test(input.name) || typeof input.data !== 'string' ||
    input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))
    throw new Error('附件无效，单个文件最多 8 MB')
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.toString('base64') !== input.data) throw new Error('附件编码无效')
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('单个文件最多 8 MB')
  const root = assertUnlinkedPath(cwd)
  const rootIdentity = fs.statSync(root, { bigint: true })
  const directory = ensureDirectoryWithin(cwd, 'attachments')
  assertUnlinkedPath(path.join(cwd, 'attachments'))
  inside([cwd], directory)
  const directoryIdentity = fs.statSync(directory, { bigint: true })
  const id = randomUUID()
  const mime = imageMime(bytes) || 'application/octet-stream'
  let safeName = input.name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '') || 'file'
  const imageExtensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/x-icon': '.ico', 'image/avif': '.avif', 'image/svg+xml': '.svg' }
  if (imageExtensions[mime] && !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'].includes(path.extname(safeName).toLowerCase())) safeName += imageExtensions[mime]
  const file = path.join(directory, `${id}-${safeName}`)
  const output = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const verify = (size: number) => {
      // Opening the descriptor may yield to a directory replacement. Verify
      // the original roots and descriptor before writing any attachment bytes.
      const currentRoot = assertUnlinkedPath(cwd), currentDirectory = assertUnlinkedPath(path.join(cwd, 'attachments'))
      const sameDirectory = (before: fs.BigIntStats, file: string) => {
        const after = fs.statSync(file, { bigint: true })
        return after.isDirectory() && before.dev === after.dev && before.ino === after.ino
      }
      if (path.relative(root, currentRoot) || path.relative(directory, currentDirectory) ||
        !sameDirectory(rootIdentity, currentRoot) || !sameDirectory(directoryIdentity, currentDirectory))
        throw new Error('附件目录已变化，请重试')
      const actual = fs.statSync(inside([root], file), { bigint: true }), opened = fs.fstatSync(output.fd, { bigint: true })
      if (!actual.isFile() || !opened.isFile() || actual.dev !== opened.dev || actual.ino !== opened.ino ||
        actual.nlink !== 1n || opened.nlink !== 1n || actual.size !== BigInt(size) || opened.size !== BigInt(size))
        throw new Error('附件路径已变化，请重试')
    }
    verify(0)
    await output.writeFile(bytes)
    await output.sync()
    verify(bytes.length)
  } finally { await output.close() }
  return { id, name: input.name, path: file, size: bytes.length, mime }
}
export function resolveAttachments(cwd: string, values: WorkspaceAttachment[] = [], assetRoot?: string) {
  if (!Array.isArray(values) || values.length > MAX_ATTACHMENTS || !values.every(isWorkspaceAttachment))
    throw new Error('附件列表无效，最多上传 5 个文件')
  return values.map((a) => {
    const file = inside(assetRoot ? [cwd, assetRoot] : [cwd], a.path)
    const source = openVerifiedFile(file, MAX_ATTACHMENT_BYTES)
    try {
      const header = Buffer.alloc(Math.min(source.size, 4096))
      const read = fs.readSync(source.fd, header, 0, header.length, 0)
      source.verify()
      return { ...a, path: file, size: source.size, mime: imageMime(header.subarray(0, read)) || 'application/octet-stream' }
    } finally { source.close() }
  })
}
