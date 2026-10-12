import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { nativeImage } from 'electron'
import type { PetActionGenerationOptions, PetActionProgress, PetAtlas, PetFrameCount, PetGeneratedMedia, PetTransparency } from '../shared/types'
import { actionAnchorIndices, actionAtlasFor, actionDurationMs, actionFrameNeighbors, actionInbetweenOrder, actionPreviewDurations, PET_FRAME_COUNTS, parseActionAtlas } from '../shared/pet-animation'
import { actionBatchPrompt } from './pet-prompts'
import { ACTION_MOTION_VERSION, isWalkingAction, writeWalkPoseGuide } from './pet-action-motion'
import { assemblePetActionFrames, assertPetKeyPoseChanged, preparePetActionBatch, splitPetActionSheet, validatePetActionSheet, writePetArtifact } from './pet-action-sheet'
import type { PetMediaJobOptions } from './pet-media-job'
type Runner = (dir: string, prompt: string, options: PetMediaJobOptions) => Promise<void>
type Seed = { id: string; file: string; atlas: PetAtlas }
interface Batch { name: string; indices: number[]; atlas: PetAtlas; stage: 'keyframes' | 'inbetween' }
interface ActionJob {
  version: 1
  id: string
  petId: string
  prompt: string
  targetFrames: PetFrameCount
  sourceActionId?: string
  replaceActionId?: string
  sourceHash?: string
  sourceAtlas?: PetAtlas
  durationMs: number
  cell: { cellWidth: number; cellHeight: number }
  anchors: number[]
  completed: number[]
  state: PetActionProgress['state']
  pending?: Batch
  error?: string
  savedActionId?: string
  updatedAt: number
  motionVersion?: string
  frameTransparency?: Record<number, PetTransparency>
}

const active = new Map<string, AbortController>()
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const frameFile = (dir: string, index: number) => path.join(dir, 'frames', `frame-${String(index).padStart(3, '0')}.png`)
const media = (file: string): PetGeneratedMedia => ({ path: file, mime: 'image/png', dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` })

function jobDir(root: string, id: string): string {
  if (!/^actions-[a-z0-9-]+$/.test(id)) throw new Error('PET_JOB_INVALID')
  return path.join(root, id)
}
function persist(dir: string, job: ActionJob) {
  job.updatedAt = Date.now()
  writePetArtifact(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
}
function readJob(root: string, id: string, petId?: string): { dir: string; job: ActionJob } {
  const dir = jobDir(root, id)
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) as ActionJob
  if (job.version !== 1 || job.id !== id || (petId && job.petId !== petId) || !PET_FRAME_COUNTS.includes(job.targetFrames) ||
    !parseActionAtlas({ ...actionAtlasFor(job.targetFrames, job.durationMs), ...job.cell }) ||
    !Array.isArray(job.anchors) || !Array.isArray(job.completed) ||
    job.anchors.length < 2 || new Set(job.anchors).size !== job.anchors.length ||
    [...job.anchors, ...job.completed].some((i) => !Number.isSafeInteger(i) || i < 0 || i >= job.targetFrames) ||
    (job.sourceAtlas && (!parseActionAtlas(job.sourceAtlas) || job.sourceAtlas.frames !== job.anchors.length))) throw new Error('PET_JOB_INVALID')
  if (job.pending && (!/^page-[a-z0-9-]+$/.test(job.pending.name) ||
    !Array.isArray(job.pending.indices) || job.pending.indices.length < 1 || job.pending.indices.length > 4 ||
    job.pending.indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= job.targetFrames))) throw new Error('PET_JOB_INVALID')
  if (job.pending) job.pending.atlas = { columns: job.pending.indices.length === 1 ? 1 : 2, rows: job.pending.indices.length === 1 ? 1 : 2, ...job.cell, frames: job.pending.indices.length, frameDurationMs: job.durationMs / job.targetFrames }
  // A process crash may happen after a frame was saved but before its manifest was replaced.
  job.completed = Array.from({ length: job.targetFrames }, (_, i) => i).filter(i => fs.existsSync(frameFile(dir, i)))
  return { dir, job }
}
function snapshot(dir: string, job: ActionJob, requestId = '', rebuild = true): PetActionProgress {
  const indices = [...job.completed].sort((a, b) => a - b)
  const complete = job.state === 'complete' && indices.length === job.targetFrames
  const file = path.join(dir, complete ? 'action-spritesheet.png' : 'preview.png')
  let preview: PetGeneratedMedia | undefined
  if (indices.length) {
    const duration = job.durationMs
    const atlas = { ...actionAtlasFor(indices.length, duration), ...job.cell }
    const cachedAt = fs.existsSync(file) ? fs.statSync(file).mtimeMs : -1
    const indexFile = `${file}.frames`
    const indexKey = indices.join(',')
    if (rebuild || !fs.existsSync(indexFile) || fs.readFileSync(indexFile, 'utf8') !== indexKey || indices.some(i => fs.statSync(frameFile(dir, i)).mtimeMs > cachedAt)) {
      assemblePetActionFrames(indices.map(i => frameFile(dir, i)), file, duration, job.cell)
      writePetArtifact(indexFile, indexKey)
    }
    const backgrounds = indices.map(index => job.frameTransparency?.[index])
    const transparency = backgrounds.every(value => value === 'native-alpha' || value === 'local-key' || value === 'mixed')
      ? new Set(backgrounds).size === 1 ? backgrounds[0] : 'mixed' : undefined
    preview = { ...media(file), atlas, durationMs: duration, complete, jobId: job.id, frameIndices: indices, transparency,
      frameDurationsMs: actionPreviewDurations(indices, job.targetFrames, duration) }
  }
  return { requestId, jobId: job.id, petId: job.petId, prompt: job.prompt, sourceActionId: job.sourceActionId, replaceActionId: job.replaceActionId,
    targetFrames: job.targetFrames, completedFrames: indices.length, state: job.state, error: job.error, media: preview }
}

export function listPetActionJobs(root: string, petId: string): PetActionProgress[] {
  if (!fs.existsSync(root)) return []
  const jobs: Array<{ dir: string; job: ActionJob }> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('actions-')) continue
    try {
      const result = readJob(root, entry.name, petId)
      if (!result.job.savedActionId) jobs.push(result)
    } catch { /* Old image jobs and jobs belonging to another pet are not resumable here. */ }
  }
  return jobs.sort((a, b) => b.job.updatedAt - a.job.updatedAt).slice(0, 8).map(({ dir, job }) => {
    if (job.state === 'running' && !active.has(job.id)) job.state = 'paused'
    return snapshot(dir, job, '', false)
  })
}

export function pausePetActionJob(root: string, petId: string, id: string): void {
  readJob(root, id, petId)
  active.get(id)?.abort()
}

export function validatePetActionJobSave(root: string, petId: string, id: string, output: string, replaceId?: string, sourceFile?: string): void {
  const { dir, job } = readJob(root, id, petId)
  if (job.state !== 'complete' || job.completed.length !== job.targetFrames ||
    path.resolve(output) !== path.join(dir, 'action-spritesheet.png') || (job.replaceActionId || job.sourceActionId) !== replaceId) throw new Error('PET_JOB_INCOMPLETE')
  if (replaceId && job.sourceHash && (!sourceFile || !fs.existsSync(sourceFile) || digest(sourceFile) !== job.sourceHash)) throw new Error('PET_ACTION_CHANGED')
}

export function markPetActionJobSaved(root: string, petId: string, id: string, actionId: string): void {
  const { dir, job } = readJob(root, id, petId)
  job.savedActionId = actionId
  persist(dir, job)
}

export async function runPetActionGeneration(input: {
  root: string; petId: string; prompt: string; reference?: string | null; seed?: Seed; replacement?: { id: string; file?: string }; options: PetActionGenerationOptions
}, run: Runner, onProgress: (progress: PetActionProgress) => void = () => {}): Promise<PetGeneratedMedia> {
  const { root, petId, options } = input
  let dir: string, job: ActionJob
  if (options.resumeJobId) {
    ;({ dir, job } = readJob(root, options.resumeJobId, petId))
  } else {
    const frames = options.frameCount ?? 16
    if (!PET_FRAME_COUNTS.includes(frames)) throw new Error('PET_FRAME_COUNT_INVALID')
    const seed = input.seed
    if (seed && input.replacement) throw new Error('PET_JOB_INVALID')
    if (seed && frames <= seed.atlas.frames!) throw new Error('PET_UPGRADE_FRAME_COUNT')
    if (!input.prompt.trim()) throw new Error('prompt required')
    if (!input.reference || !fs.existsSync(input.reference)) throw new Error('pet portrait missing')
    const id = `actions-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    dir = jobDir(root, id)
    fs.mkdirSync(dir, { recursive: true })
    job = { version: 1, id, petId, prompt: input.prompt, targetFrames: frames, sourceActionId: seed?.id, replaceActionId: input.replacement?.id,
      sourceHash: seed ? digest(seed.file) : input.replacement?.file ? digest(input.replacement.file) : undefined, sourceAtlas: seed?.atlas, durationMs: seed ? actionDurationMs(seed.atlas) : 2000,
      cell: seed ? { cellWidth: seed.atlas.cellWidth, cellHeight: seed.atlas.cellHeight } : { cellWidth: 192, cellHeight: 256 },
      anchors: actionAnchorIndices(seed?.atlas.frames! || 4, frames), completed: [], state: 'running', updatedAt: Date.now(), motionVersion: ACTION_MOTION_VERSION }
    if (!parseActionAtlas({ ...actionAtlasFor(frames, job.durationMs), ...job.cell })) throw new Error('PET_SHEET_INVALID: upgrade dimensions or frame timing exceed limits')
    // Keep a local reference, without introducing another color-processing pass.
    writePetArtifact(path.join(dir, 'reference.png'), seed ? splitPetActionSheet(seed.file, seed.atlas)[0] : nativeImage.createFromPath(input.reference).toPNG())
    if (seed) {
      fs.copyFileSync(seed.file, path.join(dir, 'source-action.png'))
    }
    persist(dir, job)
  }
  if (active.has(job.id)) throw new Error('PET_JOB_BUSY')
  if (job.state === 'complete') return snapshot(dir, job, options.requestId).media!
  const controller = new AbortController()
  active.set(job.id, controller)
  const publish = () => {
    persist(dir, job)
    const progress = snapshot(dir, job, options.requestId)
    try { onProgress(progress) } catch { /* A closed renderer cannot discard durable work. */ }
    return progress
  }
  const saveFrame = (index: number, png: Buffer) => {
    if (job.completed.includes(index)) return
    writePetArtifact(frameFile(dir, index), png)
    job.completed.push(index)
    publish()
  }
  job.state = 'running'
  job.error = undefined
  try {
    publish()
    if (job.sourceAtlas) {
      splitPetActionSheet(path.join(dir, 'source-action.png'), job.sourceAtlas).forEach((png, i) => saveFrame(job.anchors[i], png))
    }
    let anchorsVerified = false
    while (job.completed.length < job.targetFrames) {
      if (controller.signal.aborted) throw new Error('PET_JOB_PAUSED')
      const missingAnchors = job.anchors.filter(i => !job.completed.includes(i))
      if (!missingAnchors.length && !anchorsVerified && !job.sourceAtlas && job.motionVersion === ACTION_MOTION_VERSION) {
        const keySheet = path.join(dir, 'keyframes.png')
        const keyAtlas = assemblePetActionFrames(job.anchors.map(index => frameFile(dir, index)), keySheet, job.durationMs, job.cell)
        validatePetActionSheet(keySheet, keyAtlas)
        anchorsVerified = true
      }
      const stage = missingAnchors.length ? 'keyframes' : 'inbetween'
      const needed = missingAnchors.length ? missingAnchors : actionInbetweenOrder(job.anchors, job.targetFrames).filter(i => !job.completed.includes(i))
      if (!job.pending || job.pending.indices.every(i => job.completed.includes(i))) {
        // One controlled pose per edit avoids the model copying one pose across a grid.
        // Older pending multi-cell pages remain resumable with their original layout.
        const indices = needed.slice(0, 1)
        job.pending = { name: `page-${String(job.completed.length).padStart(3, '0')}-${Date.now().toString(36)}`, indices,
          atlas: { columns: 1, rows: 1, ...job.cell, frames: indices.length, frameDurationMs: job.durationMs / job.targetFrames }, stage }
        persist(dir, job)
      }
      const batch = job.pending
      if (!/^page-[a-z0-9-]+$/.test(batch.name)) throw new Error('PET_JOB_INVALID')
      const batchDir = path.join(dir, batch.name)
      fs.mkdirSync(batchDir, { recursive: true })
      const reference = path.join(batchDir, 'reference.png')
      const firstKey = job.anchors[0]
      fs.copyFileSync(batch.stage === 'inbetween' && job.completed.includes(firstKey) ? frameFile(dir, firstKey) : path.join(dir, 'reference.png'), reference)
      const context = new Set<string>()
      const copyReference = (index: number) => {
        const filename = `key-${String(index).padStart(3, '0')}.png`
        fs.copyFileSync(frameFile(dir, index), path.join(batchDir, filename))
        context.add(filename)
        return filename
      }
      const framePlan = batch.indices.map(index => {
        if (batch.stage === 'inbetween') {
          const neighbors = [...job.completed].sort((a, b) => a - b)
          const { left, right, fraction } = actionFrameNeighbors(index, neighbors, job.targetFrames)
          return { index, phase: index / job.targetFrames, before: copyReference(left), after: copyReference(right), fraction }
        }
        return { index, phase: index / job.targetFrames }
      })
      // Establish different key poses before supplying generated frames as continuity
      // inputs, otherwise the editor tends to clone the first contact pose.
      const poseGuide = isWalkingAction(job.prompt) && !job.sourceAtlas ? 'pose-guide.png' : undefined
      if (poseGuide) writeWalkPoseGuide(path.join(batchDir, poseGuide), framePlan.map(frame => frame.phase), batch.atlas)
      const contextImage = context.size ? 'continuity.png' : undefined
      if (contextImage) assemblePetActionFrames([...context].map(file => path.join(batchDir, file)), path.join(batchDir, contextImage), job.durationMs, job.cell)
      const requireMotion = batch.indices.length > 1 && batch.stage === 'keyframes' && job.motionVersion === ACTION_MOTION_VERSION
      const prepared = path.join(batchDir, 'prepared.png')
      let preparedTransparency: PetTransparency | undefined
      const checkKeyChange = () => {
        if (!isWalkingAction(job.prompt) || batch.stage !== 'keyframes' || batch.indices.length !== 1 || !job.completed.length) return
        const previous = job.anchors.filter(index => job.completed.includes(index)).at(-1)
        if (previous !== undefined) assertPetKeyPoseChanged(prepared, frameFile(dir, previous))
      }
      const targets = ['pet-action-sheet.png', 'pet-action-sheet.webp'].map(name => path.join(batchDir, name))
      const prepare = () => {
        let invalid: unknown
        for (const target of targets) {
          if (!fs.existsSync(target)) continue
          try {
            preparedTransparency = preparePetActionBatch(target, prepared, batch.atlas, requireMotion)
            checkKeyChange()
            return true
          } catch (error) { invalid = error }
        }
        if (invalid) throw invalid
        return false
      }
      let ready = false
      try { ready = prepare() } catch { /* A failed/incomplete page can be regenerated on resume. */ }
      let jobError: unknown
      if (!ready) {
        const stamp = (file: string) => { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}` }
        const prior = new Map(targets.filter(file => fs.existsSync(file)).map(file => [file, stamp(file)]))
        let validatedKey: string | null = null
        try {
          await run(batchDir, actionBatchPrompt('reference.png', job.prompt, framePlan, batch.atlas, [...context], job.durationMs, poseGuide, contextImage), {
            maxTurns: 8, disableWebSearch: true, signal: controller.signal,
            acceptImage: (file) => {
              preparedTransparency = preparePetActionBatch(file, prepared, batch.atlas, requireMotion)
              checkKeyChange()
              // Keep the raw page too, so a crash before frame splitting is recoverable.
              writePetArtifact(targets[0], nativeImage.createFromBuffer(fs.readFileSync(file)).toPNG())
              return true
            },
            completionStableMs: 1500,
            completionKey: () => {
              for (const file of targets) {
                if (!fs.existsSync(file)) continue
                const current = stamp(file)
                if (current === prior.get(file)) continue
                const key = `${file}:${current}`
                if (key === validatedKey) return key
                try { preparedTransparency = preparePetActionBatch(file, prepared, batch.atlas, requireMotion); checkKeyChange(); validatedKey = key; return key }
                catch { /* Never stop a resumed job because an old or half-written invalid PNG exists. */ }
              }
              return null
            },
            rules: 'Use exactly ONE image_edit call for the entire requested sprite page, not one call per pose. The desktop app captures the returned image path and handles background removal, resizing, validation and saving. Do not inspect outputs or copy files. Never use video or modify references.'
          })
        } catch (error) { jobError = error }
        try { ready = prepare() } catch (error) { jobError = error }
      }
      if (ready) {
        if (preparedTransparency) {
          job.frameTransparency ||= {}
          batch.indices.forEach(index => { job.frameTransparency![index] = preparedTransparency! })
        }
        // Every accepted frame reaches disk and the renderer before the next provider call starts.
        splitPetActionSheet(prepared, batch.atlas).forEach((png, i) => saveFrame(batch.indices[i], png))
        job.pending = undefined
        persist(dir, job)
      } else {
        if (controller.signal.aborted) throw new Error('PET_JOB_PAUSED')
        throw jobError || new Error('PET_SHEET_MISSING')
      }
    }
    const output = path.join(dir, 'action-spritesheet.png')
    const atlas = assemblePetActionFrames(Array.from({ length: job.targetFrames }, (_, i) => frameFile(dir, i)), output, job.durationMs, job.cell)
    validatePetActionSheet(output, atlas)
    job.state = 'complete'
    return publish().media!
  } catch (error) {
    job.state = controller.signal.aborted ? 'paused' : 'failed'
    job.error = job.state === 'paused' ? undefined : (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-1000)
    publish()
    if (job.state === 'paused') throw new Error('PET_JOB_PAUSED')
    throw error
  } finally {
    active.delete(job.id)
  }
}
