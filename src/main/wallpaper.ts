import { nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { grokHome } from './paths'
import { loadDesktopState, patchPrefs } from './desktop-state'

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.jfif', '.jpe'])

function wallpaperDir(): string {
  return path.join(grokHome(), 'desktop')
}

export function removeWallpaperFiles(): void {
  const dir = wallpaperDir()
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('wallpaper.')) continue
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      /* ignore */
    }
  }
}

function mimeFor(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

export function encodeWallpaper(file: string): string {
  if (!fs.existsSync(file)) throw new Error('Image file is missing')
  const img = nativeImage.createFromPath(file)
  if (!img.isEmpty()) {
    const { width, height } = img.getSize()
    const max = 2560
    const scaled =
      width > max || height > max
        ? img.resize({
            width: Math.max(1, Math.round(width * (max / Math.max(width, height)))),
            height: Math.max(1, Math.round(height * (max / Math.max(width, height)))),
            quality: 'best'
          })
        : img
    return `data:image/jpeg;base64,${scaled.toJPEG(86).toString('base64')}`
  }
  const ext = path.extname(file).toLowerCase()
  const buf = fs.readFileSync(file)
  if (buf.length > 16 * 1024 * 1024) throw new Error('Image is larger than 16 MB')
  return `data:${mimeFor(ext)};base64,${buf.toString('base64')}`
}

export function wallpaperPayload(): { name: string; opacity: number; dataUrl: string } | null {
  const state = loadDesktopState()
  if (!state.wallpaperFile || !fs.existsSync(state.wallpaperFile)) return null
  try {
    return {
      name: state.wallpaperName || path.basename(state.wallpaperFile),
      opacity: state.wallpaperOpacity,
      dataUrl: encodeWallpaper(state.wallpaperFile)
    }
  } catch {
    return null
  }
}

export function installWallpaper(src: string): { name: string; opacity: number; dataUrl: string } {
  const ext = path.extname(src).toLowerCase()
  const recognized = EXTS.has(ext)
  if (!recognized && nativeImage.createFromPath(src).isEmpty()) {
    throw new Error('Unsupported image type')
  }
  const dir = wallpaperDir()
  fs.mkdirSync(dir, { recursive: true })
  removeWallpaperFiles()
  const destExt = ext === '.jfif' || ext === '.jpe' || !recognized ? '.jpg' : ext
  const dest = path.join(dir, `wallpaper${destExt}`)
  fs.copyFileSync(src, dest)
  const dataUrl = encodeWallpaper(dest)
  const next = patchPrefs({ wallpaperFile: dest, wallpaperName: path.basename(src) })
  return {
    name: next.wallpaperName || path.basename(src),
    opacity: next.wallpaperOpacity,
    dataUrl
  }
}
