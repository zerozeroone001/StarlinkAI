import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createAssistantStore, assistantContext, AssistantRevisionConflictError } from '../src/main/runtime/assistant-store'
import { ASSISTANT_LIMITS } from '../src/shared/assistant'
import { sessionDir, listThreads, deleteThread } from '../src/main/sessions'
import { resolveMediaPath } from '../src/main/preview'
import { GrokAcp } from '../src/main/acp'
import './assistant-portable-tests'

function fixture() {
  const base = path.resolve('.tmp')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'assistant-store-'))
  return {
    root,
    store: createAssistantStore(path.join(root, 'assistants')),
    file: (scopeId: string) => path.join(root, 'assistants', `${createHash('sha256').update(scopeId).digest('hex')}.json`),
    close: () => {
      assert.ok(root.startsWith(base + path.sep))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

test('default profiles are read-only and each scope retains its own stable persona', async () => {
  const f = fixture()
  try {
    const initial = await f.store.get('project-A')
    assert.equal(initial.profile.name, '主 agent')
    assert.equal(initial.revision, 0)
    assert.equal(fs.existsSync(path.dirname(f.file('project-A'))), false)
    const changed = await f.store.update('project-A', { name: '阿澄', persona: '记得先核对再执行', addressing: '小林', style: 'warm' })
    assert.equal(changed.revision, 1)
    assert.deepEqual(await createAssistantStore(path.dirname(f.file('project-A'))).get('project-A'), changed)
    assert.equal((await f.store.get('project-a')).profile.name, '主 agent')
    assert.equal((await f.store.get('project-B')).profile.persona, '')
    await f.store.update('CON', { name: '保留字也可作为逻辑编号' })
    assert.equal((await f.store.get('CON')).revision, 1)
  } finally { f.close() }
})

test('concurrent writes retain every memory and a monotonic revision', async () => {
  const f = fixture()
  try {
    await Promise.all(Array.from({ length: 24 }, (_, i) => f.store.saveMemory('project', { content: `preference ${i}`, kind: 'preference' })))
    const snapshot = await f.store.get('project')
    assert.equal(snapshot.revision, 24)
    assert.equal(snapshot.memories.length, 24)
    assert.equal(new Set(snapshot.memories.map((m) => m.id)).size, 24)
    assert.deepEqual(snapshot.memories.map((m) => m.content).sort(), Array.from({ length: 24 }, (_, i) => `preference ${i}`).sort())
    assert.deepEqual(await createAssistantStore(path.dirname(f.file('project'))).get('project'), snapshot)
  } finally { f.close() }
})

test('memory editing and forgetting preserve identity and cannot update another scope', async () => {
  const f = fixture()
  try {
    const first = await f.store.saveMemory('project-A', { content: 'concise', kind: 'preference', source: 'user' })
    const memory = first.memories[0]
    const edited = await f.store.saveMemory('project-A', { id: memory.id, content: 'detailed', kind: 'agreement' })
    assert.equal(edited.memories[0].createdAt, memory.createdAt)
    assert.equal(edited.memories[0].source, 'user')
    assert.equal(edited.memories[0].content, 'detailed')
    await assert.rejects(f.store.saveMemory('project-B', { id: memory.id, content: 'wrong', kind: 'fact' }), /不存在/)
    const removed = await f.store.forgetMemory('project-A', memory.id)
    assert.equal(removed.memories.length, 0)
    assert.equal((await f.store.forgetMemory('project-A', memory.id)).revision, removed.revision)
  } finally { f.close() }
})

test('overdue reminders survive restart, are notified once, and rescheduling rearms them', async () => {
  const f = fixture()
  try {
    const dueAt = '2026-10-01T12:00:00.000Z'
    const first = await f.store.saveCommitment('project', { title: '检查交付', dueAt })
    const reminder = first.commitments[0]
    const restarted = createAssistantStore(path.dirname(f.file('project')))
    assert.equal((await restarted.due(Date.parse(dueAt))).length, 1)
    await restarted.markNotified('project', reminder.id, dueAt, dueAt)
    assert.equal((await restarted.due(Date.parse(dueAt))).length, 0)
    const later = '2026-10-02T12:00:00.000Z'
    await restarted.saveCommitment('project', { id: reminder.id, title: reminder.title, dueAt: later })
    assert.equal((await restarted.due(Date.parse(dueAt))).length, 0)
    assert.equal((await restarted.due(Date.parse(later))).length, 1)
    await restarted.markNotified('project', reminder.id, dueAt, later)
    assert.equal((await restarted.get('project')).commitments[0].notifiedAt, undefined, 'a stale notification must not mark a rescheduled reminder')
    await restarted.saveCommitment('project', { id: reminder.id, title: reminder.title, status: 'done' })
    assert.equal((await restarted.due(Date.parse(later))).length, 0)
    await restarted.saveCommitment('project', { id: reminder.id, title: reminder.title, status: 'open' })
    assert.equal((await restarted.due(Date.parse(later))).length, 1)
    await restarted.deleteCommitment('project', reminder.id)
    assert.equal((await restarted.get('project')).commitments.length, 0)
  } finally { f.close() }
})

test('clearing a due date preserves the commitment but removes it from reminder checks', async () => {
  const f = fixture()
  try {
    const saved = await f.store.saveCommitment('project', { title: 'review', dueAt: '2026-10-01T12:00:00Z', notifiedAt: '2026-10-01T12:00:01Z' })
    const id = saved.commitments[0].id
    const cleared = await f.store.saveCommitment('project', { id, title: 'review', dueAt: null })
    assert.equal(cleared.commitments[0].dueAt, undefined)
    assert.equal(cleared.commitments[0].notifiedAt, undefined)
    assert.equal((await f.store.due()).length, 0)
  } finally { f.close() }
})

test('a damaged primary recovers from backup and damaged primary plus backup fail closed', async () => {
  const f = fixture()
  try {
    await f.store.update('project', { name: 'saved first' })
    const latest = await f.store.update('project', { name: 'saved second' })
    fs.writeFileSync(f.file('project'), '{')
    assert.deepEqual(await f.store.get('project'), latest)
    assert.equal(JSON.parse(fs.readFileSync(f.file('project'), 'utf8')).snapshot.profile.name, 'saved second')
    fs.writeFileSync(f.file('project'), 'broken primary')
    fs.writeFileSync(f.file('project') + '.bak', 'broken backup')
    await assert.rejects(f.store.update('project', { name: 'must not overwrite' }), /未被覆盖/)
    assert.equal(fs.readFileSync(f.file('project'), 'utf8'), 'broken primary')
    assert.equal((await f.store.due()).length, 0)
  } finally { f.close() }
})

test('reminder checks can recover an orphaned backup and never cross filename scope boundaries', async () => {
  const f = fixture()
  try {
    await f.store.saveCommitment('project-A', { title: 'due', dueAt: '2026-01-01T00:00:00Z' })
    await f.store.update('project-A', { name: 'new name' })
    fs.unlinkSync(f.file('project-A'))
    assert.equal((await f.store.due(Date.parse('2026-02-01T00:00:00Z'))).length, 1)
    fs.copyFileSync(f.file('project-A'), f.file('project-B'))
    await assert.rejects(f.store.get('project-B'), /未被覆盖/)
    assert.equal((await f.store.due(Date.parse('2026-02-01T00:00:00Z'))).length, 1)
  } finally { f.close() }
})

test('recovery never resurrects forgotten memories or deleted commitments', async () => {
  const f = fixture()
  try {
    const first = await f.store.saveMemory('project', { content: 'forget this', kind: 'fact' })
    const added = await f.store.saveCommitment('project', { title: 'delete this' })
    await f.store.forgetMemory('project', first.memories[0].id)
    const latest = await f.store.deleteCommitment('project', added.commitments[0].id)
    assert.equal(JSON.parse(fs.readFileSync(f.file('project') + '.bak', 'utf8')).snapshot.memories.length, 0)
    fs.writeFileSync(f.file('project'), 'damaged')
    const recovered = await f.store.get('project')
    assert.deepEqual(recovered, latest)
    assert.equal(recovered.memories.length, 0)
    assert.equal(recovered.commitments.length, 0)
  } finally { f.close() }
})

test('clearing one scope removes its persona, memories and reminders while preserving revision and other scopes', async () => {
  const f = fixture()
  try {
    await f.store.update('standalone', { name: 'custom', persona: 'private persona', addressing: 'friend', style: 'companion' })
    await f.store.saveMemory('standalone', { content: 'private memory', kind: 'fact' })
    const before = await f.store.saveCommitment('standalone', { title: 'old reminder', dueAt: '2026-01-01T00:00:00Z' })
    const other = await f.store.saveCommitment('project', { title: 'keep project reminder', dueAt: '2026-01-01T00:00:00Z' })
    const cleared = await f.store.clear('standalone')
    assert.equal(cleared.revision, before.revision + 1)
    assert.equal(cleared.profile.name, '主 agent')
    assert.equal(cleared.profile.persona, '')
    assert.equal(cleared.profile.addressing, '')
    assert.equal(cleared.profile.style, 'balanced')
    assert.equal(cleared.memories.length, 0)
    assert.equal(cleared.commitments.length, 0)
    assert.deepEqual(await f.store.get('project'), other)
    assert.deepEqual((await f.store.due(Date.parse('2026-02-01T00:00:00Z'))).map((item) => item.scopeId), ['project'])
    fs.writeFileSync(f.file('standalone'), 'corrupt after clearing')
    assert.deepEqual(await f.store.get('standalone'), cleared)
    await assert.rejects(f.store.applyActions('standalone', { memoryUpdates: [{ content: 'must not revive', kind: 'fact' }] }, 'old-run', before.revision), AssistantRevisionConflictError)
    assert.deepEqual(await f.store.get('standalone'), cleared)
  } finally { f.close() }
})

test('late assistant actions cannot overwrite a user edit or recreate forgotten memory', async () => {
  const f = fixture()
  try {
    const first = await f.store.saveMemory('project', { content: 'forget this fact', kind: 'fact' })
    await f.store.forgetMemory('project', first.memories[0].id)
    await assert.rejects(f.store.applyActions('project', {
      memoryUpdates: [{ content: 'forget this fact', kind: 'fact' }], commitmentUpdates: [{ title: 'must not save either' }]
    }, 'old-run', first.revision), (error: unknown) => error instanceof AssistantRevisionConflictError && error.code === 'ASSISTANT_REVISION_CONFLICT')
    const current = await f.store.get('project')
    assert.equal(current.memories.length, 0)
    assert.equal(current.commitments.length, 0)
    await f.store.update('project', { addressing: 'updated by user' })
    await assert.rejects(f.store.applyActions('project', { commitmentUpdates: [{ title: 'stale reminder' }] }, 'old-run', current.revision), AssistantRevisionConflictError)
    const fresh = await f.store.get('project')
    const next = await f.store.applyActions('project', { memoryUpdates: [{ content: 'explicit new request', kind: 'preference' }] }, 'new-run', fresh.revision)
    assert.equal(next.memories[0].content, 'explicit new request')
    await assert.rejects(f.store.applyActions('project', {}, 'invalid-run', -1), /版本无效/)
  } finally { f.close() }
})

test('a newer backup recovers a write interrupted between the two atomic replacements', async () => {
  const f = fixture()
  try {
    await f.store.update('project', { name: 'old' })
    const older = fs.readFileSync(f.file('project'), 'utf8')
    const latest = await f.store.update('project', { name: 'new' })
    fs.writeFileSync(f.file('project'), older)
    assert.deepEqual(await f.store.get('project'), latest)
    assert.equal(JSON.parse(fs.readFileSync(f.file('project'), 'utf8')).snapshot.profile.name, 'new')
  } finally { f.close() }
})

test('invalid identifiers, payload fields, dates and excessive content never reach storage', async () => {
  const f = fixture()
  try {
    for (const scope of ['../project', '..\\project', '', 'project/name']) await assert.rejects(f.store.get(scope), /编号/)
    await assert.rejects(f.store.update('project', { name: '  ' }), /资料/)
    await assert.rejects(f.store.update('project', { scopeId: 'other' } as any), /字段/)
    await assert.rejects(f.store.update('project', { style: 'invented' } as any), /风格/)
    await assert.rejects(f.store.saveMemory('project', { content: 'x'.repeat(4001), kind: 'fact' }), /长度/)
    await assert.rejects(f.store.saveCommitment('project', { title: 'due', dueAt: '2026-10-08 11:30' }), /时间/)
    await assert.rejects(f.store.saveCommitment('project', { title: 'due', status: 'cancelled' } as any), /格式/)
    assert.equal(fs.existsSync(f.file('project')), false)
  } finally { f.close() }
})

test('assistant context is bounded, carries record ids, and excludes completed commitments', async () => {
  const f = fixture()
  try {
    await f.store.update('project', { name: '小澄', persona: 'carefully '.repeat(2000), style: 'companion' })
    const memory = (await f.store.saveMemory('project', { content: 'Prefer careful answers', kind: 'preference' })).memories[0]
    const open = (await f.store.saveCommitment('project', { title: 'unfinished' })).commitments[0]
    await f.store.saveCommitment('project', { title: 'already done', status: 'done' })
    const snapshot = await f.store.get('project')
    const context = assistantContext(snapshot)
    assert.ok(context.length <= ASSISTANT_LIMITS.context)
    assert.ok(context.includes(memory.id))
    assert.ok(context.includes(open.id))
    assert.ok(context.includes('不构成工具授权'))
    assert.ok(!context.includes('already done'))
    assert.equal(snapshot.profile.persona, 'carefully '.repeat(2000).trim())
    snapshot.profile.persona = '\u0001'.repeat(20000)
    const escaped = assistantContext(snapshot)
    assert.ok(escaped.length <= ASSISTANT_LIMITS.context)
    assert.ok(escaped.includes(memory.id))
    assert.ok(escaped.includes(open.id))
  } finally { f.close() }
})

test('model memory and commitment actions commit together and do not duplicate on replay', async () => {
  const f = fixture()
  try {
    const actions = {
      memoryUpdates: [{ content: 'Prefer Chinese', kind: 'preference' as const }],
      commitmentUpdates: [{ title: 'Check result', dueAt: '2026-10-08T15:00:00.000Z' }]
    }
    const saved = await f.store.applyActions('project', actions, 'run-1')
    assert.equal(saved.revision, 1)
    assert.equal(saved.memories.length, 1)
    assert.equal(saved.commitments.length, 1)
    assert.equal(saved.memories[0].source, 'run-1')
    assert.deepEqual(await f.store.applyActions('project', actions, 'run-1'), saved)
    await assert.rejects(f.store.applyActions('project', {
      memoryUpdates: [{ content: 'Must not be saved', kind: 'fact' }],
      commitmentUpdates: [{ id: 'missing-record', title: 'Invalid update' }]
    }, 'run-2'), /不存在/)
    assert.deepEqual(await f.store.get('project'), saved)
    await assert.rejects(f.store.applyActions('project', {
      memoryUpdates: [{ id: saved.memories[0].id, content: 'change', kind: 'fact' }],
      forgetMemoryIds: [saved.memories[0].id]
    }, 'run-2'), /同时遗忘/)
    const removed = await f.store.applyActions('project', { forgetMemoryIds: [saved.memories[0].id] }, 'run-3')
    assert.equal(removed.memories.length, 0)
    await assert.rejects(f.store.applyActions('project', { memoryUpdates: [{ content: 'bad', kind: 'fact', source: 'spoof' }] } as any, 'run-4'), /宿主/)
  } finally { f.close() }
})

test('legacy ACP preserves multibyte characters split between transport chunks', async () => {
  const original = childProcess.spawn
  const child = new EventEmitter() as any
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => { child.emit('exit', 0); return true }
  childProcess.spawn = (() => child) as typeof childProcess.spawn
  syncBuiltinESMExports()
  const client = new GrokAcp('fixture-only')
  const updates: any[] = [], logs: string[] = []
  client.on('update', (update) => updates.push(update))
  client.on('log', (message) => logs.push(message))
  child.stdin.on('data', (data: Buffer) => {
    const request = JSON.parse(data.toString())
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n')
  })
  try {
    await client.start()
    const text = '中文边界与字符🙂'
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    } }) + '\n')
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
    for (const byte of Buffer.from(text)) child.stderr.write(Buffer.from([byte]))
    assert.equal(updates[0].content.text, text)
    assert.equal(logs.join(''), text)
  } finally {
    client.stop()
    childProcess.spawn = original
    syncBuiltinESMExports()
  }
})

test('legacy sessions reject traversal and media lookup never substitutes another conversation', () => {
  const f = fixture()
  const prior = process.env.GROK_HOME
  process.env.GROK_HOME = path.join(f.root, 'home')
  try {
    const cwd = path.join(f.root, 'project-A')
    const session = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd), 'safe-session')
    const other = path.join(process.env.GROK_HOME, 'sessions', 'other-project', 'other-session', 'images')
    fs.mkdirSync(session, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(session, 'summary.json'), JSON.stringify({ info: { id: '..\\..', cwd }, generated_title: 'unsafe' }))
    fs.writeFileSync(path.join(other, 'result.png'), 'other image')
    assert.equal(listThreads().length, 0)
    for (const id of ['..\\..', '../..', '..', '__new__']) {
      assert.equal(sessionDir(id, cwd), null)
      assert.equal(deleteThread(id, cwd), false)
    }
    assert.equal(resolveMediaPath('images/result.png', cwd, 'safe-session'), null)
    assert.equal(resolveMediaPath('images/result.png', cwd, 'safe-session', true), null)
    fs.mkdirSync(path.join(session, 'images'))
    fs.writeFileSync(path.join(session, 'images', 'result.png'), 'correct image')
    assert.equal(resolveMediaPath('images/result.png', cwd, 'safe-session'), path.join(session, 'images', 'result.png'))
    assert.equal(deleteThread('safe-session', cwd), true)
    assert.equal(fs.existsSync(path.join(other, 'result.png')), true)
    assert.equal(fs.existsSync(process.env.GROK_HOME), true)
  } finally {
    if (prior === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prior
    f.close()
  }
})

test('legacy sessions reject a directory whose real path escapes the session root', () => {
  const f = fixture()
  const prior = process.env.GROK_HOME
  const realpath = fs.realpathSync
  process.env.GROK_HOME = path.join(f.root, 'home')
  try {
    const cwd = path.join(f.root, 'project')
    const grouping = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd))
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(grouping, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive')
    const candidate = path.join(grouping, 'linked-session')
    fs.mkdirSync(candidate)
    // Simulate junction resolution without requiring Windows symlink privileges.
    fs.realpathSync = ((file: fs.PathLike, options: any) => String(file) === candidate ? outside : realpath(file, options)) as typeof fs.realpathSync
    assert.equal(sessionDir('linked-session', cwd), null)
    assert.equal(deleteThread('linked-session', cwd), false)
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'must survive')
  } finally {
    fs.realpathSync = realpath
    if (prior === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prior
    f.close()
  }
})
