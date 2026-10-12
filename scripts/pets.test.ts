import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { PET_ACTION_ATLAS, actionDurationMs, parseActionAtlas, petSpriteCell, petSpriteSequence, PET_FRAME_COUNTS, actionAtlasFor, actionAnchorIndices, actionFrameNeighbors, actionInbetweenOrder, actionPreviewDurations, actionPreviewFrame } from '../src/shared/pet-animation'
import { DEFAULT_PET_ATLAS } from '../src/shared/types'
import { preparePetActionSheet, preparePetActionBatch, validatePetActionSheet, splitPetActionSheet, assertPetKeyPoseChanged } from '../src/main/pet-action-sheet'
import { writeColorSafeCutout, removeUniformBitmapBackground, inspectPetAlpha } from '../src/main/pet-cutout'
import { validatePetActionJobSave } from '../src/main/pet-action-jobs'
import { actionSheetPrompt, actionBatchPrompt, subjectExtractionPrompt, SUBJECT_POSE_VERSION } from '../src/main/pet-prompts'
import { isWalkingAction, walkingPoseBrief, writeWalkPoseGuide } from '../src/main/pet-action-motion'
import { paintArticulatedFixture } from './pet-articulated-fixture'
import { addPetAction, updatePetAction, updateCustomPet, createCustomPet, extractPetSubject, generatePetImages, generatePetActionSheet, listPets, loadPetVisual, playPetAction, petRendererSnapshot, removePetAction, petActionJobs, pausePetActionGeneration } from '../src/main/pets'
import { PetMediaStream, runGrokMediaJob } from '../src/main/pet-media-job'

const ctx = globalThis as unknown as {
  petTestJobs: Array<{ prompt: string; args: string[]; cwd: string }>
  petTestFixture: string; petTestExit?: number
  petTestFailAt?: number; petTestInvalidPage?: boolean; petTestStaticPose?: boolean; petTestKeyBackground?: boolean
  petTestBeforeSpawn?: (cwd: string) => void
  petTestStream?: boolean; petTestArchive?: boolean; petTestHang?: boolean; petTestNoOutput?: boolean; petTestKilled?: number
  petTestEvents: Array<{ channel: string; payload: any }>
}
ctx.petTestJobs = []
ctx.petTestEvents = []
const temp = process.env.PET_TEST_TEMP!
const a = PET_ACTION_ATLAS
const out = (name: string) => path.join(temp, name)
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let passed = 0
async function check(name: string, fn: () => unknown) { await fn(); passed++; console.log(`PASS ${name}`) }

function fixture(name: string, kind: 'alpha' | 'green' | 'magenta' | 'white' | 'duplicate' | 'translated' | 'scaled' | 'recolored' | 'empty' | 'clipped' | 'scene' = 'alpha') {
  const w = a.columns * a.cellWidth, h = a.rows * a.cellHeight
  const data = Buffer.alloc(w * h * 4)
  const pixel = (x: number, y: number, color: number[]) => { const at = (y * w + x) * 4; for (let c = 0; c < 4; c++) data[at + c] = color[c] }
  for (let frame = 0; frame < a.frames; frame++) {
    const cx = frame % a.columns * a.cellWidth, cy = Math.floor(frame / a.columns) * a.cellHeight
    for (let y = 0; y < a.cellHeight; y++) for (let x = 0; x < a.cellWidth; x++) {
      if (kind === 'green') pixel(cx + x, cy + y, [0, 255, 0, 255])
      if (kind === 'magenta') pixel(cx + x, cy + y, [255, 0, 255, 255])
      if (kind === 'white') pixel(cx + x, cy + y, [255, 255, 255, 255])
      if (kind === 'scene') pixel(cx + x, cy + y, [x % 255, y % 255, (x + y) % 255, 255])
    }
    if (kind === 'empty' && frame === 7) continue
    if (['duplicate', 'translated', 'scaled', 'recolored', 'clipped'].includes(kind)) {
      const left = kind === 'clipped' ? 0 : kind === 'translated' ? 35 + frame * 4 : 65
      const inset = kind === 'scaled' ? frame * 2 : 0
      for (let y = 42 + inset; y < 210 - inset; y++) for (let x = left; x < left + 50 - Math.round(inset / 3); x++) {
        pixel(cx + x, cy + y, [190, kind === 'recolored' ? 30 + frame * 10 : 80, 220, 255])
      }
    } else paintArticulatedFixture(data, w, cx, cy, a.cellWidth, a.cellHeight, frame / a.frames)
  }
  const file = out(name)
  fs.writeFileSync(file, nativeImage.createFromBitmap(data, { width: w, height: h, scaleFactor: 1 }).toPNG())
  return file
}

app.whenReady().then(async () => {
  await check('row-major playback crosses all four rows and wraps', () => {
    assert.deepEqual(petSpriteCell(a, 0), { column: 0, row: 0 })
    assert.deepEqual(petSpriteCell(a, 4), { column: 0, row: 1 })
    assert.deepEqual(petSpriteCell(a, 15), { column: 3, row: 3 })
    assert.deepEqual(petSpriteCell(a, 16), { column: 0, row: 0 })
    assert.equal(actionDurationMs(a), 2000)
    assert.equal(petSpriteSequence(a, 'failed').start, 0)
    assert.equal(petSpriteSequence(DEFAULT_PET_ATLAS, 'waving').frames, 4)
  })
  await check('untrusted atlas metadata is bounded', () => {
    for (const patch of [{ frames: 1 }, { frames: 17 }, { columns: 0 }, { rows: Infinity }, { frameDurationMs: -1 }, { cellWidth: 1e9 }, { frames: '16' }]) assert.equal(parseActionAtlas({ ...a, ...patch }), null)
  })
  await check('16/32/48/108 frame layouts retain duration and include loop-seam interpolation', () => {
    for (const n of PET_FRAME_COUNTS) {
      const atlas = actionAtlasFor(n)
      assert.ok(parseActionAtlas(atlas))
      assert.ok(Math.abs(actionDurationMs(atlas) - 2000) < 1e-8)
      const indices = actionAnchorIndices(16, n)
      assert.equal(new Set(indices).size, 16)
      assert.equal(indices[0], 0)
    }
    const indices = actionAnchorIndices(16, 48)
    assert.deepEqual(indices, Array.from({ length: 16 }, (_, i) => i * 3))
    assert.deepEqual(actionFrameNeighbors(47, indices, 48), { left: 45, right: 0, fraction: 2 / 3 })
  })
  await check('whole-cycle anchors and progressively finer inbetweens cover every target exactly once', () => {
    assert.deepEqual(actionAnchorIndices(4, 16), [0, 4, 8, 12])
    assert.deepEqual(actionInbetweenOrder([0, 4, 8, 12], 16), [2, 6, 10, 14, 1, 5, 9, 13, 3, 7, 11, 15])
    assert.deepEqual(actionInbetweenOrder([0, 27, 54, 81], 108).slice(0, 4), [13, 40, 67, 94])
    for (const total of PET_FRAME_COUNTS) {
      const anchors = actionAnchorIndices(4, total), order = actionInbetweenOrder(anchors, total)
      assert.equal(new Set([...anchors, ...order]).size, total)
      assert.equal(order.length, total - 4)
      assert.deepEqual([...anchors, ...order].sort((a, b) => a - b), Array.from({ length: total }, (_, i) => i))
    }
  })
  await check('partial previews hold missing slots on the full-duration timeline including the seam', () => {
    assert.deepEqual(actionPreviewDurations([0, 4, 8, 12], 16, 2000), [500, 500, 500, 500])
    assert.deepEqual(actionPreviewDurations([0, 2, 4, 8, 12], 16, 2000), [250, 250, 500, 500, 500])
    assert.deepEqual(actionPreviewDurations([4], 16, 2000), [2000])
    const durations = actionPreviewDurations([2, 6, 14], 16, 2000)
    assert.deepEqual(durations, [500, 1000, 500])
    assert.equal(actionPreviewFrame(0, durations), 0)
    assert.equal(actionPreviewFrame(500, durations), 1)
    assert.equal(actionPreviewFrame(1999, durations), 2)
    assert.equal(actionPreviewFrame(2000, durations), 0)
    assert.equal(actionPreviewFrame(-1, durations), 2)
    assert.equal(actionPreviewFrame(50, []), 0)
  })
  await check('walking plans coordinate the whole body, opposite limb roles and loop-seam continuity', () => {
    assert.ok(isWalkingAction('自然走动'))
    assert.ok(isWalkingAction('relaxed walking'))
    assert.equal(isWalkingAction('挥手，不要走路'), false)
    assert.equal(isWalkingAction('wave without walking'), false)
    assert.match(walkingPoseBrief(0), /LEFT CONTACT/)
    assert.match(walkingPoseBrief(.5), /RIGHT CONTACT/)
    assert.match(walkingPoseBrief(15 / 16), /RIGHT UP.*LEFT CONTACT/)
    const atlas = { ...a, columns: 2, rows: 2, frames: 4 }
    const plan = [0, 4, 8, 12].map(index => ({ index, phase: index / 16 }))
    const prompt = actionBatchPrompt('reference.png', '走路', plan, atlas, [], 2000, 'pose-guide.png')
    for (const pattern of [/WHOLE-BODY COORDINATION/, /center of mass/, /shoulder girdle counter-rotates/, /stabilizing the head/, /natural delay/, /WHOLE loop/, /BOTH pose-guide.png and reference.png/, /EDIT THE FIRST IMAGE/, /RIGHT CONTACT/, /LEFT PASSING/]) assert.match(prompt, pattern)
    const guide = out('pose-guide.png')
    writeWalkPoseGuide(guide, plan.map(frame => frame.phase), atlas)
    assert.deepEqual(nativeImage.createFromPath(guide).getSize(), { width: 384, height: 512 })
    assert.equal(nativeImage.createFromPath(guide).toBitmap()[3], 0, 'guides do not inject an opaque background')
    assert.ok(inspectPetAlpha(guide).nativeAlpha)
    const nonWalking = actionBatchPrompt('reference.png', '挥手', plan, atlas, [], 2000)
    assert.match(nonWalking, /WHOLE-BODY COORDINATION/)
    assert.doesNotMatch(nonWalking, /LEFT CONTACT|WALK CYCLE/)
  })
  const valid = fixture('valid.png')
  const prepared = out('prepared.png')
  await check('transparent 16-frame atlas normalizes and validates', () => {
    const result = preparePetActionSheet(valid, prepared)
    assert.deepEqual(result.atlas, a)
    assert.equal(result.transparency, 'native-alpha')
    assert.deepEqual(validatePetActionSheet(prepared, a), a)
    assert.deepEqual(nativeImage.createFromPath(prepared).getSize(), { width: 768, height: 1024 })
  })
  await check('standard square provider canvases are fitted per cell without stretching the subject', () => {
    const w = 400, h = 400, bitmap = Buffer.alloc(w * h * 4)
    for (let cell = 0; cell < 4; cell++) for (let y = 50; y < 150; y++) for (let x = 75; x < 125; x++) {
      const i = ((Math.floor(cell / 2) * 200 + y) * w + (cell % 2 * 200 + x)) * 4
      bitmap[i] = 120; bitmap[i + 1] = 150; bitmap[i + 2] = 200; bitmap[i + 3] = 255
    }
    const source = out('square-page.png'), output = out('fitted-page.png')
    fs.writeFileSync(source, nativeImage.createFromBitmap(bitmap, { width: w, height: h, scaleFactor: 1 }).toPNG())
    const atlas = { ...a, columns: 2, rows: 2, frames: 4 }
    preparePetActionBatch(source, output, atlas)
    const frame = nativeImage.createFromBuffer(splitPetActionSheet(output, atlas)[0]).toBitmap()
    let minX = 192, maxX = 0, minY = 256, maxY = 0
    for (let y = 0; y < 256; y++) for (let x = 0; x < 192; x++) if (frame[(y * 192 + x) * 4 + 3] > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    assert.ok(Math.abs((maxX - minX + 1) / (maxY - minY + 1) - .5) < .03)
  })
  for (const kind of ['green', 'magenta', 'white'] as const) await check(`${kind} backdrop is removed per cell`, () => {
    const input = fixture(`${kind}.png`, kind), output = out(`${kind}-cutout.png`)
    assert.equal(preparePetActionSheet(input, output).transparency, 'local-key')
    assert.equal(nativeImage.createFromPath(output).toBitmap()[3], 0)
    validatePetActionSheet(output, a)
  })
  for (const kind of ['duplicate', 'translated', 'scaled', 'recolored', 'empty', 'clipped', 'scene'] as const) await check(`${kind} sheet is rejected, not accepted as a static fallback`, () => {
    assert.throws(() => preparePetActionSheet(fixture(`${kind}.png`, kind), out(`${kind}-result.png`)), /PET_SHEET_INVALID/)
    assert.equal(fs.existsSync(out(`${kind}-result.png`)), false)
  })
  const portrait = out('standing.png')
  fs.writeFileSync(portrait, nativeImage.createFromPath(prepared).crop({ x: 0, y: 0, width: a.cellWidth, height: a.cellHeight }).toPNG())
  for (const count of [1, 2, 4] as const) await check(`direct generation captures ${count} native-alpha cutouts in one session without extraction`, async () => {
    ctx.petTestFixture = portrait; ctx.petTestStream = true; ctx.petTestHang = true
    const before = ctx.petTestJobs.length, killed = ctx.petTestKilled || 0
    const images = await generatePetImages('自然站立的人物', count)
    assert.equal(images.length, count)
    assert.equal(ctx.petTestJobs.length - before, 1)
    assert.equal(ctx.petTestKilled! - killed, 1, 'stop only after the final requested image')
    const call = ctx.petTestJobs.at(-1)!
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read_file,image_gen')
    assert.match(call.prompt, /SINGLE GENERATION PHASE/)
    assert.match(call.prompt, /Do not call image_edit/)
    for (const image of images) {
      assert.equal(image.transparency, 'native-alpha')
      assert.deepEqual(nativeImage.createFromPath(image.path).toBitmap(), nativeImage.createFromPath(portrait).toBitmap())
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(call.cwd, 'generation-info.json'), 'utf8'))
    assert.equal(manifest.results.length, count)
    ctx.petTestHang = false; ctx.petTestStream = false
  })
  await check('opaque JPG named PNG is measured and locally keyed, without a second AI call', async () => {
    const raw = out('opaque-jpg.png')
    const green = nativeImage.createFromPath(out('green.png')).crop({ x: 0, y: 0, width: a.cellWidth, height: a.cellHeight })
    fs.writeFileSync(raw, green.toJPEG(100))
    assert.equal(inspectPetAlpha(raw).nativeAlpha, false)
    ctx.petTestFixture = raw; ctx.petTestArchive = true
    const before = ctx.petTestJobs.length
    const [image] = await generatePetImages('直接透明目标', 1)
    assert.equal(ctx.petTestJobs.length - before, 1)
    assert.equal(image.transparency, 'local-key')
    assert.ok(inspectPetAlpha(image.path).nativeAlpha)
    ctx.petTestArchive = false
  })
  await check('unremovable backdrop fails immediately without a second extraction or false alpha label', async () => {
    ctx.petTestFixture = out('scene.png'); ctx.petTestStream = true; ctx.petTestHang = true
    const before = ctx.petTestJobs.length, killed = ctx.petTestKilled || 0
    await assert.rejects(() => generatePetImages('不合格背景', 1), /PET_SUBJECT_INVALID/)
    assert.equal(ctx.petTestJobs.length - before, 1)
    assert.equal(ctx.petTestKilled! - killed, 1)
    assert.equal(fs.existsSync(path.join(ctx.petTestJobs.at(-1)!.cwd, 'generation-info.json')), false)
    ctx.petTestStream = false; ctx.petTestHang = false
  })
  await check('direct generation with no media fails instead of starting an extraction phase', async () => {
    ctx.petTestNoOutput = true
    const before = ctx.petTestJobs.length
    await assert.rejects(() => generatePetImages('无返回', 2), /PET_SUBJECT_MISSING/)
    assert.equal(ctx.petTestJobs.length - before, 1)
    ctx.petTestNoOutput = false
  })
  await check('an atlas mixing native alpha and keyed cells records mixed transparency', () => {
    const width = a.columns * a.cellWidth, height = a.rows * a.cellHeight
    const bitmap = nativeImage.createFromPath(valid).toBitmap(), keyed = nativeImage.createFromPath(out('green.png')).toBitmap()
    for (let y = 0; y < a.cellHeight; y++) keyed.copy(bitmap, y * width * 4, y * width * 4, (y * width + a.cellWidth) * 4)
    const input = out('mixed-raw.png')
    fs.writeFileSync(input, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG())
    assert.equal(preparePetActionSheet(input, out('mixed-final.png')).transparency, 'mixed')
  })
  await check('transparent skin, green clothing and semi-transparent edges retain original color through repeated processing', () => {
    const width = 64, height = 64, bitmap = Buffer.alloc(width * height * 4)
    const colors = [[155, 178, 219, 255], [60, 180, 80, 255], [48, 94, 76, 128]]
    for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
      const color = colors[Math.floor((x - 8) / 16)], at = (y * width + x) * 4
      color.forEach((v, i) => { bitmap[at + i] = v })
    }
    const input = out('natural-colors.png')
    fs.writeFileSync(input, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG())
    const before = nativeImage.createFromPath(input).toBitmap()
    let current = input
    for (let i = 0; i < 5; i++) { const output = out(`color-pass-${i}.png`); assert.ok(writeColorSafeCutout(current, output)); current = output }
    assert.deepEqual(nativeImage.createFromPath(current).toBitmap(), before)
  })
  await check('uniform-key removal does not recolor opaque skin or a white dress', () => {
    const width = 80, height = 80, bitmap = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) { bitmap[i * 4 + 1] = 255; bitmap[i * 4 + 3] = 255 }
    for (let y = 12; y < 68; y++) for (let x = 20; x < 60; x++) {
      const color = y < 30 ? [155, 178, 219, 255] : [235, 240, 245, 255]
      color.forEach((v, i) => { bitmap[(y * width + x) * 4 + i] = v })
    }
    const before = Buffer.from(bitmap)
    assert.ok(removeUniformBitmapBackground(bitmap, width, height))
    for (let y = 12; y < 68; y++) for (let x = 20; x < 60; x++) {
      const i = (y * width + x) * 4
      assert.deepEqual(bitmap.subarray(i, i + 4), before.subarray(i, i + 4))
    }
    assert.equal(bitmap[3], 0)
  })
  await check('one portrait and mismatched metadata cannot be saved as an action atlas', () => {
    assert.throws(() => preparePetActionSheet(portrait, out('not-a-sheet.png')), /PET_SHEET_INVALID/)
    assert.throws(() => validatePetActionSheet(prepared, { ...a, cellWidth: 200 }), /PET_SHEET_INVALID/)
  })
  await check('shaded chroma backgrounds are removed without recoloring opaque skin or white clothing', () => {
    for (const family of ['green', 'magenta']) {
      const width = 80, height = 80, bitmap = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const brightness = 110 + Math.round(y * 1.5)
        const color = family === 'green' ? [25, brightness, 20, 255] : [brightness, 20, brightness + 5, 255]
        color.forEach((v, c) => { bitmap[(y * width + x) * 4 + c] = v })
      }
      for (let y = 12; y < 68; y++) for (let x = 20; x < 60; x++) {
        const color = y < 30 ? [155, 178, 219, 255] : [235, 240, 245, 255]
        color.forEach((v, c) => { bitmap[(y * width + x) * 4 + c] = v })
      }
      const before = Buffer.from(bitmap)
      assert.ok(removeUniformBitmapBackground(bitmap, width, height))
      for (let y = 12; y < 68; y++) for (let x = 20; x < 60; x++) {
        const i = (y * width + x) * 4
        assert.deepEqual(bitmap.subarray(i, i + 4), before.subarray(i, i + 4))
      }
      assert.equal(bitmap[3], 0)
      assert.equal(bitmap[bitmap.length - 1], 0)
    }
  })
  await check('prompts request articulated frames and a standing subject, with no video workflow', () => {
    const prompt = actionSheetPrompt('reference.png', '挥手')
    assert.match(prompt, /16 equal cells/)
    assert.match(prompt, /Never call video generation/)
    assert.match(prompt, /not sixteen duplicates/)
    const extraction = subjectExtractionPrompt('source.png', '穿西装的人物')
    assert.match(extraction, /STANDING/)
    assert.match(extraction, /explicitly requests another pose/)
    assert.match(extraction, /Inanimate objects/)
    assert.match(extraction, /BOTH ARMS HANG LOOSELY AT THE SIDES/)
    assert.match(extraction, /Unclasp the hands/)
    assert.match(extraction, /uncrossed, planted on the same baseline/)
  })
  const snap = createCustomPet({ name: '测试角色', imagePath: portrait })
  const pet = snap.pets.find(p => p.name === '测试角色')!
  ctx.petTestFixture = valid
  let generated: Awaited<ReturnType<typeof generatePetActionSheet>>
  await check('Grok image-only generation returns a validated atlas and uses the editor reference', async () => {
    const counts: number[] = []
    const before = ctx.petTestJobs.length
    ctx.petTestBeforeSpawn = (cwd) => {
      const job = JSON.parse(fs.readFileSync(path.join(cwd, '..', 'job.json'), 'utf8'))
      assert.equal(job.completed.length, ctx.petTestJobs.length - before - 1, 'previous frame is on disk before the next call')
    }
    generated = await generatePetActionSheet(pet.id, '挥手', portrait, { requestId: 'stream-test' }, (progress) => {
      counts.push(progress.completedFrames)
      assert.equal(progress.requestId, 'stream-test')
      if (progress.completedFrames) {
        assert.equal(progress.media!.durationMs, 2000)
        assert.equal(progress.media!.frameDurationsMs!.reduce((sum, duration) => sum + duration, 0), 2000)
        if (progress.completedFrames === 4) assert.deepEqual(progress.media!.frameIndices, [0, 4, 8, 12])
        assert.ok(fs.existsSync(progress.media!.path))
        const dir = path.dirname(progress.media!.path)
        assert.equal(fs.readdirSync(path.join(dir, 'frames')).filter(f => f.endsWith('.png')).length, progress.completedFrames)
      }
    })
    ctx.petTestBeforeSpawn = undefined
    assert.ok(counts.includes(1) && counts.includes(4) && counts.includes(15))
    assert.equal(generated.complete, true)
    assert.equal(generated.transparency, 'native-alpha')
    assert.equal(petActionJobs(pet.id).find(item => item.jobId === generated.jobId)!.media!.transparency, 'native-alpha')
    assert.equal(ctx.petTestJobs.length - before, 16)
    assert.deepEqual(generated.atlas, a)
    assert.equal(generated.durationMs, 2000)
    const job = ctx.petTestJobs.at(-1)!
    assert.deepEqual(nativeImage.createFromPath(path.join(ctx.petTestJobs[before].cwd, 'reference.png')).toBitmap(), nativeImage.createFromPath(portrait).toBitmap())
    assert.deepEqual(nativeImage.createFromPath(path.join(job.cwd, 'reference.png')).toBitmap(), nativeImage.createFromPath(path.join(path.dirname(job.cwd), 'frames', 'frame-000.png')).toBitmap())
    assert.match(job.prompt, /ANIMATION SPRITE SHEET/)
    assert.ok(job.args.includes('--disable-web-search'))
  })
  await check('walking key poses use independent guides and reject copied poses before spending the rest of the cycle', async () => {
    const before = ctx.petTestJobs.length
    ctx.petTestStaticPose = true
    await assert.rejects(() => generatePetActionSheet(pet.id, '走路重复姿势校验', portrait), /PET_SHEET_STATIC/)
    const job = petActionJobs(pet.id).find(j => j.prompt === '走路重复姿势校验')!
    assert.equal(job.completedFrames, 1)
    assert.equal(ctx.petTestJobs.length - before, 2, 'stop immediately on the copied passing pose')
    const first = path.join(path.dirname(job.media!.path), 'frames', 'frame-000.png'), originalHash = hash(first)
    ctx.petTestStaticPose = false
    const result = await generatePetActionSheet(pet.id, '', undefined, { resumeJobId: job.jobId })
    assert.equal(result.complete, true)
    assert.equal(hash(first), originalHash)
    const requests = ctx.petTestJobs.slice(before)
    assert.ok(requests.every(call => call.prompt.includes('ONE ANIMATION SPRITE SHEET FRAME')))
    for (const call of requests.slice(0, 3)) {
      assert.ok(fs.existsSync(path.join(call.cwd, 'pose-guide.png')))
      assert.doesNotMatch(call.prompt, /Also include continuity.png/)
      assert.match(call.prompt, /WHOLE-BODY COORDINATION/)
    }
    assert.ok(requests.some(call => call.prompt.includes('Also include continuity.png')))
  })
  let actionId: string
  await check('save, re-read and playback preserve sheet metadata and Chinese IDs', () => {
    const snap = addPetAction(pet.id, { name: '挥手', spritesheetPath: generated.path, atlas: generated.atlas, durationMs: 5000, prompt: '挥手', generationJobId: generated.jobId })
    const action = snap.pets.find(p => p.id === pet.id)!.actions![0]
    actionId = action.id
    assert.equal(action.id, '挥手')
    assert.equal(action.mediaType, 'sheet')
    assert.equal(action.durationMs, 2000)
    assert.ok(action.file!.startsWith('action-'))
    assert.deepEqual(listPets().find(p => p.id === pet.id)!.actions![0].atlas, a)
    assert.deepEqual(loadPetVisual(pet.id, action.file)!.atlas, a)
    assert.equal(loadPetVisual(pet.id, action.file)!.type, 'sheet')
    assert.equal(loadPetVisual(pet.id, 'missing.png'), null)
    playPetAction(action.id, pet.id)
    assert.equal(ctx.petTestEvents.filter(e => e.channel === 'pets:action').length, 0, 'first wake waits for renderer readiness')
    petRendererSnapshot()
    const event = ctx.petTestEvents.filter(e => e.channel === 'pets:action').at(-1)!.payload
    assert.equal(event.petId, pet.id)
    assert.equal(event.visual.type, 'sheet')
    assert.deepEqual(event.visual.atlas, a)
    assert.equal(event.durationMs, 2000)
  })
  await check('16→48 upgrade preserves original frames byte-for-byte, inserts between neighbors and retains action identity/history', async () => {
    const original = splitPetActionSheet(generated.path, generated.atlas!)
    const before = ctx.petTestJobs.length
    const upgraded = await generatePetActionSheet(pet.id, '挥手', undefined, { frameCount: 48, sourceActionId: actionId })
    assert.equal(upgraded.atlas!.frames, 48)
    assert.equal(upgraded.transparency, undefined, 'old saved anchors have no provider provenance')
    assert.ok(Math.abs(upgraded.durationMs! - 2000) < 1e-8)
    const frames = splitPetActionSheet(upgraded.path, upgraded.atlas!)
    original.forEach((frame, i) => assert.deepEqual(frames[i * 3], frame))
    assert.equal(ctx.petTestJobs.length - before, 32, 'only the 32 missing frames are generated')
    assert.match(ctx.petTestJobs.at(-1)!.prompt, /key-046.png to key-000.png/)
    assert.ok(ctx.petTestJobs.slice(before).some(call => /key-045.png to key-000.png/.test(call.prompt)))
    assert.throws(() => validatePetActionJobSave(path.join(process.env.GROK_HOME!, 'desktop', 'pet-generations'), pet.id, upgraded.jobId!, upgraded.path, actionId, portrait), /PET_ACTION_CHANGED/)
    const snap = addPetAction(pet.id, { name: '挥手', spritesheetPath: upgraded.path, atlas: upgraded.atlas, replaceActionId: actionId, generationJobId: upgraded.jobId })
    const updated = snap.pets.find(p => p.id === pet.id)!.actions![0]
    assert.equal(updated.id, actionId)
    assert.equal(updated.history?.length, 1)
    assert.equal(updated.history![0].atlas.frames, 16)
    assert.ok(loadPetVisual(pet.id, updated.history![0].file))
    await assert.rejects(() => generatePetActionSheet(pet.id, '挥手', undefined, { frameCount: 32, sourceActionId: actionId }), /PET_UPGRADE_FRAME_COUNT/)
  })
  await check('a failed page keeps earlier frames and resumes without regenerating completed pages', async () => {
    const before = ctx.petTestJobs.length
    ctx.petTestFailAt = before + 5
    ctx.petTestKeyBackground = true
    await assert.rejects(() => generatePetActionSheet(pet.id, '失败后继续', portrait))
    ctx.petTestFailAt = undefined
    const job = petActionJobs(pet.id).find(j => j.prompt === '失败后继续')!
    assert.equal(job.completedFrames, 4)
    assert.equal(job.state, 'failed')
    assert.equal(job.media!.transparency, 'local-key')
    const first = path.join(path.dirname(job.media!.path), 'frames', 'frame-000.png')
    const originalHash = hash(first), timestamp = fs.statSync(first).mtimeMs
    ctx.petTestKeyBackground = false
    const result = await generatePetActionSheet(pet.id, '', undefined, { resumeJobId: job.jobId })
    assert.equal(result.complete, true)
    assert.equal(result.transparency, 'mixed')
    assert.equal(petActionJobs(pet.id).find(item => item.jobId === job.jobId)!.media!.transparency, 'mixed')
    assert.equal(ctx.petTestJobs.length - before, 17)
    assert.equal(hash(first), originalHash)
    assert.equal(fs.statSync(first).mtimeMs, timestamp)
  })
  await check('pause retains each saved frame; resumed 32-frame generation finishes with unchanged duration', async () => {
    let jobId = ''
    await assert.rejects(() => generatePetActionSheet(pet.id, '暂停继续', portrait, { frameCount: 32 }, progress => {
      jobId = progress.jobId
      if (progress.state === 'running' && progress.completedFrames === 4) pausePetActionGeneration(pet.id, progress.jobId)
    }), /PET_JOB_PAUSED/)
    const paused = petActionJobs(pet.id).find(j => j.jobId === jobId)!
    assert.equal(paused.state, 'paused')
    assert.equal(paused.completedFrames, 4)
    assert.throws(() => validatePetActionJobSave(path.join(process.env.GROK_HOME!, 'desktop', 'pet-generations'), pet.id, jobId, paused.media!.path), /PET_JOB_INCOMPLETE/)
    await assert.rejects(() => generatePetActionSheet('another-pet', '', undefined, { resumeJobId: jobId }), /PET_JOB_INVALID/)
    const result = await generatePetActionSheet(pet.id, '', undefined, { resumeJobId: jobId })
    assert.equal(result.atlas!.frames, 32)
    assert.equal(result.durationMs, 2000)
  })
  await check('108-frame generation produces a bounded 12×9 atlas, not a slowed-down 16-frame clip', async () => {
    const result = await generatePetActionSheet(pet.id, '108帧挥手', portrait, { frameCount: 108 })
    assert.equal(result.atlas!.frames, 108)
    assert.equal(result.atlas!.columns, 12)
    assert.equal(result.atlas!.rows, 9)
    assert.ok(Math.abs(result.durationMs! - 2000) < 1e-8)
    validatePetActionSheet(result.path, result.atlas)
  })
  await check('invalid saved pages are retryable instead of poisoning resumed jobs', async () => {
    ctx.petTestInvalidPage = true
    ctx.petTestFixture = portrait
    await assert.rejects(() => generatePetActionSheet(pet.id, '无效页重试', portrait), /PET_SHEET_INVALID/)
    const job = petActionJobs(pet.id).find(j => j.prompt === '无效页重试')!
    assert.equal(job.completedFrames, 0)
    ctx.petTestInvalidPage = false
    const completed = await generatePetActionSheet(pet.id, '', undefined, { resumeJobId: job.jobId })
    assert.equal(completed.complete, true)
  })
  await check('old image and video actions remain loadable; no default actions are added', () => {
    const video = out('old.webm')
    fs.writeFileSync(video, Buffer.from('legacy-video-fixture'))
    addPetAction(pet.id, { name: 'old image', imagePath: portrait })
    const snap = addPetAction(pet.id, { name: 'old video', videoPath: video })
    const actions = snap.pets.find(p => p.id === pet.id)!.actions!
    assert.equal(actions.length, 3)
    assert.equal(loadPetVisual(pet.id, actions[1].file)!.type, 'portrait')
    assert.equal(loadPetVisual(pet.id, actions[2].file)!.type, 'video')
    removePetAction(pet.id, actionId)
    assert.equal(listPets().find(p => p.id === pet.id)!.actions!.length, 2)
  })
  await check('old extraction cache is ignored; standing results are cached by pose version and exact target', async () => {
    const old = path.join(process.env.GROK_HOME!, 'desktop/pet-generations/subjects-old-seated')
    fs.mkdirSync(old, { recursive: true })
    fs.copyFileSync(portrait, path.join(old, 'source.png'))
    fs.copyFileSync(portrait, path.join(old, 'pet-cutout.png'))
    fs.writeFileSync(path.join(old, 'request.txt'), 'old seated extraction')
    ctx.petTestFixture = portrait
    const before = ctx.petTestJobs.length
    await extractPetSubject(portrait)
    assert.equal(ctx.petTestJobs.length, before + 1)
    const job = ctx.petTestJobs.at(-1)!
    assert.match(job.prompt, /STANDING/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(job.cwd, 'subject-request.json'), 'utf8')).poseVersion, SUBJECT_POSE_VERSION)
    await extractPetSubject(portrait)
    assert.equal(ctx.petTestJobs.length, before + 1)
    await extractPetSubject(portrait, '保留坐姿')
    assert.equal(ctx.petTestJobs.length, before + 2)
    await extractPetSubject(portrait, '', { forceRegenerate: true })
    assert.equal(ctx.petTestJobs.length, before + 3, 'explicit re-extraction must bypass even the current pose cache')
  })
  await check('streamed image results are captured without waiting for a stuck CLI to copy the sheet', async () => {
    ctx.petTestStream = true
    ctx.petTestHang = true
    const killedBefore = ctx.petTestKilled || 0
    const result = await generatePetActionSheet(pet.id, '流式图集', portrait)
    assert.equal(result.complete, true)
    validatePetActionSheet(result.path, result.atlas)
    assert.equal(ctx.petTestKilled! - killedBefore, 16, 'each pose request stops as soon as the image is validated')
    const call = ctx.petTestJobs.at(-1)!
    assert.ok(call.args.includes('streaming-json'))
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read_file,image_edit,image_gen')
    assert.match(call.prompt, /ONE image_edit call/)
    assert.match(fs.readFileSync(path.join(call.cwd, 'media-job.log'), 'utf8'), /accepted image/)
    ctx.petTestFixture = portrait
    const cutout = await extractPetSubject(portrait, '放松双臂', { forceRegenerate: true })
    assert.ok(fs.existsSync(cutout.path))
    assert.equal(ctx.petTestKilled! - killedBefore, 17)
    ctx.petTestHang = false
    ctx.petTestStream = false
  })
  await check('only structured image results from the current job/session are captured, including split UTF-8 and content fallback', () => {
    const dir = out('stream-parser'), sessionId = 'parser-session'
    const imageDir = path.join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(dir), sessionId, 'images')
    fs.mkdirSync(imageDir, { recursive: true })
    const file = path.join(imageDir, '站姿.png')
    fs.copyFileSync(portrait, file)
    const accepted: string[] = []
    const parser = new PetMediaStream(dir, file => accepted.push(file), () => {})
    const send = (update: object, id = sessionId) => {
      const bytes = Buffer.from(JSON.stringify({ params: { sessionId: id, update } }) + '\n')
      for (const byte of bytes) parser.push(Buffer.from([byte]))
    }
    send({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'image_edit' })
    send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ path: file }) } })
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { path: file } })
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'in_progress', rawOutput: { type: 'ImageEdit', path: file } })
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', rawOutput: { type: 'ImageEdit', path: portrait } })
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', rawOutput: { type: 'ImageEdit', path: file } }, 'unrelated-session')
    assert.equal(accepted.length, 0)
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ path: file }) } }] })
    assert.deepEqual(accepted, [fs.realpathSync(file)])
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', rawOutput: { type: 'ImageEdit', path: file } })
    parser.end()
    assert.equal(accepted.length, 1, 'duplicate events are not accepted again')
    const raw = new PetMediaStream(dir, file => accepted.push(file), () => {})
    raw.push(Buffer.from('x'.repeat(2 * 1024 * 1024 + 1) + '\n'))
    raw.push(Buffer.from(JSON.stringify({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', rawOutput: { type: 'ImageEdit', path: file } } })))
    raw.end()
    assert.equal(accepted.length, 2, 'oversized lines do not corrupt later updates or the last unterminated record')
  })
  await check('flattened CLI stdout recovers typed image results from its assigned session journal', async () => {
    ctx.petTestArchive = true
    ctx.petTestHang = true
    const killedBefore = ctx.petTestKilled || 0
    const result = await generatePetActionSheet(pet.id, '会话日志捕获', portrait)
    assert.equal(result.complete, true)
    assert.equal(ctx.petTestKilled! - killedBefore, 16)
    // A process can exit before the next journal poll; its close handler must drain the journal.
    ctx.petTestHang = false
    ctx.petTestFixture = portrait
    const subject = await extractPetSubject(portrait, '日志恢复站姿', { forceRegenerate: true })
    assert.ok(fs.existsSync(subject.path))
    ctx.petTestArchive = false
  })
  await check('an invalid streamed image fails promptly instead of waiting for the agent timeout', async () => {
    ctx.petTestStream = true
    ctx.petTestHang = true
    ctx.petTestInvalidPage = true
    ctx.petTestFixture = portrait
    const killedBefore = ctx.petTestKilled || 0
    await assert.rejects(() => generatePetActionSheet(pet.id, '流式无效页', portrait), /PET_SHEET_INVALID/)
    assert.equal(ctx.petTestKilled! - killedBefore, 1)
    const draft = petActionJobs(pet.id).find(job => job.prompt === '流式无效页')!
    assert.equal(draft.completedFrames, 0)
    assert.equal(draft.state, 'failed')
    ctx.petTestInvalidPage = false
    ctx.petTestHang = false
    const completed = await generatePetActionSheet(pet.id, '', undefined, { resumeJobId: draft.jobId })
    assert.equal(completed.complete, true)
    ctx.petTestStream = false
  })
  await check('timeout and cancellation stop the media process and keep distinct error codes', async () => {
    ctx.petTestNoOutput = true
    ctx.petTestHang = true
    const dir = out('deadline-job')
    fs.mkdirSync(dir, { recursive: true })
    const killed = ctx.petTestKilled || 0
    await assert.rejects(() => runGrokMediaJob(dir, 'timeout fixture', { timeoutMs: 30 }), /PET_MEDIA_TIMEOUT/)
    const controller = new AbortController()
    const job = runGrokMediaJob(dir, 'cancel fixture', { timeoutMs: 1000, signal: controller.signal })
    controller.abort()
    await assert.rejects(() => job, /PET_JOB_PAUSED/)
    assert.equal(ctx.petTestKilled! - killed, 2)
    const before = ctx.petTestJobs.length
    await assert.rejects(() => runGrokMediaJob(dir, 'already cancelled', { signal: controller.signal }), /PET_JOB_PAUSED/)
    assert.equal(ctx.petTestJobs.length, before)
    ctx.petTestNoOutput = false
    ctx.petTestHang = false
  })
  await check('a partial CLI failure can recover a complete atlas but cannot recover a single still', async () => {
    ctx.petTestExit = 1
    ctx.petTestFixture = valid
    assert.deepEqual((await generatePetActionSheet(pet.id, '跳跃')).atlas, a)
    ctx.petTestFixture = portrait
    ctx.petTestInvalidPage = true
    await assert.rejects(() => generatePetActionSheet(pet.id, '跳跃'), /PET_SHEET_INVALID/)
  })
  ctx.petTestExit = 0; ctx.petTestInvalidPage = false; ctx.petTestFixture = portrait
  const managed = createCustomPet({ name: '动作管理测试', imagePath: portrait }).pets.find(item => item.name === '动作管理测试')!
  const managedDir = path.join(process.env.GROK_HOME!, 'pets', managed.id), manifest = path.join(managedDir, 'pet.json')
  const managedAction = addPetAction(managed.id, { name: '原动作', prompt: '原说明', spritesheetPath: prepared, atlas: a }).pets.find(item => item.id === managed.id)!.actions![0]
  const originalFile = path.join(managedDir, managedAction.file!), originalHash = hash(originalFile)
  await check('editing action metadata keeps the ID, media, history and default assignments without generation', () => {
    updateCustomPet(managed.id, { name: managed.name, defaultActions: { work: managedAction.id, rest: managedAction.id } })
    const before = ctx.petTestJobs.length
    const changed = updatePetAction(managed.id, managedAction.id, { name: '新动作名', prompt: '新动作说明' }).pets.find(item => item.id === managed.id)!
    assert.equal(changed.actions!.length, 1)
    assert.equal(changed.actions![0].id, managedAction.id)
    assert.equal(changed.actions![0].name, '新动作名')
    assert.equal(changed.actions![0].prompt, '新动作说明')
    assert.equal(changed.actions![0].file, managedAction.file)
    assert.equal(changed.defaultActions!.work, managedAction.id)
    assert.equal(hash(originalFile), originalHash)
    assert.equal(ctx.petTestJobs.length, before)
    assert.throws(() => updatePetAction(managed.id, managedAction.id, { name: ' ' }), /name required/)
    assert.throws(() => updatePetAction(managed.id, 'missing', { name: 'x' }), /PET_ACTION_MISSING/)
  })
  await check('editing regeneration resumes, replaces the same action at the same frame count and rejects stale or incomplete media', async () => {
    let jobId = ''
    const before = ctx.petTestJobs.length
    await assert.rejects(() => generatePetActionSheet(managed.id, '重新挥手', portrait, { replaceActionId: managedAction.id, frameCount: 16 }, progress => {
      jobId = progress.jobId
      assert.equal(progress.replaceActionId, managedAction.id)
      assert.equal(progress.sourceActionId, undefined)
      if (progress.state === 'running' && progress.completedFrames === 4) pausePetActionGeneration(managed.id, jobId)
    }), /PET_JOB_PAUSED/)
    const paused = petActionJobs(managed.id).find(job => job.jobId === jobId)!
    assert.equal(paused.replaceActionId, managedAction.id)
    assert.equal(hash(originalFile), originalHash)
    assert.throws(() => updatePetAction(managed.id, managedAction.id, { name: '未完成', spritesheetPath: prepared, atlas: a, generationJobId: jobId }), /PET_JOB_INCOMPLETE/)
    const result = await generatePetActionSheet(managed.id, '', undefined, { resumeJobId: jobId })
    assert.equal(ctx.petTestJobs.length - before, 16, 'regeneration does not reuse the previous action poses')
    const bytes = fs.readFileSync(originalFile)
    fs.appendFileSync(originalFile, 'changed')
    const draft = { name: '重新生成动作', prompt: '重新挥手', spritesheetPath: result.path, atlas: result.atlas, generationJobId: jobId }
    assert.throws(() => updatePetAction(managed.id, managedAction.id, draft), /PET_ACTION_CHANGED/)
    fs.writeFileSync(originalFile, bytes)
    const changed = updatePetAction(managed.id, managedAction.id, draft).pets.find(item => item.id === managed.id)!
    assert.equal(changed.actions!.length, 1)
    assert.equal(changed.actions![0].id, managedAction.id)
    assert.equal(changed.actions![0].atlas!.frames, 16)
    assert.notEqual(changed.actions![0].file, managedAction.file)
    assert.equal(changed.actions![0].history![0].file, managedAction.file)
    assert.equal(changed.defaultActions!.work, managedAction.id)
    assert.equal(hash(originalFile), originalHash)
    assert.ok(loadPetVisual(managed.id, changed.actions![0].file))
    assert.equal(petActionJobs(managed.id).some(job => job.jobId === jobId), false)
  })
  await check('deleting an action clears default assignments and its unshared generated files including history', () => {
    const current = listPets().find(item => item.id === managed.id)!.actions![0]
    const currentFile = path.join(managedDir, current.file!)
    const changed = removePetAction(managed.id, managedAction.id).pets.find(item => item.id === managed.id)!
    assert.equal(changed.actions!.length, 0)
    assert.deepEqual(changed.defaultActions, {})
    assert.equal(fs.existsSync(currentFile), false)
    assert.equal(fs.existsSync(originalFile), false)
    assert.ok(loadPetVisual(managed.id), 'portrait is untouched')
    assert.doesNotThrow(() => removePetAction(managed.id, managedAction.id))
  })
  await check('deletion retains shared/imported files and read-only actions cannot be edited or deleted', () => {
    const first = addPetAction(managed.id, { name: '共享', spritesheetPath: prepared, atlas: a }).pets.find(item => item.id === managed.id)!.actions![0]
    const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    raw.actions.push({ ...first, id: 'shared-owner', name: '共享引用' }, { id: 'external', name: '外部', file: path.relative(managedDir, portrait) }, { ...first, id: 'read-only', custom: false })
    fs.writeFileSync(manifest, JSON.stringify(raw))
    removePetAction(managed.id, first.id)
    assert.ok(fs.existsSync(path.join(managedDir, first.file!)))
    removePetAction(managed.id, 'external')
    assert.ok(fs.existsSync(portrait))
    assert.throws(() => updatePetAction(managed.id, 'read-only', { name: 'x' }), /PET_ACTION_READ_ONLY/)
    assert.throws(() => removePetAction(managed.id, 'read-only'), /PET_ACTION_READ_ONLY/)
  })
  if (process.env.PET_TEST_REAL_FRAME_DIR) await check('opt-in real provider duplicate is rejected by the key-pose guard', () => {
    const dir = process.env.PET_TEST_REAL_FRAME_DIR!
    assert.throws(() => assertPetKeyPoseChanged(path.join(dir, 'frame-004.png'), path.join(dir, 'frame-000.png')), /PET_SHEET_STATIC/)
  })
  console.log(`PASS ${passed} pet regression checks (mock Grok, real Electron image decoding)`)
  app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })
