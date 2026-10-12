import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import { executionClock } from '../src/main/runtime/execution-clock'
import { createContextArchive } from '../src/main/runtime/context-archive'
import { archiveContext, createRunJournal, type RunRecord } from '../src/main/runtime/run-journal'
import type { Execution } from '../src/main/runtime/adapters'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'

const employee = (id: string) => ({ id, name: id, provider: 'codex' as const, role: 'test', persona: '' })
const catalog = [{ id: 'codex', auth: { signedIn: true }, models: [{ id: 'test', name: 'Test', efforts: [], isDefault: true }] }] as RuntimeProvider[]
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({
  id: 'efficiency-run', workspaceId: 'efficiency-space', prompt: 'test', goal: '',
  employees: [employee('worker')], context: [], artifacts: [], ...patch
})
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await delay(5) }
  throw new Error('test did not settle')
}
async function terminal(runtime: ReturnType<typeof createRuntime>, id = 'efficiency-run') {
  await until(async () => !['running', 'queued', 'needs_permission'].includes((await runtime.api.run(id)).status))
  return runtime.api.run(id)
}
async function directory(t: TestContext) {
  const parent = path.resolve('.tmp')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'runtime-efficiency-'))
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(parent + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}
function fixture(t: TestContext, implementation: (input: Execution) => Promise<void>, extra: Record<string, unknown> = {}) {
  const runtime = createRuntime({ directory: () => process.cwd(), providers: async () => catalog,
    skills: () => [], execute: implementation, ...extra })
  t.after(() => runtime.close())
  return runtime
}

test('execution clock reports active and permission phases using an injected monotonic clock', () => {
  let now = 0
  const clock = executionClock(10000, 10000, () => assert.fail('unexpected timeout'), () => now)
  now = 10; clock.pause()
  now = 25; clock.pause()
  assert.deepEqual(clock.elapsed(), { executionMs: 10, permissionMs: 15 })
  now = 40; clock.resume(); clock.resume()
  now = 55
  assert.deepEqual(clock.elapsed(), { executionMs: 25, permissionMs: 30 })
  clock.close(); now = 200; clock.close()
  assert.deepEqual(clock.elapsed(), { executionMs: 25, permissionMs: 30 })
})

test('archive reuse compares the complete payload and repairs externally changed or missing files', async (t) => {
  const root = await directory(t)
  let writes = 0
  const archive = createContextArchive(async (...args) => { writes++; return archiveContext(...args) })
  const r = request()
  const first = await archive(root, r, [])
  assert.equal(first.reused, false)
  assert.equal((await archive(root, structuredClone(r), [])).reused, true)
  assert.equal(writes, 1)
  const changed = { ...r, context: [{ author: 'user', text: 'additional constraint' }] }
  assert.equal((await archive(root, changed, [])).reused, false)
  assert.equal((await archive(root, r, [])).reused, false)
  await fs.writeFile(first.path, 'tampered', 'utf8')
  assert.equal((await archive(root, r, [])).reused, false)
  assert.equal(JSON.parse(await fs.readFile(first.path, 'utf8')).runId, r.id)
  await fs.unlink(first.path)
  assert.equal((await archive(root, r, [])).reused, false)
  assert.equal(writes, 5)
})

test('archive cache never shares private scope variants and never caches failed writes', async (t) => {
  const root = await directory(t)
  let writes = 0, fail = false
  const archive = createContextArchive(async (cwd, r, handoffs, tasks) => {
    writes++
    if (fail) throw new Error('disk full')
    const scoped = path.join(cwd, r.assistantScopeId || 'worker')
    await fs.mkdir(scoped, { recursive: true })
    return archiveContext(scoped, r, handoffs, tasks)
  })
  const scoped = request({ assistantScopeId: 'private-a', privateContext: [{ author: 'user', text: 'secret' }] })
  const first = await archive(root, scoped, [])
  const worker = await archive(root, request(), [])
  assert.notEqual(first.path, worker.path)
  assert.equal((await archive(root, { ...scoped, assistantScopeId: 'private-b' }, [])).reused, false)
  assert.equal((await archive(root, scoped, [])).reused, true)
  fail = true
  await assert.rejects(archive(root, { ...scoped, goal: 'updated' }, []), /disk full/)
  fail = false
  assert.equal((await archive(root, { ...scoped, goal: 'updated' }, [])).reused, false)
  assert.equal(writes, 5)
})

test('runtime metrics separate adapter time, simultaneous permission waits, and submitted context', async (t) => {
  let now = 0
  const runtime = fixture(t, async (input) => {
    now = 20
    await Promise.all(['a', 'b'].map((title) => input.permission(title, '', [{ id: 'allow', label: 'Allow' }])))
    now = 170
    input.text('delivered')
  }, { now: () => now })
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('efficiency-run')).permissions.length === 2)
  const waiting = await runtime.api.run('efficiency-run')
  now = 70
  await runtime.api.permission(waiting.id, waiting.permissions[0].id, 'allow')
  now = 120
  await runtime.api.permission(waiting.id, waiting.permissions[1].id, 'allow')
  const result = await terminal(runtime)
  assert.equal(result.metrics?.modelCalls, 1)
  assert.equal(result.metrics?.workerCalls, 1)
  assert.equal(result.metrics?.leadCalls, 0)
  assert.equal(result.metrics?.workerExecutionMs, 70)
  assert.equal(result.metrics?.permissionWaitMs, 100)
  assert.equal(result.metrics?.contextCharacters, result.contextReport?.inputCharacters)
  assert.equal(result.metrics?.contextEstimatedTokens, result.contextReport?.estimatedTokens)
  assert.equal(result.metrics?.fileScans, 0)
})

test('queued waiting is measured independently and cancelled queue items never count model calls', async (t) => {
  let now = 0, release!: () => void, calls = 0
  const gate = new Promise<void>((resolve) => { release = resolve })
  const runtime = fixture(t, async (input) => { calls++; await gate; input.text('done') }, { now: () => now })
  t.after(release)
  await runtime.api.start(request({ id: 'first' }))
  await until(async () => calls === 1)
  await runtime.api.start(request({ id: 'next', queue: true }))
  await runtime.api.start(request({ id: 'cancelled', queue: true }))
  now = 75
  const cancelled = await runtime.api.cancel('cancelled')
  assert.equal(cancelled.metrics?.queueWaitMs, 75)
  assert.equal(cancelled.metrics?.modelCalls, 0)
  now = 120; release()
  const next = await terminal(runtime, 'next')
  assert.equal(next.metrics?.queueWaitMs, 120)
  assert.equal(next.metrics?.workerExecutionMs, 0)
  assert.equal(calls, 2)
})

test('cancelling a permission wait records elapsed phases without leaving a pending permission', async (t) => {
  let now = 0
  const runtime = fixture(t, async (input) => {
    now = 15
    await input.permission('permission', '', [{ id: 'allow', label: 'Allow' }])
    assert.fail('cancelled permission must not continue')
  }, { now: () => now })
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('efficiency-run')).permissions.length === 1)
  now = 95
  await runtime.api.cancel('efficiency-run')
  await runtime.close()
  const result = await runtime.api.run('efficiency-run')
  assert.equal(result.status, 'cancelled')
  assert.equal(result.metrics?.workerExecutionMs, 15)
  assert.equal(result.metrics?.permissionWaitMs, 80)
  assert.equal(result.permissions.length, 0)
  assert.equal(result.permissionHistory?.[0].status, 'cancelled')
})

test('unchanged lead retries reuse archives while worker scans and durable recovery remain intact', async (t) => {
  const root = await directory(t)
  let calls = 0
  const journal = createRunJournal(path.join(root, 'journal'))
  const runtime = fixture(t, async (input) => {
    calls++
    input.text(calls === 1 ? 'invalid decision' : JSON.stringify({ action: 'finish', message: 'done' }))
  }, { directory: () => root, archive: archiveContext, journal })
  await runtime.api.start(request({ employees: [employee('lead')], coordination: { leadId: 'lead' } }))
  const result = await terminal(runtime)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.metrics?.leadCalls, 2)
  assert.equal(result.metrics?.modelCalls, 2)
  assert.equal(result.metrics?.fileScans, 0)
  assert.equal(result.metrics?.archiveWrites, 1)
  assert.equal(result.metrics?.archiveReuses, 2)
  await runtime.close()
  const saved = await journal.load(result.id)
  assert.deepEqual(saved?.snapshot.metrics, result.metrics)
  const restored = fixture(t, async () => assert.fail('recovery must not execute'), { directory: () => root, journal })
  assert.deepEqual((await restored.api.start(request({ employees: [employee('lead')], coordination: { leadId: 'lead' } }))).metrics, result.metrics)
})

test('duplicate persistence requests save each unchanged revision only once, including close and settled cancel', async (t) => {
  const saved: RunRecord[] = []
  const runtime = fixture(t, async (input) => input.text('done'), {
    journal: { load: async () => null, save: async (record: RunRecord) => { saved.push(structuredClone(record)) } }
  })
  await runtime.api.start(request())
  const result = await terminal(runtime)
  await runtime.close()
  const writes = saved.length
  await runtime.api.cancel(result.id)
  await runtime.close()
  assert.equal(saved.length, writes)
  assert.equal(new Set(saved.map((record) => record.snapshot.revision)).size, writes)
  assert.equal(saved.at(-1)?.snapshot.status, 'completed')
})

test('backup recovery cannot overwrite a newer concurrently submitted save', async (t) => {
  const root = await directory(t)
  const journal = createRunJournal(root)
  const record = (revision: number): RunRecord => ({ version: 1, fingerprint: 'a'.repeat(64), snapshot: {
    id: 'recovery-race', workspaceId: 'workspace', status: 'completed', replies: [], permissions: [],
    revision, createdAt: new Date().toISOString(), contextTrimmed: false
  } })
  await journal.save(record(1))
  await journal.save(record(2))
  const primary = path.join(root, 'recovery-race.json')
  await fs.writeFile(primary, '{corrupt')
  const readFile = fs.readFile.bind(fs)
  let backupRead = false
  let release = () => {}
  const backupGate = new Promise<void>((resolve) => { release = resolve })
  const reading = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const value = await readFile(...args)
    if (args[0] === `${primary}.bak`) { backupRead = true; await backupGate }
    return value
  })
  const recovering = journal.load('recovery-race')
  let saving: Promise<void> | undefined
  try {
    await until(async () => backupRead)
    saving = journal.save(record(3))
    const unrelated = { ...record(1), snapshot: { ...record(1).snapshot, id: 'independent-run' } }
    await journal.save(unrelated)
    assert.equal((await journal.load('independent-run'))?.snapshot.revision, 1,
      'a slow recovery must not block other run IDs')
    // Hold the recovery at its old backup while allowing an unprotected save to finish.
    await Promise.race([saving, delay(150)])
    release()
    await Promise.all([recovering, saving])
    assert.equal((await journal.load('recovery-race'))?.snapshot.revision, 3)
    assert.equal(JSON.parse(await readFile(primary, 'utf8')).snapshot.revision, 3)
  } finally {
    release()
    await Promise.allSettled([recovering, saving])
    reading.mock.restore()
  }
})

test('a rejected journal recovery does not poison later saves for that run', async (t) => {
  const root = await directory(t)
  const journal = createRunJournal(root)
  await fs.writeFile(path.join(root, 'repairable.json'), 'corrupt')
  await assert.rejects(journal.load('repairable'), /执行记录无法读取/)
  await assert.rejects(journal.load('../invalid'), /执行编号无效/)
  const snapshot: RunRecord['snapshot'] = { id: 'repairable', workspaceId: 'workspace', status: 'failed',
    replies: [], permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false }
  await journal.save({ version: 1, fingerprint: 'b'.repeat(64), snapshot })
  assert.deepEqual((await journal.load('repairable'))?.snapshot, snapshot)
})

test('a failed initial journal write cannot invoke a model or be cached as saved', async (t) => {
  let calls = 0, saves = 0
  const runtime = fixture(t, async () => { calls++ }, {
    journal: { load: async () => null, save: async () => { if (++saves === 1) throw new Error('disk full') } }
  })
  await assert.rejects(runtime.api.start(request()), /未调用模型/)
  assert.equal(calls, 0)
  await runtime.close()
  assert.equal(saves, 2)
})

test('empty task delivery fails while preserving actual tool and filesystem receipts', async (t) => {
  const root = await directory(t)
  const runtime = fixture(t, async (input) => {
    await fs.writeFile(path.join(root, 'result.txt'), 'actual change', 'utf8')
    input.receipt?.({ commands: [{ command: 'mock-test', exitCode: 0 }] })
  }, { directory: () => root, archive: archiveContext })
  await runtime.api.start(request({ task: { id: 'task', title: 'test', description: '', acceptance: 'deliver', owner: 'worker', dependency: null } }))
  const result = await terminal(runtime)
  assert.equal(result.status, 'failed')
  assert.match(result.replies[0].error || '', /没有返回文字或图片交付/)
  assert.deepEqual(result.replies[0].receipt?.filesModified, ['result.txt'])
  assert.equal(result.replies[0].receipt?.commands?.[0].exitCode, 0)
  assert.equal(result.metrics?.fileScans, 2)
})

test('a delegated empty reply cannot enter review or become a successful handoff', async (t) => {
  let leadCalls = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'lead') input.text(JSON.stringify(++leadCalls === 1
      ? { action: 'delegate', employeeId: 'worker', title: 'deliver', description: 'produce an answer', acceptance: 'visible answer', dependsOn: [], message: 'assign' }
      : { action: 'blocked', message: 'worker produced no delivery' }))
    else input.receipt?.({ commands: [{ command: 'mock-work', exitCode: 0 }] })
  })
  await runtime.api.start(request({ employees: [employee('lead'), employee('worker')], coordination: { leadId: 'lead' } }))
  const result = await terminal(runtime)
  assert.equal(result.coordination?.tasks[0].status, 'failed')
  const reply = result.replies.find((item) => item.employeeId === 'worker')!
  assert.equal(reply.status, 'failed')
  assert.equal(reply.text, '')
  assert.equal(reply.receipt?.commands?.[0].command, 'mock-work')
  assert.equal(result.metrics?.workerCalls, 1)
})

test('task dependency and context reference validation reject malformed or unaccepted evidence', () => {
  const valid = request({
    task: { id: 'task', owner: 'worker', title: 'task', description: '', acceptance: 'done', dependency: { id: 'before', state: 'done' },
      dependencies: [{ id: 'before', state: 'done', acceptedRunId: 'accepted-run' }], review: 'fix failing test' },
    context: [{ author: 'worker', text: 'done', runId: 'accepted-run', replyId: 'reply' }]
  })
  validateRequest(valid)
  for (const dependencies of [[], [{ id: 'before', state: 'review' }], [{ id: 'task', state: 'done' }],
    [{ id: 'before', state: 'done' }, { id: 'before', state: 'done' }], [{ id: 'before', state: 'done', acceptedRunId: 2 }]])
    assert.throws(() => validateRequest({ ...valid, task: { ...valid.task!, dependencies } } as RunRequest))
  assert.throws(() => validateRequest({ ...valid, context: [{ author: 'worker', text: '', replyId: 'x'.repeat(151) }] }))
})
