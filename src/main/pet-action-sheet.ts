import { nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { PetAtlas, PetTransparency } from '../shared/types'
import { actionAtlasFor, actionDurationMs, parseActionAtlas, PET_ACTION_ATLAS } from '../shared/pet-animation'
import { removeUniformBitmapBackground } from './pet-cutout'

function fail(reason: string): never {
  throw new Error(`PET_SHEET_INVALID: ${reason}`)
}


function validateCell(bitmap: Buffer, width: number, height: number, index: number): void {
  let foreground = 0, transparent = 0, edgeForeground = 0, edges = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = bitmap[(y * width + x) * 4 + 3]
      if (alpha > 32) foreground++
      if (alpha < 24) transparent++
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
        edges++
        if (alpha > 32) edgeForeground++
      }
    }
  }
  const area = width * height
  if (foreground / area < 0.02) fail(`frame ${index + 1} is empty`)
  if (transparent / area < 0.12) fail(`frame ${index + 1} has no clear transparent background`)
  if (edgeForeground / edges > 0.02) fail(`frame ${index + 1} crosses its cell boundary`)
}

function poseSignature(bitmap: Buffer, width: number, height: number): Buffer {
  let left = width, right = 0, top = height, bottom = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (bitmap[(y * width + x) * 4 + 3] < 64) continue
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  // Align and normalize the subject, so shifting/scaling a still or changing its colors
  // cannot masquerade as articulation. Only alpha shape contributes to this signature.
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })
    .crop({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 })
    .resize({ width: 48, height: 64, quality: 'best' }).toBitmap({ scaleFactor: 1 })
}

function poseDifference(a: Buffer, b: Buffer): number {
  let delta = 0, union = 0
  for (let i = 3; i < a.length; i += 4) { delta += Math.abs(a[i] - b[i]); union += Math.max(a[i], b[i]) }
  return union ? delta / union : 0
}

/** Reject a copied contact pose when a new, widely-separated key pose was requested. */
export function assertPetKeyPoseChanged(current: string, previous: string): void {
  const signature = (file: string) => {
    const image = nativeImage.createFromBuffer(fs.readFileSync(file)), size = image.getSize()
    if (image.isEmpty()) fail('cannot decode key pose')
    return poseSignature(image.toBitmap({ scaleFactor: 1 }), size.width, size.height)
  }
  if (poseDifference(signature(current), signature(previous)) < .045) fail('PET_SHEET_STATIC: requested a new full-body key pose but received a copy of the previous pose')
}

function readSheet(source: string, atlas: PetAtlas, normalize: boolean, checkMotion = true): { png: Buffer; transparency: PetTransparency } {
  if (!fs.existsSync(source) || fs.statSync(source).size > 40 * 1024 * 1024) fail('image missing or too large')
  // Tool output paths can exceed Windows' native-image path limit.
  const image = nativeImage.createFromBuffer(fs.readFileSync(source))
  if (image.isEmpty()) fail('not a decodable image')
  const { width, height } = image.getSize()
  const targetWidth = atlas.columns * atlas.cellWidth
  const targetHeight = atlas.rows * atlas.cellHeight
  if (width * height > 32_000_000) fail('image dimensions are too large')
  if (normalize) {
    if (width < atlas.columns * 48 || height < atlas.rows * 48) {
      fail(`expected a ${atlas.columns}×${atlas.rows} sheet with full-size cells`)
    }
  } else if (width !== targetWidth || height !== targetHeight) {
    fail('image size does not match the saved atlas metadata')
  }
  const sheet = Buffer.alloc(targetWidth * targetHeight * 4)
  const distinct: Buffer[] = []
  let keyedCells = 0
  for (let frame = 0; frame < atlas.frames!; frame++) {
    const x = (frame % atlas.columns) * atlas.cellWidth
    const y = Math.floor(frame / atlas.columns) * atlas.cellHeight
    const inputX = Math.floor((frame % atlas.columns) * width / atlas.columns)
    const inputY = Math.floor(Math.floor(frame / atlas.columns) * height / atlas.rows)
    const inputW = Math.floor(((frame % atlas.columns) + 1) * width / atlas.columns) - inputX
    const inputH = Math.floor((Math.floor(frame / atlas.columns) + 1) * height / atlas.rows) - inputY
    let cell = image.crop({ x: inputX, y: inputY, width: inputW, height: inputH })
    const scale = Math.min(atlas.cellWidth / inputW, atlas.cellHeight / inputH)
    const fitW = Math.max(1, Math.round(inputW * scale)), fitH = Math.max(1, Math.round(inputH * scale))
    if (normalize) cell = cell.resize({ width: fitW, height: fitH, quality: 'best' })
    const input = cell.toBitmap({ scaleFactor: 1 })
    if (normalize && removeUniformBitmapBackground(input, fitW, fitH)) keyedCells++
    validateCell(input, fitW, fitH, frame)
    // Providers may return a standard square/portrait canvas. Fit cells without stretching anatomy.
    const bitmap = Buffer.alloc(atlas.cellWidth * atlas.cellHeight * 4)
    const padX = Math.floor((atlas.cellWidth - fitW) / 2), padY = Math.floor((atlas.cellHeight - fitH) / 2)
    for (let row = 0; row < fitH; row++) input.copy(bitmap, ((padY + row) * atlas.cellWidth + padX) * 4, row * fitW * 4, (row + 1) * fitW * 4)
    validateCell(bitmap, atlas.cellWidth, atlas.cellHeight, frame)
    if (checkMotion) {
      const signature = poseSignature(bitmap, atlas.cellWidth, atlas.cellHeight)
      if (!distinct.some(other => poseDifference(signature, other) < .045)) distinct.push(signature)
    }
    for (let row = 0; row < atlas.cellHeight; row++) {
      bitmap.copy(sheet, ((y + row) * targetWidth + x) * 4,
        row * atlas.cellWidth * 4, (row + 1) * atlas.cellWidth * 4)
    }
  }
  // Opposite-side contacts can legitimately share a silhouette in a side-view walk.
  // This catches static copies, not anatomy or gait quality (which need visual review).
  const minimumPoses = Math.min(atlas.frames!, Math.max(2, Math.min(8, Math.ceil(atlas.frames! / 4))))
  if (checkMotion && distinct.length < minimumPoses) fail('PET_SHEET_STATIC: too little whole-body pose variation; shifted, scaled or recolored stills are not an animation')
  return { png: nativeImage.createFromBitmap(sheet, { width: targetWidth, height: targetHeight, scaleFactor: 1 }).toPNG(),
    transparency: keyedCells === 0 ? 'native-alpha' : keyedCells === atlas.frames ? 'local-key' : 'mixed' }
}

export function preparePetActionSheet(source: string, destination: string, atlas: PetAtlas = { ...PET_ACTION_ATLAS }, checkMotion = true) {
  const result = readSheet(source, atlas, true, checkMotion)
  writePetArtifact(destination, result.png)
  return { atlas, durationMs: actionDurationMs(atlas), transparency: result.transparency }
}

export function writePetArtifact(destination: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(`${destination}.tmp`, content)
  fs.renameSync(`${destination}.tmp`, destination)
}

/** Small generation pages are persisted raw, then split into independently recoverable PNG frames. */
export function preparePetActionBatch(source: string, destination: string, atlas: PetAtlas, requireMotion = false): PetTransparency {
  const result = readSheet(source, atlas, true, requireMotion)
  writePetArtifact(destination, result.png)
  return result.transparency
}

export function splitPetActionSheet(source: string, atlas: PetAtlas): Buffer[] {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) fail('cannot decode saved frames')
  return Array.from({ length: atlas.frames! }, (_, index) => image.crop({
    x: index % atlas.columns * atlas.cellWidth,
    y: Math.floor(index / atlas.columns) * atlas.cellHeight,
    width: atlas.cellWidth, height: atlas.cellHeight
  }).toPNG())
}

export function assemblePetActionFrames(files: string[], destination: string, durationMs: number, cell = { cellWidth: 192, cellHeight: 256 }): PetAtlas {
  if (!files.length || files.length > 128) fail('invalid frame count')
  const atlas = { ...actionAtlasFor(files.length, durationMs), ...cell }
  const width = atlas.columns * atlas.cellWidth, height = atlas.rows * atlas.cellHeight
  if (width * height > 16_777_216) fail('atlas exceeds the pixel limit')
  const bitmap = Buffer.alloc(width * height * 4)
  files.forEach((file, index) => {
    const image = nativeImage.createFromPath(file)
    const size = image.getSize()
    if (size.width !== atlas.cellWidth || size.height !== atlas.cellHeight) fail('saved frame size mismatch')
    const frame = image.toBitmap({ scaleFactor: 1 })
    validateCell(frame, atlas.cellWidth, atlas.cellHeight, index)
    const x = index % atlas.columns * atlas.cellWidth, y = Math.floor(index / atlas.columns) * atlas.cellHeight
    for (let row = 0; row < atlas.cellHeight; row++) frame.copy(bitmap, ((y + row) * width + x) * 4, row * atlas.cellWidth * 4, (row + 1) * atlas.cellWidth * 4)
  })
  writePetArtifact(destination, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG())
  return atlas
}

export function validatePetActionSheet(source: string, value: unknown): PetAtlas {
  const atlas = parseActionAtlas(value)
  if (!atlas) fail('invalid atlas metadata')
  readSheet(source, atlas, false)
  return atlas
}
