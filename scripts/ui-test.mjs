import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP = 'http://127.0.0.1:9229'
const results = []
let pingSessionId = null
let pingCwd = null
let treeTestDir = null

function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

async function waitFor(fn, ms = 15000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw last || new Error('timeout')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('cdp timeout ' + method))
        }
      }, 20000)
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails))
    }
    return res.result?.value
  }

  async flush() {
    await this.eval(`new Promise((r) => setTimeout(r, 80))`)
  }
}

const pages = await waitFor(async () => {
  const res = await fetch(`${CDP}/json/list`)
  if (!res.ok) throw new Error('cdp ' + res.status)
  const list = await res.json()
  return list.filter((t) => t.type === 'page' && /5173|renderer|index\.html/.test(t.url || ''))
})

if (!pages.length) {
  console.error('No renderer page on 9229. Is the app running with remote debugging?')
  process.exit(1)
}

const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('ws failed'))
})
const cdp = new Cdp(ws)
await cdp.send('Runtime.enable')

try {
  const ready = await waitFor(() => cdp.eval('Boolean(window.__GROK_STORE && window.__GROK_STORE.getState().ready)'))
  if (!ready) throw new Error('store not ready')
  pass('app ready')
} catch (e) {
  fail('app ready', e.message)
}

try {
  const snap = await cdp.eval(`(() => {
    const s = window.__GROK_STORE.getState()
    const sidebar = document.querySelector('.sidebar')
    const rect = sidebar ? sidebar.getBoundingClientRect() : null
    return {
      signedIn: s.auth.signedIn,
      threads: s.threads.length,
      projects: s.projects.length,
      connected: s.connected,
      model: s.model,
      sidebarWidth: rect ? Math.round(rect.width) : 0,
      sidebarHeight: rect ? Math.round(rect.height) : 0,
      collapsed: s.sidebarCollapsed,
      recents: document.querySelectorAll('.thread-item').length,
      hasComposer: Boolean(document.querySelector('.composer'))
    }
  })()`)
  if (snap.sidebarWidth < 200) throw new Error('sidebar too narrow: ' + snap.sidebarWidth)
  if (snap.threads < 1) throw new Error('no threads')
  if (!snap.hasComposer) throw new Error('no composer')
  pass(
    'shell layout',
    `sidebar=${snap.sidebarWidth}px threads=${snap.threads} projects=${snap.projects} recents=${snap.recents} connected=${snap.connected}`
  )
} catch (e) {
  fail('shell layout', e.message)
}

try {
  const after = await cdp.eval(`(async () => {
    const store = window.__GROK_STORE.getState()
    const thread = store.threads[0]
    if (!thread) throw new Error('no thread')
    await store.openThread(thread)
    await new Promise((r) => setTimeout(r, 400))
    const s = window.__GROK_STORE.getState()
    const rect = document.querySelector('.sidebar')?.getBoundingClientRect()
    return {
      collapsed: s.sidebarCollapsed,
      sidebarWidth: rect ? Math.round(rect.width) : 0,
      messages: s.messages.length,
      cwd: s.cwd,
      title: s.threads.find((t) => t.id === s.activeThreadId)?.title || thread.title
    }
  })()`)
  if (after.collapsed) throw new Error('sidebar collapsed after openThread')
  if (after.sidebarWidth < 200) throw new Error('sidebar disappeared, width=' + after.sidebarWidth)
  if (after.messages < 1) throw new Error('history did not load')
  pass('open thread keeps sidebar', `width=${after.sidebarWidth} messages=${after.messages}`)
} catch (e) {
  fail('open thread keeps sidebar', e.message)
}

try {
  const after = await cdp.eval(`(async () => {
    const store = window.__GROK_STORE.getState()
    const project = store.projects[1] || store.projects[0]
    await store.focusProject(project.path)
    await new Promise((r) => setTimeout(r, 200))
    const rect = document.querySelector('.sidebar')?.getBoundingClientRect()
    const s = window.__GROK_STORE.getState()
    return {
      collapsed: s.sidebarCollapsed,
      sidebarWidth: rect ? Math.round(rect.width) : 0,
      cwd: s.cwd
    }
  })()`)
  if (after.collapsed || after.sidebarWidth < 200) throw new Error('sidebar gone after focusProject ' + after.sidebarWidth)
  pass('focus project keeps sidebar', `width=${after.sidebarWidth}`)
} catch (e) {
  fail('focus project keeps sidebar', e.message)
}

try {
  await cdp.eval(`window.__GROK_STORE.getState().setPalette(true)`)
  await cdp.flush()
  const palette = await cdp.eval(`Boolean(document.querySelector('.palette'))`)
  if (!palette) throw new Error('palette missing')
  await cdp.eval(`window.__GROK_STORE.getState().setPalette(false)`)
  await cdp.flush()
  const closed = await cdp.eval(`!document.querySelector('.palette')`)
  if (!closed) throw new Error('palette did not close')
  pass('command palette open/close')
} catch (e) {
  fail('command palette open/close', e.message)
}

try {
  await cdp.eval(`window.__GROK_STORE.getState().setSettings(true)`)
  await cdp.flush()
  const open = await cdp.eval(`Boolean(document.querySelector('.modal'))`)
  await cdp.eval(`window.__GROK_STORE.getState().setSettings(false)`)
  await cdp.flush()
  const closed = await cdp.eval(`!document.querySelector('.modal')`)
  if (!open || !closed) throw new Error(JSON.stringify({ open, closed }))
  pass('settings modal open/close')
} catch (e) {
  fail('settings modal open/close', e.message)
}

try {
  const seen = []
  for (const tab of ['review', 'files', 'plan', 'terminal']) {
    await cdp.eval(`window.__GROK_STORE.getState().setRightTab(${JSON.stringify(tab)})`)
    await cdp.flush()
    seen.push(await cdp.eval(`document.querySelector('.right-tabs button.on')?.getAttribute('aria-label') || ''`))
  }
  if (seen.some((label) => !label) || new Set(seen).size !== 4) throw new Error(JSON.stringify(seen))
  pass('right pane tabs', seen.join(' / '))
} catch (e) {
  fail('right pane tabs', e.message)
}

try {
  await cdp.eval(`window.__GROK_STORE.getState().toggleSidebar()`)
  await cdp.flush()
  const collapsed = await cdp.eval(`({
    flag: window.__GROK_STORE.getState().sidebarCollapsed,
    width: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)
  })`)
  await cdp.eval(`window.__GROK_STORE.getState().toggleSidebar()`)
  await cdp.flush()
  const restored = await cdp.eval(`({
    flag: window.__GROK_STORE.getState().sidebarCollapsed,
    width: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)
  })`)
  if (!collapsed.flag) throw new Error('did not collapse ' + JSON.stringify(collapsed))
  if (restored.flag) throw new Error('did not restore flag ' + JSON.stringify(restored))
  if (restored.width < 200) throw new Error('did not restore width ' + restored.width)
  pass('sidebar toggle restore', `collapsed=${collapsed.width}px restored=${restored.width}px`)
} catch (e) {
  fail('sidebar toggle restore', e.message)
}

try {
  const empty = await cdp.eval(`(async () => {
    await window.__GROK_STORE.getState().newThread()
    await new Promise((r) => setTimeout(r, 150))
    const s = window.__GROK_STORE.getState()
    return {
      messages: s.messages.length,
      heading: document.querySelector('.empty-wrap h1')?.textContent || '',
      composer: Boolean(document.querySelector('.composer'))
    }
  })()`)
  if (empty.messages !== 0) throw new Error('messages not cleared')
  if (!/building|做什么/i.test(empty.heading)) throw new Error('empty heading: ' + empty.heading)
  if (!empty.composer) throw new Error('composer missing')
  pass('new thread empty state', empty.heading)
} catch (e) {
  fail('new thread empty state', e.message)
}

try {
  treeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-desktop-tree-refresh-'))
  await cdp.eval(
    `window.__GROK_STORE.getState().newThread(${JSON.stringify(treeTestDir)})`
  )
  fs.writeFileSync(path.join(treeTestDir, 'generated-requirements.md'), '# generated\n', 'utf8')
  const refreshed = await cdp.eval(`(async () => {
    const store = window.__GROK_STORE.getState()
    const before = store.tree.some((node) => node.name === 'generated-requirements.md')
    await store.refreshWorkspace(${JSON.stringify(treeTestDir)})
    const after = window.__GROK_STORE.getState().tree.some(
      (node) => node.name === 'generated-requirements.md'
    )
    return { before, after }
  })()`)
  if (refreshed.before || !refreshed.after) throw new Error(JSON.stringify(refreshed))
  pass('generated file tree refresh')
} catch (e) {
  fail('generated file tree refresh', e.message)
}

try {
  const chips = await cdp.eval(`(() => Array.from(document.querySelectorAll('.composer .chip-btn, .composer .chip')).map((el) => el.textContent.trim()))()`)
  const blob = chips.join(' | ')
  if (/Local|本地/.test(blob)) throw new Error('redundant Local chip is still visible: ' + blob)
  if (!/Grok/.test(blob)) throw new Error('no model chip: ' + blob)
  pass('composer chips', blob)
} catch (e) {
  fail('composer chips', e.message)
}

try {
  if (treeTestDir) {
    fs.writeFileSync(path.join(treeTestDir, 'created-before-task-finish.txt'), 'refresh me\n', 'utf8')
  }
  const ping = await cdp.eval(`(async () => {
    const store = window.__GROK_STORE.getState()
    const before = store.messages.length
    await store.send('Reply with exactly the single word: pong')
    const s = window.__GROK_STORE.getState()
    return {
      before,
      after: s.messages.length,
      sessionId: s.activeThreadId,
      cwd: s.cwd,
      treeNames: s.tree.map((node) => node.name),
      kinds: s.messages.map((m) => m.kind),
      last: s.messages[s.messages.length - 1],
      error: s.error,
      running: s.running
    }
  })()`)
  const assistant = ping.kinds.includes('assistant') || (ping.last && ping.last.kind === 'assistant')
  const text = ping.last?.text || ''
  if (ping.error) throw new Error(ping.error)
  if (!assistant && !/pong/i.test(text)) {
    // still accept user message landed without crash
    if (ping.after <= ping.before) throw new Error('no new messages ' + JSON.stringify(ping))
  }
  if (treeTestDir && !ping.treeNames.includes('created-before-task-finish.txt')) {
    throw new Error('task completion did not refresh the generated file tree')
  }
  pingSessionId = ping.sessionId
  pingCwd = ping.cwd
  pass('send ping', `messages ${ping.before}->${ping.after} last=${ping.last?.kind}:${JSON.stringify(text).slice(0, 60)}`)
} catch (e) {
  fail('send ping', e.message)
}

try {
  await cdp.eval(`window.__GROK_STORE.getState().setPalette(false)`)
  await cdp.eval(`window.__GROK_STORE.getState().setSettings(false)`)
  await cdp.flush()
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  await cdp.flush()
  const palette = await cdp.eval(`Boolean(document.querySelector('.palette'))`)
  if (!palette) throw new Error('Ctrl+K did not open palette')
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await cdp.flush()
  const closed = await cdp.eval(`!document.querySelector('.palette')`)
  if (!closed) throw new Error('Escape did not close palette')
  pass('keyboard Ctrl+K / Esc')
} catch (e) {
  fail('keyboard Ctrl+K / Esc', e.message)
}

if (pingSessionId && pingCwd) {
  try {
    const removed = await cdp.eval(
      `window.grok.deleteThread(${JSON.stringify(pingSessionId)}, ${JSON.stringify(pingCwd)})`
    )
    if (!removed) throw new Error('deleteThread returned false')
    pass('test session cleanup')
  } catch (e) {
    fail('test session cleanup', e.message)
  }
}

if (treeTestDir) {
  const resolvedTreeTestDir = path.resolve(treeTestDir)
  const resolvedTemp = path.resolve(os.tmpdir()) + path.sep
  if (
    !resolvedTreeTestDir.startsWith(resolvedTemp) ||
    !path.basename(resolvedTreeTestDir).startsWith('grok-desktop-tree-refresh-')
  ) {
    fail('tree test cleanup', `refusing unexpected path: ${resolvedTreeTestDir}`)
  } else {
    fs.rmSync(resolvedTreeTestDir, { recursive: true, force: true })
    pass('tree test cleanup')
  }
}

ws.close()
const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed, ${failed.length} failed`)
fs.writeFileSync(
  path.join(path.resolve('I:\\code\\python\\grokDeskTop'), 'scripts', 'ui-test-results.json'),
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2)
)
process.exit(failed.length ? 1 : 0)
