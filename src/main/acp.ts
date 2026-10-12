import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PermissionRequest, PromptAttachment } from '../shared/types'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

function autoApprovalOption(options: PermissionRequest['options']): string | null {
  const allowed = options.filter((option) => {
    const value = `${option.optionId} ${option.kind || ''} ${option.name}`.toLowerCase()
    if (/reject|deny|cancel|disallow/.test(value)) return false
    return /allow|approve|accept|proceed/.test(value)
  })
  const once = allowed.find((option) =>
    /once|this[-_\s]?time|this[-_\s]?run/.test(
      `${option.optionId} ${option.kind || ''} ${option.name}`.toLowerCase()
    )
  )
  return once?.optionId || allowed[0]?.optionId || null
}

export interface AcpUpdate {
  sessionId: string
  sessionUpdate: string
  [key: string]: unknown
}

export class GrokAcp extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private live = new Set<string>()
  private prompting = new Set<string>()
  private autoApproveSessions = new Set<string>()
  private sessionCwds = new Map<string, string>()
  sessionId: string | null = null
  connected = false

  constructor(
    private grokPath: string,
    private options: { model?: string; effort?: string } = {}
  ) {
    super()
  }

  start(): Promise<void> {
    if (this.proc) return Promise.resolve()
    const cmd = ['agent', '--no-leader']
    if (this.options.model) cmd.push('--model', this.options.model)
    if (this.options.effort) cmd.push('--reasoning-effort', this.options.effort)
    cmd.push('stdio')

    let stderr = ''
    const env: NodeJS.ProcessEnv = { ...process.env, GROK_HOME: path.join(os.homedir(), '.grok') }
    delete env.GROK_CONFIG
    delete env.GROK_CONFIG_PATH
    this.proc = spawn(this.grokPath, cmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      this.emit('log', text)
    })
    this.proc.on('exit', (code) => {
      this.connected = false
      this.live.clear()
      this.prompting.clear()
      this.autoApproveSessions.clear()
      this.sessionCwds.clear()
      const reason = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
      this.emit('exit', { code, reason })
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(reason || `Grok agent exited (${code ?? 'null'})`))
      }
      this.pending.clear()
      this.proc = null
    })

    return this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'StarlinkAI', version: '0.1.0' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false
      }
    }).then(async (result) => {
      const meta = (result as { _meta?: { defaultAuthMethodId?: string } })?._meta
      const methodId = meta?.defaultAuthMethodId || 'cached_token'
      await this.request('authenticate', { methodId }).catch(() => undefined)
      this.connected = true
      this.emit('ready')
    })
  }

  async newSession(cwd: string, meta: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: meta
    })) as { sessionId: string }
    this.live.add(result.sessionId)
    this.sessionCwds.set(result.sessionId, path.resolve(cwd))
    if (meta.yoloMode === true) this.autoApproveSessions.add(result.sessionId)
    this.sessionId = result.sessionId
    return result.sessionId
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    this.sessionCwds.set(sessionId, path.resolve(cwd))
    if (this.live.has(sessionId)) return sessionId
    const base = { sessionId, cwd, mcpServers: [] }
    try {
      await this.request('session/resume', base)
      this.live.add(sessionId)
      this.sessionId = sessionId
      return sessionId
    } catch {
      try {
        await this.request('session/load', base)
        this.live.add(sessionId)
        this.sessionId = sessionId
        return sessionId
      } catch {
        return this.newSession(cwd)
      }
    }
  }

  prompt(
    text: string,
    sessionId: string,
    attachments: PromptAttachment[] = [],
    autoApprove?: boolean
  ): Promise<unknown> {
    if (!sessionId) return Promise.reject(new Error('No session'))
    if (this.prompting.has(sessionId)) {
      return Promise.reject(new Error('This session is already running a task'))
    }
    if (autoApprove === true) this.autoApproveSessions.add(sessionId)
    else if (autoApprove === false) this.autoApproveSessions.delete(sessionId)
    this.prompting.add(sessionId)
    const prompt: Record<string, unknown>[] = []
    const names = attachments.map((a) => a.name).filter(Boolean)
    let body = text.trim()
    if (names.length) {
      const label = `Attached: ${names.join(', ')}`
      body = body ? `${body}\n\n${label}` : label
    }
    if (body) prompt.push({ type: 'text', text: body })
    for (const a of attachments) {
      const dataUrl = a.dataUrl || ''
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
      if (match) {
        prompt.push({ type: 'image', mimeType: match[1], data: match[2] })
        continue
      }
      if (a.path) {
        prompt.push({
          type: 'resource',
          resource: {
            uri: pathToFileURL(a.path).href,
            mimeType: a.mime || 'application/octet-stream',
            name: a.name
          }
        })
      }
    }
    if (!prompt.length) prompt.push({ type: 'text', text: text || ' ' })
    // A coding turn can legitimately run longer than ten minutes or wait for an
    // approval. The process exit and explicit cancellation paths terminate it.
    return this.request('session/prompt', { sessionId, prompt }, null).finally(() => {
      this.prompting.delete(sessionId)
    })
  }

  cancel(sessionId?: string | null): void {
    if (!sessionId) return
    this.notify('session/cancel', { sessionId })
  }

  async setMode(modeId: string, sessionId?: string | null): Promise<void> {
    if (!sessionId) return
    await this.request('session/set_mode', { sessionId, modeId }).catch(() => undefined)
  }

  respondPermission(id: number | string, optionId: string): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        outcome: { outcome: 'selected', optionId }
      }
    })
  }

  denyPermission(id: number | string): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'cancelled' } }
    })
  }

  stop(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
    this.connected = false
    this.live.clear()
    this.prompting.clear()
    this.autoApproveSessions.clear()
    this.sessionCwds.clear()
  }

  private resolveAllowedPath(rawPath: string, explicitSession?: unknown): string {
    const sessionId = this.inferSessionId(explicitSession)
    const baseCwd =
      (sessionId && this.sessionCwds.get(sessionId)) ||
      (this.sessionId && this.sessionCwds.get(this.sessionId)) ||
      [...this.sessionCwds.values()][0] ||
      process.cwd()
    const resolved = path.resolve(baseCwd, rawPath)
    const roots = [
      ...new Set([
        ...this.sessionCwds.values(),
        baseCwd,
        os.tmpdir(),
        path.join(os.homedir(), '.grok')
      ])
    ].map((dir) => path.resolve(dir))
    const isInside = roots.some((root) => {
      const rel = path.relative(root, resolved)
      return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!isInside) {
      throw new Error(`Access denied: path outside workspace (${rawPath})`)
    }
    return resolved
  }

  private inferSessionId(explicit: unknown): string {
    if (typeof explicit === 'string' && explicit) return explicit
    if (this.prompting.size === 1) return [...this.prompting][0]
    return ''
  }

  private onData(chunk: string): void {
    this.buf += chunk
    const parts = this.buf.split(/\r?\n/)
    this.buf = parts.pop() || ''
    for (const line of parts) {
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.handleAgentRequest(msg)
      return
    }
    if (typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        const params = (msg.params || {}) as Record<string, unknown>
        const update = (params.update || params) as AcpUpdate
        const sessionId = this.inferSessionId(params.sessionId || update.sessionId)
        this.emit('update', { ...update, sessionId })
      } else {
        this.emit('notify', msg)
      }
      return
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(Number(msg.id))
      if (!pending) return
      this.pending.delete(Number(msg.id))
      if (msg.error) {
        const err = msg.error as { message?: string; data?: unknown }
        const extra = err.data ? ` ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data)}` : ''
        pending.reject(new Error((err.message || 'ACP error') + extra))
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  private handleAgentRequest(msg: Record<string, unknown>): void {
    const method = String(msg.method)
    const id = msg.id as number | string
    const params = (msg.params || {}) as Record<string, unknown>

    if (method === 'session/request_permission') {
      const sessionId = this.inferSessionId(params.sessionId)
      const options = (params.options as PermissionRequest['options']) || [
        { optionId: 'allow-once', name: 'Allow' },
        { optionId: 'allow-always', name: 'Always allow' },
        { optionId: 'reject', name: 'Reject' }
      ]
      const req: PermissionRequest = {
        requestId: id,
        sessionId,
        toolCall: params.toolCall as PermissionRequest['toolCall'],
        options
      }
      if (this.autoApproveSessions.has(sessionId)) {
        const optionId = autoApprovalOption(options)
        if (optionId) {
          this.respondPermission(id, optionId)
          return
        }
      }
      this.emit('permission', req)
      return
    }

    if (method === 'fs/read_text_file') {
      try {
        const target = this.resolveAllowedPath(
          String((params as { path: string }).path),
          params.sessionId
        )
        const content = fs.readFileSync(target, 'utf8')
        this.send({ jsonrpc: '2.0', id, result: { content } })
      } catch (err) {
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err instanceof Error ? err.message : 'read failed' }
        })
      }
      return
    }

    if (method === 'fs/write_text_file') {
      try {
        const { path: rawPath, content } = params as { path: string; content: string }
        const target = this.resolveAllowedPath(String(rawPath), params.sessionId)
        fs.writeFileSync(target, content, 'utf8')
        this.send({ jsonrpc: '2.0', id, result: {} })
      } catch (err) {
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err instanceof Error ? err.message : 'write failed' }
        })
      }
      return
    }

    this.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    })
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              const pending = this.pending.get(id)
              if (!pending) return
              this.pending.delete(id)
              reject(new Error(`ACP timeout: ${method}`))
            }, timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        }
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(obj: unknown): void {
    if (!this.proc?.stdin.writable) return
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }
}
