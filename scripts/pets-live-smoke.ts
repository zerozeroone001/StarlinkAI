// Opt-in provider check; isolated output only, no changes to installed pets or action drafts.
import { app, nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { findGrokBinary, grokHome } from '../src/main/paths'
import fs from 'node:fs'
import path from 'node:path'
import { runGrokMediaJob, type PetMediaJobOptions } from '../src/main/pet-media-job'
import { subjectExtractionPrompt, actionBatchPrompt } from '../src/main/pet-prompts'
import { writeColorSafeCutout, inspectPetAlpha } from '../src/main/pet-cutout'
import { runPetPortraitGeneration } from '../src/main/pet-portraits'
import { preparePetActionBatch } from '../src/main/pet-action-sheet'
import { runPetActionGeneration, pausePetActionJob } from '../src/main/pet-action-jobs'
import { writeWalkPoseGuide } from '../src/main/pet-action-motion'

app.whenReady().then(async () => {
  const source = process.env.PET_SMOKE_SOURCE, output = process.env.PET_SMOKE_OUTPUT
  const resumeJobId = process.env.PET_SMOKE_RESUME_JOB
  if (!source || !output || !path.isAbsolute(output) || (!resumeJobId && fs.existsSync(output))) throw new Error('Set PET_SMOKE_SOURCE and a new absolute PET_SMOKE_OUTPUT directory; this test uses live image generation.')
  const cutoutDir = path.join(output, 'subject'), actionDir = path.join(output, 'page')
  fs.mkdirSync(cutoutDir, { recursive: true })
  fs.mkdirSync(actionDir, { recursive: true })
  const observed = new Set<string>()
  const runMedia = (dir: string, prompt: string, options: PetMediaJobOptions) => runGrokMediaJob(dir, prompt, {
    ...options,
    acceptImage: options.acceptImage ? file => {
      if (!observed.has(file)) {
        observed.add(file)
        const bytes = fs.readFileSync(file), format = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : bytes.subarray(1, 4).toString() === 'PNG' ? 'png' : 'other'
        const raw = path.join(dir, `provider-${observed.size}.${format === 'jpeg' ? 'jpg' : 'png'}`)
        fs.copyFileSync(file, raw)
        const record = { raw: path.relative(output, raw), format, ...inspectPetAlpha(file) }
        fs.appendFileSync(path.join(output, 'provider-alpha.jsonl'), JSON.stringify(record) + '\n')
        console.log(`LIVE raw alpha: ${JSON.stringify(record)}`)
      }
      return options.acceptImage!(file)
    } : undefined
  })
  if (process.env.PET_SMOKE_DIRECT_PORTRAIT === '1') {
    const results = await runPetPortraitGeneration(cutoutDir, '一位穿白色长裙的成年女性，写实风格，全身自然站立，双臂放松。', 1, runMedia)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results.map(result => ({ ...result, dataUrl: undefined })), null, 2))
    console.log(`LIVE direct character: ${results[0].transparency} ${results[0].path}`)
    app.exit(0); return
  }
  const reference = `source${path.extname(source)}`
  fs.copyFileSync(source, path.join(cutoutDir, reference))
  const cutout = path.join(cutoutDir, 'pet-cutout.png')
  if (resumeJobId) {
    if (!fs.existsSync(cutout)) throw new Error('Missing smoke reference')
  } else if (process.env.PET_SMOKE_REUSE_SUBJECT === '1') {
    if (!writeColorSafeCutout(source, cutout)) throw new Error('PET_SUBJECT_INVALID')
  } else await runMedia(cutoutDir, subjectExtractionPrompt(reference, ''), {
    maxTurns: 8, disableWebSearch: true,
    acceptImage(file) {
      if (!writeColorSafeCutout(file, cutout)) throw new Error('PET_SUBJECT_INVALID')
      return true
    }
  })
  if (!fs.existsSync(cutout)) throw new Error('PET_SUBJECT_MISSING')
  console.log(`LIVE subject ${process.env.PET_SMOKE_REUSE_SUBJECT === '1' ? 'reused locally (no AI extraction)' : 'captured'}: ${cutout}`)
  if (process.env.PET_SMOKE_VIDEO === '1') {
    const base = nativeImage.createFromBuffer(fs.readFileSync(cutout)), size = base.getSize(), bitmap = base.toBitmap()
    for (let i = 0; i < bitmap.length; i += 4) {
      const missing = 1 - bitmap[i + 3] / 255
      bitmap[i] = Math.min(255, Math.round(bitmap[i] + 255 * missing))
      bitmap[i + 2] = Math.min(255, Math.round(bitmap[i + 2] + 255 * missing))
      bitmap[i + 3] = 255
    }
    fs.writeFileSync(path.join(actionDir, 'reference.png'), nativeImage.createFromBitmap(bitmap, size).toPNG())
    const sessionId = randomUUID()
    fs.writeFileSync(path.join(actionDir, 'media-session.json'), JSON.stringify({ sessionId }))
    fs.writeFileSync(path.join(actionDir, 'request.txt'), 'Use exactly one image_to_video call with the local reference.png as image and duration 6. Create one continuous natural full-body walk in place facing screen-right, from the same fixed side camera. Her pelvis and torso shift weight, shoulders counter-rotate, arms counter-swing, head stays steady, and dress follows the body naturally. Show clear alternating steps with smooth acceleration. Keep the full character inside the frame at the same scale and fixed ground baseline. Repeat the same steady walking cycle about three times with no camera movement or direction change. Keep the background perfectly flat magenta, no floor or shadows. After the tool returns finish immediately. Do not generate images, read skills, install software, configure cloud storage, start servers, upload by hand, or copy files.')
    const child = spawn(findGrokBinary()!, ['--prompt-file', path.join(actionDir, 'request.txt'), '--cwd', actionDir, '--tools', 'image_to_video', '--max-turns', '2', '--no-plan', '--no-subagents', '--permission-mode', 'bypassPermissions', '--reasoning-effort', 'low', '--session-id', sessionId, '--output-format', 'streaming-json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => fs.appendFileSync(path.join(actionDir, 'stdout.log'), chunk))
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(actionDir, 'stderr.log'), chunk))
    const timer = setTimeout(() => { if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }, 8 * 60_000)
    const code = await new Promise(resolve => child.on('close', resolve))
    clearTimeout(timer)
    const videos = path.join(grokHome(), 'sessions', encodeURIComponent(path.resolve(actionDir)), sessionId, 'videos')
    console.log(`LIVE video tool exit ${code}; output folder ${videos}`)
    if (fs.existsSync(videos)) for (const file of fs.readdirSync(videos)) {
      fs.copyFileSync(path.join(videos, file), path.join(output, file))
      console.log(`LIVE video: ${path.join(output, file)}`)
    }
    app.exit(fs.existsSync(videos) ? 0 : 1)
    return
  }
  if (process.env.PET_SMOKE_FULL_ACTION === '1') {
    const started = Date.now()
    const result = await runPetActionGeneration({ root: path.join(output, 'jobs'), petId: 'isolated-motion-smoke',
      prompt: '自然走动，全身协调流畅，重心、骨盆、躯干、肩臂和头部相互配合，衣物自然跟随动作。', reference: cutout,
      options: { frameCount: 16, requestId: 'live-motion-smoke', resumeJobId }
    }, runMedia, progress => {
      console.log(`LIVE ${progress.state} ${progress.completedFrames}/${progress.targetFrames} elapsed ${Math.round((Date.now() - started) / 1000)}s ${progress.error || ''}`)
      fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify({ ...progress, media: progress.media ? { ...progress.media, dataUrl: undefined } : undefined }, null, 2))
      if (progress.state === 'running' && progress.completedFrames >= Number(process.env.PET_SMOKE_STOP_AFTER || 999)) pausePetActionJob(path.join(output, 'jobs'), 'isolated-motion-smoke', progress.jobId)
    }).catch(error => {
      if (String(error).includes('PET_JOB_PAUSED')) { console.log('LIVE paused for visual review; frames retained.'); return null }
      throw error
    })
    if (!result) { app.exit(0); return }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...result, dataUrl: undefined }, null, 2))
    console.log(`LIVE full action captured and validated: ${result.path}`)
    app.exit(0)
    return
  }
  fs.copyFileSync(cutout, path.join(actionDir, 'reference.png'))
  const phase = process.env.PET_SMOKE_FRAME_PHASE
  const atlas = { columns: phase ? 1 : 2, rows: phase ? 1 : 2, cellWidth: 192, cellHeight: 256, frames: phase ? 1 : 4, frameDurationMs: 125 }
  const sheet = path.join(actionDir, 'pet-action-sheet.png')
  const frames = phase ? [{ index: Math.round(Number(phase) * 16), phase: Number(phase) }] : [0, 4, 8, 12].map(index => ({ index, phase: index / 16 }))
  writeWalkPoseGuide(path.join(actionDir, 'pose-guide.png'), frames.map(f => f.phase), atlas)
  if (process.env.PET_SMOKE_GUIDE_ONLY === '1') { console.log(`POSE guide: ${actionDir}`); app.exit(0); return }
  await runMedia(actionDir, actionBatchPrompt('reference.png', '自然走动，全身协调流畅', frames, atlas, [], 2000, 'pose-guide.png'), {
    maxTurns: 8, disableWebSearch: true,
    acceptImage(file) { preparePetActionBatch(file, sheet, atlas, frames.length > 1); return true }
  })
  if (!fs.existsSync(sheet)) throw new Error('PET_SHEET_MISSING')
  console.log(`LIVE ${frames.length}-frame page captured and validated: ${sheet}`)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
