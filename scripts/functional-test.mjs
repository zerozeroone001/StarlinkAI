import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const grokHome = path.join(os.homedir(), '.grok')
const grokBin = path.join(grokHome, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
const project = path.resolve('I:\\code\\python\\grokDeskTop')
const results = []

function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

function walkSummaries(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === 'summary.json') out.push(full)
    }
  }
  return out
}

function extractUserText(content) {
  const chunks = []
  if (typeof content === 'string') chunks.push(content)
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') chunks.push(part)
      else if (part && typeof part === 'object' && 'text' in part) chunks.push(String(part.text || ''))
    }
  }
  const text = chunks.join('\n')
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (query) return query[1].trim()
  if (text.includes('<user_info>') || text.includes('<system-reminder>')) return ''
  return text.trim()
}

class AcpClient {
  constructor() {
    this.pending = new Map()
    this.nextId = 1
    this.buf = ''
    this.updates = []
    this.agentRequests = []
  }

  start() {
    const env = { ...process.env, GROK_HOME: grokHome }
    delete env.GROK_CONFIG
    delete env.GROK_CONFIG_PATH
    this.proc = spawn(grokBin, ['agent', '--no-leader', 'stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    this.proc.stdout.on('data', (c) => this.onData(c.toString('utf8')))
    this.proc.stderr.on('data', (c) => {
      this.stderr = (this.stderr || '') + c.toString('utf8')
    })
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`agent exited ${code}`))
      this.pending.clear()
    })
  }

  onData(chunk) {
    this.buf += chunk
    const parts = this.buf.split(/\r?\n/)
    this.buf = parts.pop() || ''
    for (const line of parts) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        this.agentRequests.push(msg)
        if (msg.method === 'session/request_permission') {
          this.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
          })
        } else if (msg.method === 'fs/read_text_file') {
          try {
            const content = fs.readFileSync(msg.params.path, 'utf8')
            this.send({ jsonrpc: '2.0', id: msg.id, result: { content } })
          } catch (err) {
            this.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: String(err.message) }
            })
          }
        } else {
          this.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` }
          })
        }
        continue
      }
      if (typeof msg.method === 'string') {
        this.updates.push(msg)
        continue
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id))
        if (!p) continue
        this.pending.delete(Number(msg.id))
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'error'), { raw: msg.error }))
        else p.resolve(msg.result)
      }
    }
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, timeoutMs)
    })
  }

  stop() {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
  }
}

// --- local data ---
try {
  if (!fs.existsSync(grokBin)) throw new Error('missing grok binary')
  pass('grok binary exists', grokBin)
} catch (e) {
  fail('grok binary exists', e.message)
}

try {
  const auth = JSON.parse(fs.readFileSync(path.join(grokHome, 'auth.json'), 'utf8'))
  const entry = Object.values(auth)[0]
  if (!entry?.email) throw new Error('no email')
  pass('auth.json readable', entry.email.replace(/(.{2}).+(@.*)/, '$1***$2'))
} catch (e) {
  fail('auth.json readable', e.message)
}

try {
  const files = walkSummaries(path.join(grokHome, 'sessions'))
  if (files.length < 1) throw new Error('no summaries')
  const threads = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
  const withCwd = threads.filter((t) => t.info?.cwd && t.info?.id)
  if (withCwd.length < 1) throw new Error('summaries missing cwd/id')
  pass('session index', `${files.length} threads, ${new Set(withCwd.map((t) => t.info.cwd)).size} projects`)
} catch (e) {
  fail('session index', e.message)
}

try {
  const files = walkSummaries(path.join(grokHome, 'sessions'))
  const summary = JSON.parse(fs.readFileSync(files[0], 'utf8'))
  const cwd = summary.info.cwd
  const id = summary.info.id
  const encoded = encodeURIComponent(cwd)
  const histFile = path.join(grokHome, 'sessions', encoded, id, 'chat_history.jsonl')
  if (!fs.existsSync(histFile)) throw new Error('history missing for ' + id)
  const lines = fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean)
  let users = 0
  let assistants = 0
  let tools = 0
  for (const line of lines.slice(0, 400)) {
    const row = JSON.parse(line)
    if (row.type === 'user' && extractUserText(row.content)) users++
    if (row.type === 'assistant') assistants++
    if (row.type === 'assistant' && Array.isArray(row.tool_calls)) tools += row.tool_calls.length
  }
  if (users < 1) throw new Error('no user messages extracted')
  pass('history parse', `${lines.length} lines, ${users} user, ${assistants} assistant, ${tools} tools`)
} catch (e) {
  fail('history parse', e.message)
}

try {
  const git = spawn('git', ['status', '--porcelain=v1', '-b'], { cwd: project, windowsHide: true })
  const result = await new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    git.stdout.on('data', (d) => (out += d))
    git.stderr.on('data', (d) => (err += d))
    git.on('error', (err) => reject(err))
    git.on('close', (code) => resolve({ code, out, err }))
  })
  if (result.code === 0) {
    const branch = /##\s+([^\s.]+)/.exec(result.out)?.[1] || 'unknown'
    pass('git status', `branch ${branch}`)
  } else if (/not a git repository/i.test(result.err)) {
    pass('git status', 'project is not a git repository — review pane uses its empty state')
  } else {
    fail('git status', result.err.trim() || `git status ${result.code}`)
  }
} catch (e) {
  if (String(e.message).includes('ENOENT') || e.code === 'ENOENT') {
    pass('git status', 'git not installed — review pane should show fallback')
  } else {
    fail('git status', e.message)
  }
}

try {
  const names = fs.readdirSync(project)
  if (!names.includes('package.json')) throw new Error('no package.json')
  if (!names.includes('src')) throw new Error('no src')
  pass('project tree', `${names.length} top-level entries`)
} catch (e) {
  fail('project tree', e.message)
}

try {
  const raw = '@@ -1,2 +1,2 @@\n-old\n+new\n ctx'
  const hunks = []
  let current = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) current.lines.push('add')
    else if (line.startsWith('-')) current.lines.push('del')
    else current.lines.push('ctx')
  }
  if (hunks.length !== 1 || hunks[0].lines.join() !== 'del,add,ctx') throw new Error('parse mismatch')
  pass('diff parser')
} catch (e) {
  fail('diff parser', e.message)
}

// --- ACP ---
const acp = new AcpClient()
let sessionId = null
try {
  acp.start()
  const init = await acp.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'StarlinkAI Test', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
  })
  const caps = init.agentCapabilities || {}
  pass(
    'acp initialize',
    `loadSession=${!!caps.loadSession} resume=${!!caps.sessionCapabilities?.resume} version=${init._meta?.agentVersion || '?'}`
  )

  try {
    await acp.request('authenticate', { methodId: init._meta?.defaultAuthMethodId || 'cached_token' })
    pass('acp authenticate')
  } catch (e) {
    fail('acp authenticate', e.message)
  }

  try {
    const created = await acp.request('session/new', {
      cwd: project,
      mcpServers: []
    })
    sessionId = created.sessionId
    if (!sessionId) throw new Error('no sessionId')
    pass('session/new', sessionId.slice(0, 8) + '…')
  } catch (e) {
    fail('session/new', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
  }

  if (sessionId) {
    try {
      acp.updates = []
      const promptResult = await acp.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Reply with exactly the single word: pong' }]
        },
        120000
      )
      const texts = acp.updates
        .map((u) => u.params?.update || u.params || {})
        .filter((u) => u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_message')
        .map((u) => u.content?.text || u.text || '')
        .join('')
      const stop = promptResult?.stopReason || promptResult?.stop_reason || JSON.stringify(promptResult).slice(0, 80)
      pass('session/prompt ping', `stop=${stop} text=${JSON.stringify(texts.slice(0, 80))}`)
    } catch (e) {
      fail('session/prompt ping', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
    }
  }

  // load without mcpServers (current app bug)
  const files = walkSummaries(path.join(grokHome, 'sessions'))
  const existing = JSON.parse(fs.readFileSync(files[0], 'utf8'))
  const existingId = existing.info.id
  const existingCwd = existing.info.cwd
  try {
    await acp.request('session/load', { sessionId: existingId, cwd: existingCwd })
    fail('session/load without mcpServers', 'should reject; protocol requires mcpServers')
  } catch (e) {
    if (/mcpServers|Invalid params/i.test(e.message + JSON.stringify(e.raw || {}))) {
      pass('session/load without mcpServers', 'correctly rejected')
    } else {
      fail('session/load without mcpServers', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
    }
  }

  try {
    await acp.request('session/load', { sessionId: existingId, cwd: existingCwd, mcpServers: [] }, 60000)
    pass('session/load with mcpServers', existingId.slice(0, 8) + '…')
  } catch (e) {
    fail('session/load with mcpServers', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
  }

  try {
    await acp.request('session/resume', { sessionId: existingId, cwd: existingCwd, mcpServers: [] })
    pass('session/resume', existingId.slice(0, 8) + '…')
  } catch (e) {
    fail('session/resume', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
  }

  if (sessionId) {
    try {
      await acp.request('session/set_mode', { sessionId, modeId: 'worktree' })
      pass('session/set_mode worktree')
    } catch (e) {
      fail('session/set_mode worktree', e.message + (e.raw ? ' ' + JSON.stringify(e.raw) : ''))
    }
  }
} catch (e) {
  fail('acp initialize', e.message)
} finally {
  acp.stop()
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (sessionId) {
    const sessionsRoot = path.resolve(grokHome, 'sessions')
    const testSession = path.resolve(sessionsRoot, encodeURIComponent(project), sessionId)
    if (
      !testSession.startsWith(sessionsRoot + path.sep) ||
      path.basename(testSession) !== sessionId
    ) {
      throw new Error(`refusing to remove unexpected functional-test session: ${testSession}`)
    }
    fs.rmSync(testSession, { recursive: true, force: true })
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed, ${failed.length} failed`)
fs.writeFileSync(
  path.join(project, 'scripts', 'functional-test-results.json'),
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2)
)
process.exit(failed.length ? 1 : 0)
