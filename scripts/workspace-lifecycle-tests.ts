import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceLifecycle } from '../src/main/workspace-lifecycle'
import { assertDesktopSender, registerDesktopWindow } from '../src/main/desktop-security'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

function fixture(overrides: Partial<Parameters<typeof createWorkspaceLifecycle>[0]> = {}) {
  const requests: string[] = [], actions: string[] = []
  let resumed = 0, confirmations = 0
  const gate = createWorkspaceLifecycle({ available: () => true, timeoutMs: 20,
    prepare: (id) => requests.push(id), resume: () => { resumed++ },
    confirmDiscard: async () => { confirmations++; return false },
    perform: async (action, force) => { actions.push(`${action}:${force}`) }, ...overrides })
  return { gate, requests, actions, get resumed() { return resumed }, get confirmations() { return confirmations } }
}

test('ready page must finish saving before close; simultaneous requests share one acknowledgement', async () => {
  const f = fixture(); f.gate.ready()
  const close = f.gate.request('close')
  const quit = f.gate.request('quit')
  assert.equal(close, quit); assert.equal(f.requests.length, 1); assert.deepEqual(f.actions, [])
  f.gate.receive(f.requests[0], { ok: true })
  assert.equal(await close, true); assert.deepEqual(f.actions, ['quit:false']); assert.equal(f.gate.canUnload, true)
})
test('failure and timeout retain the window and unfreeze the renderer by default', async () => {
  for (const timeout of [false, true]) {
    const f = fixture(); f.gate.ready()
    const close = f.gate.request('close')
    if (!timeout) f.gate.receive(f.requests[0], { ok: false, error: 'disk full' })
    assert.equal(await close, false); assert.equal(f.confirmations, 1); assert.equal(f.resumed, 1)
    assert.deepEqual(f.actions, []); assert.equal(f.gate.canUnload, false)
    assert.throws(() => f.gate.receive(f.requests[0], { ok: true }), /失效/)
  }
})
test('discard is explicit, and a later close asks for a fresh save after cancellation', async () => {
  let discard = false
  const f = fixture({ confirmDiscard: async () => discard }); f.gate.ready()
  const first = f.gate.request('reload'); f.gate.receive(f.requests[0], { ok: false }); assert.equal(await first, false)
  discard = true
  const second = f.gate.request('reload'); assert.equal(f.requests.length, 2)
  f.gate.receive(f.requests[1], { ok: false }); assert.equal(await second, true)
  assert.deepEqual(f.actions, ['reload:false'])
})
test('unready or crashed pages do not wait on a nonexistent renderer gate', async () => {
  const f = fixture(); assert.equal(await f.gate.request('close'), true); assert.equal(f.requests.length, 0)
  f.gate.invalidate(); f.gate.ready(); const pending = f.gate.request('reload')
  f.gate.invalidate(); assert.equal(await pending, false)
  assert.throws(() => f.gate.receive(f.requests[0], { ok: true }), /失效/)
  assert.equal(await f.gate.request('close'), true)
})
test('mismatched and malformed acknowledgements cannot authorize navigation', async () => {
  const f = fixture(); f.gate.ready(); const pending = f.gate.request('reload')
  assert.throws(() => f.gate.receive('wrong-request', { ok: true }), /失效/)
  for (const result of [null, [], {}, { ok: 'true' }, { ok: true, error: {} }])
    assert.throws(() => f.gate.receive(f.requests[0], result), /格式/)
  assert.deepEqual(f.actions, [])
  f.gate.receive(f.requests[0], { ok: true }); await pending
  f.gate.invalidate(); assert.equal(f.gate.canUnload, false)
})
test('background persistence failure keeps the window unless its discard is confirmed', async () => {
  let discard = false, forced = 0
  const f = fixture({ confirmDiscard: async () => discard, perform: async (_action, force) => {
    if (!force) throw new Error('background save failed'); forced++
  } })
  assert.equal(await f.gate.request('quit'), false); assert.equal(f.resumed, 1)
  discard = true; assert.equal(await f.gate.request('quit'), true); assert.equal(forced, 1)
})
test('pet windows and child frames cannot acknowledge or register workspace persistence', () => {
  const entry = path.resolve('.tmp', 'fixture.html')
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: pathToFileURL(entry).href },
    isDestroyed: () => false, setWindowOpenHandler: () => {} })
  registerDesktopWindow({ webContents: contents } as any, { role: 'pet', entry })
  for (const channel of ['workspace:persistence-ready', 'workspace:persistence-respond'])
    assert.throws(() => assertDesktopSender({ sender: contents, senderFrame: contents.mainFrame } as any, channel), /无权/)
  registerDesktopWindow({ webContents: contents } as any, { role: 'main', entry })
  assert.throws(() => assertDesktopSender({ sender: contents, senderFrame: { ...contents.mainFrame } } as any, 'workspace:persistence-respond'), /无权/)
})
