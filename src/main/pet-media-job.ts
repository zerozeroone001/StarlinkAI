import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { findGrokBinary, grokHome } from './paths'

export interface PetMediaJobOptions {
  maxTurns?: number
  /** Absolute deadline; activity cannot extend this limit. */
  timeoutMs?: number
  idleTimeoutMs?: number
  rules?: string
  disableWebSearch?: boolean
  completionKey?: () => string | null
  completionStableMs?: number
  /** Validate and persist a completed image-tool result before returning true. */
  acceptImage?: (file: string) => boolean
  /** Limit generation to the requested image operation; portrait creation cannot start a cleanup edit. */
  imageTools?: Array<'image_gen' | 'image_edit'>
  signal?: AbortSignal
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const MAX_LINE = 2 * 1024 * 1024

/** Consume native ACP NDJSON without treating chat text or reference reads as generated media. */
export class PetMediaStream {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private dropping = false
  private calls = new Set<string>()
  private seen = new Set<string>()
  constructor(private dir: string, private image: (file: string) => void, private activity: (summary: string) => void, private sessionId?: string) {}

  push(chunk: Buffer) {
    this.consume(this.decoder.write(chunk))
  }
  end() {
    this.consume(this.decoder.end() + '\n')
  }
  private consume(text: string) {
    for (const [i, part] of text.split('\n').entries()) {
      if (i) {
        if (!this.dropping && this.pending.trim()) this.line(this.pending)
        this.pending = ''
        this.dropping = false
      }
      if (this.dropping) continue
      if (this.pending.length + part.length > MAX_LINE) { this.pending = ''; this.dropping = true }
      else this.pending += part
    }
  }
  private line(line: string) {
    let record: any
    try { record = JSON.parse(line) } catch { return }
    const params = record?.params || record
    const update = params?.update || (params?.sessionUpdate ? params : null)
    // CLI streaming-json also emits flattened text/thought events without ACP wrappers.
    if (!update && /^(text|thought|tool_call|tool_result|retry_state)$/.test(record?.type)) this.activity(record.type)
    if (!update || typeof update.sessionUpdate !== 'string') return
    const name = update._meta?.['x.ai/tool']?.name || update.title
    if (update.sessionUpdate === 'tool_call' && /^(image_edit|image_gen)$/.test(name)) this.calls.add(update.toolCallId)
    // Do not store prompts, reasoning, inline image data or arbitrary tool output in diagnostics.
    this.activity(`${update.sessionUpdate}${update.toolCallId ? ` ${update.toolCallId}` : ''}${update.status ? ` ${update.status}` : ''}`)
    if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'completed') return
    let output = update.rawOutput
    if (!output) {
      for (const block of Array.isArray(update.content) ? update.content : []) {
        if (!block || typeof block !== 'object') continue
        const content = block.content || block
        if (content.type !== 'text') continue
        try { output = JSON.parse(content.text); if (output?.path) break } catch { /* Not a structured image result. */ }
      }
    }
    if (!this.calls.has(update.toolCallId) && !/^(ImageEdit|ImageGen)$/.test(output?.type)) return
    const file = output?.path
    const sessionId = params.sessionId
    if (typeof file !== 'string' || typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionId) || !IMAGE_EXTS.has(path.extname(file).toLowerCase())) return
    if (this.sessionId && sessionId !== this.sessionId) return
    // Only the image-tool output folder for this working directory/session is eligible.
    const imageDir = path.join(grokHome(), 'sessions', encodeURIComponent(path.resolve(this.dir)), sessionId, 'images')
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (!path.isAbsolute(file) || normalize(path.dirname(path.resolve(file))) !== normalize(path.resolve(imageDir))) return
    try {
      const real = fs.realpathSync(file), root = fs.realpathSync(imageDir)
      if (path.dirname(real) !== root) return
      const stat = fs.statSync(real)
      if (!stat.isFile() || !stat.size || stat.size > 40 * 1024 * 1024) return
      const key = `${real}:${stat.size}:${stat.mtimeMs}`
      if (this.seen.has(key)) return
      this.seen.add(key)
      this.image(real)
    } catch { /* A result may refer to a missing, incomplete or invalid image. */ }
  }
}

export async function runGrokMediaJob(dir: string, prompt: string, options: PetMediaJobOptions = {}): Promise<void> {
  const binary = findGrokBinary()
  if (!binary) throw new Error('Grok CLI not found')
  if (options.signal?.aborted) throw new Error('PET_JOB_PAUSED')
  const promptFile = path.join(dir, 'request.txt')
  fs.writeFileSync(promptFile, prompt, 'utf8')
  const sessionId = randomUUID()
  const updatesFile = path.join(grokHome(), 'sessions', encodeURIComponent(path.resolve(dir)), sessionId, 'updates.jsonl')
  fs.writeFileSync(path.join(dir, 'media-session.json'), JSON.stringify({ sessionId }, null, 2))
  await new Promise<void>((resolve, reject) => {
    const args = ['--prompt-file', promptFile, '--cwd', dir, '--max-turns', String(options.maxTurns ?? 28),
      '--no-plan', '--no-subagents', '--permission-mode', 'bypassPermissions', '--output-format', 'streaming-json', '--session-id', sessionId]
    if (options.disableWebSearch) args.push('--disable-web-search')
    if (options.rules) args.push('--rules', options.rules)
    if (options.acceptImage) {
      // The app saves image-tool outputs itself. No shell, video or manual copying is needed.
      args.push('--tools', ['read_file', ...(options.imageTools || ['image_edit', 'image_gen'])].join(','), '--reasoning-effort', 'medium')
    }
    const child = spawn(binary, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false, output = '', lastActivity = Date.now(), lastKey: string | null = null, stableSince = 0
    let imageError: unknown
    const started = Date.now()
    const logFile = path.join(dir, 'media-job.log')
    const log = (message: string) => {
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > 128 * 1024) fs.writeFileSync(logFile, '')
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
      } catch { /* Diagnostics must not discard a generated image. */ }
    }
    log('started')
    const stop = () => {
      if (child.exitCode != null) return
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
        killer.on('close', (code) => { if (code && child.exitCode === null) child.kill() })
      } else child.kill()
    }
    const finish = (error?: unknown, kill = false) => {
      if (settled) return
      settled = true
      clearInterval(monitor)
      clearTimeout(deadline)
      options.signal?.removeEventListener('abort', abort)
      log(error ? `failed: ${String(error).slice(-1500)}` : 'finished')
      if (kill) stop()
      if (error) reject(error)
      else resolve()
    }
    const accept = (file: string) => {
      if (settled || !options.acceptImage) return
      try {
        if (options.acceptImage(file)) { log(`accepted image: ${path.basename(file)}`); finish(undefined, true) }
      } catch (error) {
        imageError = error
        log(`image rejected: ${String(error).slice(-1000)}`)
        finish(error, true)
      }
    }
    const activity = (summary: string) => {
      lastActivity = Date.now()
      if (/^tool_call/.test(summary) || /^retry_state/.test(summary)) log(summary)
    }
    const stream = new PetMediaStream(dir, accept, activity, sessionId)
    const archive = new PetMediaStream(dir, accept, activity, sessionId)
    let archiveOffset = 0
    const readArchive = () => {
      if (settled || !fs.existsSync(updatesFile)) return
      // The CLI's persisted ACP stream contains typed image paths even on versions whose
      // stdout uses flattened events. Read only this explicitly assigned session, incrementally.
      let fd: number | undefined
      try {
        fd = fs.openSync(updatesFile, 'r')
        let remaining = Math.min(fs.fstatSync(fd).size - archiveOffset, 4 * 1024 * 1024)
        while (remaining > 0 && !settled) {
          const bytes = Buffer.alloc(Math.min(remaining, 64 * 1024))
          const count = fs.readSync(fd, bytes, 0, bytes.length, archiveOffset)
          if (!count) break
          archiveOffset += count
          remaining -= count
          archive.push(bytes.subarray(0, count))
        }
      } catch { /* The session journal may not exist yet or be between writes. */ }
      finally { if (fd !== undefined) fs.closeSync(fd) }
    }
    child.stdout.on('data', (chunk: Buffer) => { if (!settled) stream.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-6000) })
    const checkCompletion = () => {
      let key: string | null = null
      try { key = options.completionKey?.() || null } catch { /* May still be writing. */ }
      if (!key) { lastKey = null; stableSince = 0; return false }
      if (key !== lastKey) { lastKey = key; stableSince = Date.now(); return false }
      return Date.now() - stableSince >= (options.completionStableMs ?? 1500)
    }
    const timeout = () => {
      readArchive()
      if (settled) return
      if (checkCompletion()) finish(undefined, true)
      else finish(imageError || new Error('PET_MEDIA_TIMEOUT: StarlinkAI generation timed out'), true)
    }
    const monitor = setInterval(() => {
      if (settled) return
      readArchive()
      if (settled) return
      if (checkCompletion()) finish(undefined, true)
      else if (Date.now() - lastActivity >= (options.idleTimeoutMs ?? 8 * 60 * 1000)) timeout()
    }, 500)
    const deadline = setTimeout(timeout, options.timeoutMs ?? 15 * 60 * 1000)
    const abort = () => finish(new Error('PET_JOB_PAUSED'), true)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (settled) return
      readArchive()
      archive.end()
      stream.end()
      if (settled) return
      log(`process exit: ${code}; elapsedMs: ${Date.now() - started}`)
      if (code === 0) finish(imageError)
      else finish(imageError || new Error(output.trim() || `StarlinkAI generation exited with code ${code}`))
    })
  })
}
