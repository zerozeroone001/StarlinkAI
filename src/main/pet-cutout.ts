import { nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** Inspect actual decoded pixels; a .png filename alone does not prove alpha transparency. */
export function inspectPetAlpha(source: string) {
  if (!fs.existsSync(source) || fs.statSync(source).size > 40 * 1024 * 1024) throw new Error('PET_SUBJECT_INVALID: image missing or too large')
  const image = nativeImage.createFromBuffer(fs.readFileSync(source))
  if (image.isEmpty()) throw new Error('PET_SUBJECT_INVALID: image cannot be decoded')
  const { width, height } = image.getSize()
  if (width * height > 32_000_000) throw new Error('PET_SUBJECT_INVALID: image dimensions are too large')
  const bitmap = image.toBitmap({ scaleFactor: 1 })
  let clear = 0, solid = 0
  for (let i = 3; i < bitmap.length; i += 4) { if (bitmap[i] < 24) clear++; if (bitmap[i] > 32) solid++ }
  return { width, height, transparentFraction: clear / (width * height), solidFraction: solid / (width * height), nativeAlpha: clear / (width * height) >= .005 && solid / (width * height) >= .01 }
}

/** Native Electron bitmaps use premultiplied BGRA. Never despill an already-transparent subject. */
export function removeUniformBitmapBackground(bitmap: Buffer, width: number, height: number): boolean {
  const edges: number[] = []
  for (let x = 0; x < width; x++) edges.push(x, (height - 1) * width + x)
  for (let y = 1; y < height - 1; y++) edges.push(y * width, y * width + width - 1)
  // Real alpha is authoritative: changing the green channel here damaged skin, clothes and hair.
  if (edges.some((i) => bitmap[i * 4 + 3] < 245)) return false
  const mean = [0, 1, 2].map((c) => edges.reduce((sum, i) => sum + bitmap[i * 4 + c], 0) / edges.length)
  const distance = (i: number) => Math.hypot(...mean.map((v, c) => bitmap[i * 4 + c] - v))
  const uniform = edges.filter((i) => distance(i) < 24).length / edges.length >= .98
  const green = (i: number) => bitmap[i * 4 + 1] - Math.max(bitmap[i * 4], bitmap[i * 4 + 2])
  const magenta = (i: number) => Math.min(bitmap[i * 4], bitmap[i * 4 + 2]) - bitmap[i * 4 + 1]
  // Accept only a consistently chromatic border, never arbitrary scenery. This handles
  // shading in provider key backgrounds without treating brightness changes as body color.
  const family = !uniform && edges.filter(i => green(i) > 45).length / edges.length >= .98 ? green :
    !uniform && edges.filter(i => magenta(i) > 45).length / edges.length >= .98 ? magenta : null
  if (family) {
    let removed = 0
    for (let i = 0; i < width * height; i++) {
      const strength = family(i)
      if (strength <= 25) continue
      const factor = Math.max(0, Math.min(1, (70 - strength) / 45)), at = i * 4
      const alpha = bitmap[at + 3]
      for (let c = 0; c < 3; c++) bitmap[at + c] = Math.min(Math.round(alpha * factor), Math.max(0,
        Math.round(bitmap[at + c] - mean[c] * (1 - factor) * alpha / 255)))
      bitmap[at + 3] = Math.round(alpha * factor)
      removed++
    }
    return removed > 0
  }
  if (!uniform) return false
  const chroma = mean[1] > Math.max(mean[0], mean[2]) + 80 || Math.min(mean[0], mean[2]) > mean[1] + 80
  const high = chroma ? 110 : 70
  const marked = new Uint8Array(width * height)
  const queue: number[] = []
  const enqueue = (i: number) => {
    if (marked[i] || bitmap[i * 4 + 3] < 245 || distance(i) >= high) return
    marked[i] = 1
    queue.push(i)
  }
  if (chroma) {
    for (let i = 0; i < marked.length; i++) enqueue(i)
  } else {
    for (const i of edges) enqueue(i)
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % width
      if (x) enqueue(i - 1)
      if (x + 1 < width) enqueue(i + 1)
      if (i >= width) enqueue(i - width)
      if (i + width < marked.length) enqueue(i + width)
    }
  }
  for (const i of queue) {
    const offset = i * 4, alpha = bitmap[offset + 3]
    const factor = Math.max(0, Math.min(1, (distance(i) - 20) / (high - 20)))
    for (let c = 0; c < 3; c++) {
      // Subtract background in premultiplied space, never divide by alpha or globally suppress green.
      bitmap[offset + c] = Math.min(Math.round(alpha * factor), Math.max(0,
        Math.round(bitmap[offset + c] - mean[c] * (1 - factor) * alpha / 255)))
    }
    bitmap[offset + 3] = Math.round(alpha * factor)
  }
  return queue.length > 0
}

export function writeColorSafeCutout(source: string, destination: string): boolean {
  if (!fs.existsSync(source) || fs.statSync(source).size > 40 * 1024 * 1024) return false
  const image = nativeImage.createFromBuffer(fs.readFileSync(source))
  if (image.isEmpty()) return false
  const { width, height } = image.getSize()
  if (!width || !height || width * height > 16_777_216) return false
  const bitmap = image.toBitmap({ scaleFactor: 1 })
  const hasAlpha = bitmap.some((value, i) => i % 4 === 3 && value < 245)
  if (!hasAlpha && !removeUniformBitmapBackground(bitmap, width, height)) return false
  let transparent = 0, solid = 0
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] < 24) transparent++
    if (bitmap[i] > 32) solid++
  }
  if (transparent / (width * height) < 0.005 || solid / (width * height) < 0.01) return false
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  // Avoid a bitmap round-trip for valid RGBA input; preserve the tool's original color and alpha.
  const output = hasAlpha ? image.toPNG() : nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG()
  fs.writeFileSync(destination, output)
  return true
}
