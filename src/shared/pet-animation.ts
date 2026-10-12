import { DEFAULT_PET_ATLAS, PET_STATE_FRAMES, PET_STATE_ROWS, type PetAtlas, type PetMood, type PetFrameCount } from './types'

export const PET_FRAME_COUNTS: readonly PetFrameCount[] = [16, 32, 48, 108]

export function actionAtlasFor(frames: number, durationMs = 2000): PetAtlas {
  const columns = Math.min(frames, frames <= 16 ? 4 : frames <= 48 ? 8 : 12)
  return { columns, rows: Math.ceil(frames / columns), cellWidth: 192, cellHeight: 256, frames, frameDurationMs: durationMs / frames }
}

/** Preserve every source frame, distributing new slots across the complete loop (including its seam). */
export function actionAnchorIndices(sourceFrames: number, targetFrames: number): number[] {
  if (!Number.isSafeInteger(sourceFrames) || sourceFrames < 2 || !Number.isSafeInteger(targetFrames) || targetFrames < sourceFrames || targetFrames > 128) throw new Error('Invalid frame upgrade')
  return Array.from({ length: sourceFrames }, (_, i) => Math.round(i * targetFrames / sourceFrames))
}

export function actionFrameNeighbors(index: number, anchors: number[], total: number) {
  const left = [...anchors].reverse().find((n) => n < index) ?? anchors.at(-1)!
  const right = anchors.find((n) => n > index) ?? anchors[0]
  const span = (right - left + total) % total
  return { left, right, fraction: ((index - left + total) % total) / span }
}

/** Fill each part of the cycle at the same interpolation depth before adding finer poses. */
export function actionInbetweenOrder(anchors: number[], total: number): number[] {
  const sorted = [...anchors].sort((a, b) => a - b)
  let intervals = sorted.map((left, i) => [left, sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? total : 0)])
  const order: number[] = []
  while (intervals.length) {
    const before: number[][] = [], after: number[][] = []
    for (const [left, right] of intervals) {
      if (right - left < 2) continue
      const middle = Math.floor((left + right) / 2)
      order.push(middle % total)
      if (middle - left > 1) before.push([left, middle])
      if (right - middle > 1) after.push([middle, right])
    }
    intervals = [...before, ...after]
  }
  return order
}

export function actionPreviewDurations(indices: number[], total: number, durationMs: number): number[] {
  return indices.map((index, i) => ((indices[(i + 1) % indices.length] - index + total) % total || total) * durationMs / total)
}

export function actionPreviewFrame(elapsedMs: number, durations: number[]): number {
  const total = durations.reduce((sum, duration) => sum + duration, 0)
  if (!total) return 0
  let position = ((elapsedMs % total) + total) % total
  for (let i = 0; i < durations.length; i++) {
    if (position < durations[i]) return i
    position -= durations[i]
  }
  return 0
}

export const PET_ACTION_ATLAS: PetAtlas & { frames: number; frameDurationMs: number } = {
  columns: 4,
  rows: 4,
  cellWidth: 192,
  cellHeight: 256,
  frames: 16,
  frameDurationMs: 125
}

/** Validate persisted/IPC metadata; a single pose must never masquerade as an action sheet. */
export function parseActionAtlas(value: unknown): PetAtlas | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const keys = ['columns', 'rows', 'cellWidth', 'cellHeight', 'frames'] as const
  if (keys.some((key) => typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]))) return null
  const { columns, rows, cellWidth, cellHeight, frames, frameDurationMs } = raw as unknown as Required<PetAtlas>
  if (
    columns < 1 || rows < 1 || columns > 16 || rows > 16 ||
    cellWidth < 16 || cellHeight < 16 || cellWidth > 1024 || cellHeight > 1024 ||
    columns * cellWidth * rows * cellHeight > 16_777_216 ||
    frames < 2 || frames > columns * rows || frames > 128 ||
    typeof frameDurationMs !== 'number' || !Number.isFinite(frameDurationMs) || frameDurationMs < 8 || frameDurationMs > 1000
  ) return null
  return { columns, rows, cellWidth, cellHeight, frames, frameDurationMs }
}

export function petSpriteSequence(atlas: PetAtlas = DEFAULT_PET_ATLAS, mood: PetMood = 'idle') {
  const action = parseActionAtlas(atlas)
  if (action) return { start: 0, frames: action.frames!, frameDurationMs: action.frameDurationMs! }
  const state = atlas.states?.[mood]
  const row = Math.max(0, Math.min(atlas.rows - 1, state?.row ?? PET_STATE_ROWS[mood] ?? 0))
  const frames = Math.max(1, Math.min(atlas.columns, state?.frames ?? PET_STATE_FRAMES[mood] ?? 6))
  return { start: row * atlas.columns, frames, frameDurationMs: 130 }
}

export function petSpriteCell(atlas: PetAtlas, frame: number, mood: PetMood = 'idle') {
  const sequence = petSpriteSequence(atlas, mood)
  const offset = ((Math.floor(frame) % sequence.frames) + sequence.frames) % sequence.frames
  const index = sequence.start + offset
  return { column: index % atlas.columns, row: Math.floor(index / atlas.columns) }
}

export function actionDurationMs(atlas: PetAtlas): number {
  const parsed = parseActionAtlas(atlas)
  if (!parsed) throw new Error('Invalid action spritesheet metadata')
  return parsed.frames! * parsed.frameDurationMs!
}
