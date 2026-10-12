import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

export interface Command {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}
export class StdioRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams
  private sequence = 0
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private closed = false
  private stopping = false
  private stderr = ''
  private exited: Promise<void>
  constructor(command: Command, cwd: string) {
    super()
    this.child = spawn(command.file, command.args, {
      cwd,
      env: command.env || process.env,
      windowsHide: true,
      stdio: 'pipe'
    })
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => resolve())
      this.child.once('error', () => resolve())
    })
    this.child.stdout.on('data', (data: Buffer) => this.read(this.decoder.write(data)))
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString('utf8')).slice(-4096)
    })
    this.child.on('error', (error) => this.finish(error))
    this.child.on('exit', (code) =>
      this.finish(
        new Error(
          `客户端已退出 (${code ?? 'signal'})${this.stderr ? `：${this.stderr.replace(/\x1b\[[0-9;]*m/g, '').slice(-700)}` : ''}`
        )
      )
    )
    this.child.stdin.on('error', (error) => this.finish(error))
  }
  private read(text: string) {
    this.buffer += text
    if (this.buffer.length > 48 * 1024 * 1024) {
      this.close()
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      // CLIs can print JSON diagnostics as well as protocol frames. Never let those
      // crash the host or consume a request before its actual response arrives.
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      if (typeof message.method === 'string' && message.method) {
        this.emit(message.id === undefined ? 'notification' : 'request', message)
      } else {
        if ('method' in message || (!('result' in message) &&
          (!message.error || typeof message.error !== 'object'))) continue
        const entry = this.pending.get(message.id)
        if (!entry) continue
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message || '客户端协议错误'))
        else entry.resolve(message.result)
      }
    }
  }
  request<T = any>(method: string, params: unknown, timeout = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('客户端连接已关闭'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`客户端响应超时：${method}`))
      }, timeout) : undefined
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }
  respond(id: number | string, result: unknown) {
    this.write({ jsonrpc: '2.0', id, result })
  }
  reject(id: number | string, message = '此客户端不支持该操作') {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } })
  }
  private write(message: unknown) {
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  private finish(error: Error) {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.emit('closed', error)
  }
  close() {
    if (this.stopping) return
    this.stopping = true
    this.finish(new Error('客户端连接已结束'))
    this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    if (process.platform === 'win32' && this.child.pid)
      execFile(
        'taskkill.exe',
        ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 },
        (error) => { if (error && this.child.exitCode === null) this.child.kill() }
      )
    else this.child.kill()
  }
  async stop() {
    this.close()
    await this.exited
  }
}
