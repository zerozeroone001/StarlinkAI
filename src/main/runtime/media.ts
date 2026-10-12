import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ChatImage } from '../../shared/types'
import { extractMediaFromContent } from '../../shared/media'
import { inspectFile, resolveMediaPath, resolveScopedMediaPath } from '../preview'
import { assertUnlinkedPath, ensureDirectoryWithin, isPathWithin, readBoundedFile, realFileWithin } from '../file-boundary'
import { imageMime } from './attachments'

const extensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/x-icon': 'ico'
}

function saveImage(cwd: string, bytes: Buffer): string | null {
  const mime = imageMime(bytes)
  if (!mime || !extensions[mime]) return null
  assertUnlinkedPath(cwd)
  const directory = ensureDirectoryWithin(cwd, 'images')
  assertUnlinkedPath(path.join(cwd, 'images'))
  const file = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${extensions[mime]}`)
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = realFileWithin(file, [cwd])
    if (!existing || !readBoundedFile(existing, 32 * 1024 * 1024).equals(bytes)) return null
  }
  return file
}
// Keep large binary output out of run polling and browser localStorage.
export function collectRunImages(content: unknown, cwd: string, sessionId?: string, assetRoot?: string | (() => string)): ChatImage[] {
  return extractMediaFromContent(content).map((image) => {
    try {
      if (image.dataUrl) {
        const match = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.dataUrl)
        if (!match || !extensions[match[1]] || match[2].length > 40 * 1024 * 1024) return null
        const bytes = Buffer.from(match[2], 'base64')
        if (!bytes.length) return null
        const file = saveImage(typeof assetRoot === 'function' ? assetRoot() : assetRoot || cwd, bytes)
        return file ? { path: file, alt: image.alt } : null
      }
      if (!image.path) return null
      if (/^https?:\/\//i.test(image.path)) return image
      const managed = typeof assetRoot === 'function' ? assetRoot() : assetRoot
      if (managed) assertUnlinkedPath(managed)
      const managedCandidate = managed && resolveMediaPath(image.path, managed, undefined, false)
      const resolved = resolveScopedMediaPath(image.path, cwd, sessionId) ||
        (managedCandidate && realFileWithin(managedCandidate, [managed!]))
      if (!resolved) return null
      assertUnlinkedPath(resolved)
      if (!isPathWithin(fs.realpathSync(cwd), resolved) && !(managed && isPathWithin(fs.realpathSync(managed), resolved))) {
        const target = saveImage(managed || cwd, readBoundedFile(resolved, 32 * 1024 * 1024))
        return target ? { ...image, path: target, sourcePath: image.path } : null
      }
      return { ...image, path: resolved, sourcePath: image.path }
    } catch {
      // A deleted file, unsafe link, or unavailable output folder must not fail the model reply.
      return null
    }
  }).filter((image): image is ChatImage => !!image)
}

export function previewWorkspaceImage(cwd: string | undefined, source: string, assetRoot?: string) {
  if (typeof source !== 'string' || source.length > 4096) throw new Error('图片路径无效')
  const roots = [cwd, assetRoot].filter((root): root is string => !!root).map(root => assertUnlinkedPath(root))
  if (!roots.length) throw new Error('图片文件不存在')
  const resolved = (cwd && resolveMediaPath(source, cwd, undefined, false)) ||
    (assetRoot && resolveMediaPath(source, assetRoot, undefined, false))
  if (!resolved) throw new Error('图片文件不存在')
  // No global/session search: only the source workspace and this scope's fixed assets.
  const canonical = assertUnlinkedPath(resolved)
  if (!roots.some(root => isPathWithin(root, canonical))) throw new Error('图片不在当前工作空间中')
  const preview = inspectFile(canonical)
  if (preview.kind !== 'image') throw new Error('此文件不是图片')
  return preview
}
