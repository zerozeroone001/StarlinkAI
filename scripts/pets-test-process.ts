import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import { paintArticulatedFixture } from './pet-articulated-fixture'

/** All Grok invocations are replaced; these tests never connect to a media provider. */
export function spawn(_binary: string, args: string[], options: { cwd: string }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let killed = false
  child.kill = () => { killed = true; ctx.petTestKilled = (ctx.petTestKilled || 0) + 1; queueMicrotask(() => child.emit('close', null)) }
  const prompt = fs.readFileSync(path.join(options.cwd, 'request.txt'), 'utf8')
  const ctx = globalThis as unknown as { petTestJobs: unknown[]; petTestFixture: string; petTestExit?: number; petTestFailAt?: number; petTestInvalidPage?: boolean; petTestStaticPose?: boolean; petTestKeyBackground?: boolean; petTestBeforeSpawn?: (cwd: string) => void; petTestStream?: boolean; petTestArchive?: boolean; petTestHang?: boolean; petTestNoOutput?: boolean; petTestKilled?: number }
  ctx.petTestJobs.push({ prompt, args, cwd: options.cwd })
  ctx.petTestBeforeSpawn?.(options.cwd)
  const name = prompt.includes('ANIMATION SPRITE SHEET') ? 'pet-action-sheet.png' : 'pet-cutout.png'
  queueMicrotask(() => {
    if (killed) return
    if (ctx.petTestFailAt === ctx.petTestJobs.length) { child.emit('close', 1); return }
    if (ctx.petTestNoOutput) { if (!ctx.petTestHang) child.emit('close', 0); return }
    const sessionId = args[args.indexOf('--session-id') + 1]
    const imageDir = path.join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(path.resolve(options.cwd)), sessionId, 'images')
    if (ctx.petTestStream || ctx.petTestArchive) fs.mkdirSync(imageDir, { recursive: true })
    const directCount = Number(/Create exactly (1|2|4) separate desktop-pet CHARACTER CUTOUT/.exec(prompt)?.[1] || 0)
    for (let n = 1; n <= (directCount || 1); n++) {
      if (killed) break
      const output = ctx.petTestStream || ctx.petTestArchive ? path.join(imageDir, `${n}.png`) : path.join(options.cwd, directCount ? `pet-${n}.png` : name)
      if (prompt.includes('ANIMATION SPRITE SHEET') && !ctx.petTestInvalidPage) {
        const size = /each cell (\d+) × (\d+)px/.exec(prompt)!
        const layout = /Layout: (\d+) columns × (\d+) rows/.exec(prompt)!
        const columns = Number(layout[1]), rows = Number(layout[2])
        const cellW = Number(size[1]), cellH = Number(size[2]), width = columns * cellW, height = rows * cellH
        const bitmap = Buffer.alloc(width * height * 4)
        if (ctx.petTestKeyBackground) for (let i = 0; i < bitmap.length; i += 4) { bitmap[i + 1] = 255; bitmap[i + 3] = 255 }
        const phases = [...prompt.matchAll(/Cell (\d+): timeline frame \d+, phase (\d+\.\d+)/g)]
        phases.forEach((match, i) => {
          paintArticulatedFixture(bitmap, width, i % columns * cellW, Math.floor(i / columns) * cellH, cellW, cellH, ctx.petTestStaticPose ? 0 : Number(match[2]))
        })
        fs.writeFileSync(output, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG())
      } else if (ctx.petTestInvalidPage && prompt.includes('ANIMATION SPRITE SHEET')) fs.writeFileSync(output, Buffer.from('invalid-image-fixture'))
      else fs.copyFileSync(ctx.petTestFixture, output)
      if (ctx.petTestStream || ctx.petTestArchive) {
        const update = (value: unknown) => JSON.stringify({ method: 'session/update', params: { sessionId, update: value } }) + '\n'
        const lines = update({ sessionUpdate: 'tool_call', toolCallId: `image-${n}`, title: directCount ? 'image_gen' : 'image_edit' }) +
          update({ sessionUpdate: 'tool_call_update', toolCallId: `image-${n}`, status: 'completed', rawOutput: { type: directCount ? 'ImageGen' : 'ImageEdit', path: output } })
        if (ctx.petTestArchive) {
          fs.appendFileSync(path.join(imageDir, '..', 'updates.jsonl'), lines)
          child.stdout.emit('data', Buffer.from('{"type":"text","data":"Generated image"}\n'))
        } else {
          const bytes = Buffer.from(lines)
          // Pipe boundaries need not line up with JSON records or UTF-8 characters.
          for (let at = 0; at < bytes.length; at += 17) child.stdout.emit('data', bytes.subarray(at, at + 17))
        }
      }
    }
    if (!ctx.petTestHang && !killed) child.emit('close', ctx.petTestExit || 0)
  })
  return child
}
