import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import { createRunJournal, archiveContext } from '../src/main/runtime/run-journal'
import { assembleExecutionContext } from '../src/main/runtime/context'
import { compactContext, INPUT_CHARACTER_BUDGET, INPUT_TOKEN_ESTIMATE_BUDGET } from '../src/shared/context'
import type { RunRequest, RunSnapshot, RuntimeEmployee, RuntimeProvider } from '../src/shared/runtime'
import { execute as executeAdapter, type Execution } from '../src/main/runtime/adapters'
import { useCollaboration, refreshRun } from '../src/renderer/src/stores/collaboration'
import { createWorkspace, type Team } from '../src/renderer/src/lib/collaboration-data'
import { collaborationContext, historyForRetry } from '../src/renderer/src/lib/collaboration-context'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'

const providers = ['claude', 'codex', 'grok', 'gemini'] as const
const catalog = providers.map((id) => ({ id, auth: { signedIn: true }, models: [
  { id: `${id}-model`, name: id, efforts: ['low'], defaultEffort: 'low', isDefault: true }
] })) as RuntimeProvider[]
const employee = (provider = 'codex' as typeof providers[number], id = provider): RuntimeEmployee => ({
  id, name: `${provider}员工`, provider, role: '实际执行并核对交付', persona: '清楚说明事实', model: `${provider}-model`, effort: 'low'
})
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({
  id: 'run-test', workspaceId: 'space-test', prompt: '完成任务', goal: '可核验的协作',
  context: [], artifacts: [], employees: [employee()], ...patch
})
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await delay(5) }
  throw new Error('condition did not settle')
}
function fixture(t: TestContext, execute: (input: Execution) => Promise<void>, durable = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-core-'))
  const cwd = path.join(root, 'work')
  fs.mkdirSync(cwd)
  const journal = durable ? createRunJournal(path.join(root, 'runs')) : undefined
  const runtime = createRuntime({ directory: () => cwd, providers: async () => structuredClone(catalog), execute,
    skills: () => [], journal, archive: durable ? archiveContext : undefined })
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...runtime, root, cwd, journal }
}
function connectStore(t: TestContext, runtime: ReturnType<typeof fixture>, team: Team) {
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: {}, attachmentDrafts: {},
    taskSchedules: {}, connectionErrors: {}, stoppingRuns: {}, runtimeError: null })
  for (const method of ['start', 'run', 'cancel', 'permission'] as const) t.mock.method(runtimeClient, method, runtime.api[method])
  t.after(() => useCollaboration.setState({ taskSchedules: {}, runs: {} }))
}
function teamWithAllProviders() {
  const team = createWorkspace('project', 'claude', '跨厂商项目')
  team.members = providers.map((id, index) => ({ ...employee(id), isLead: index === 0 }))
  return team
}

test('four provider routes share attributed history and handoffs across turns and employee edits', async (t) => {
  const seen: Execution[] = []
  const runtime = fixture(t, async (input) => { seen.push(input); input.text(`RESULT-${input.employee.provider}`) }, true)
  const team = teamWithAllProviders()
  connectStore(t, runtime, team)
  useCollaboration.getState().setDraft(team.id, '请各位依次给出结果')
  const first = await useCollaboration.getState().send(team.id, 'all')
  await until(async () => (await runtime.api.run(first!)).status === 'completed')
  await refreshRun(first!)
  assert.deepEqual(seen.map((input) => input.employee.provider), [...providers])
  for (let i = 1; i < seen.length; i++) for (const earlier of providers.slice(0, i)) assert.match(seen[i].prompt, new RegExp(`RESULT-${earlier}`))
  const original = useCollaboration.getState().teams[0].members[0]
  useCollaboration.getState().saveEmployee(team.id, { ...original, name: '重新命名', provider: 'grok', model: 'grok-model' })
  useCollaboration.getState().setDraft(team.id, '请接续核对全部记录')
  const second = await useCollaboration.getState().send(team.id, 'codex')
  await until(async () => (await runtime.api.run(second!)).status === 'completed')
  await refreshRun(second!)
  const next = seen.at(-1)!
  for (const provider of providers) assert.match(next.prompt, new RegExp(`RESULT-${provider}`))
  assert.match(next.prompt, /claude员工/)
  assert.match(next.prompt, /"provider":"claude"/)
  const archive = JSON.parse(fs.readFileSync((await runtime.api.run(second!)).contextReport!.archivePath!, 'utf8'))
  assert.equal(archive.history.filter((item: any) => item.authorId !== 'you').length, 4)
  assert.equal(archive.handoffs[0].text, 'RESULT-codex')
})

test('retrying a later employee includes earlier same-turn replies and excludes the replaced branch', () => {
  const team = teamWithAllProviders()
  const message = (id: string, author: string, text: string) => ({ id, author, text, to: 'all', time: '', kind: 'message' as const, sample: false, runId: 'old-run' })
  const messages = [message('old', 'you', '早期约束'), message('source', 'you', '执行'),
    message('a', 'claude', '前序成果 MUST-KEEP'), message('b', 'codex', '被替换结果'), message('c', 'grok', '后序旧结果')]
  const history = historyForRetry(messages, 'source', 'b')
  assert.deepEqual(history.map((item) => item.id), ['old', 'a'])
  assert.deepEqual(historyForRetry(messages, 'source').map((item) => item.id), ['old'])
  const context = collaborationContext(team, undefined, history)
  assert.match(JSON.stringify(context), /MUST-KEEP/)
  assert.doesNotMatch(JSON.stringify(context), /被替换结果|后序旧结果/)
})

test('failed and cancelled partial work remains shared with explicit status', () => {
  const team = teamWithAllProviders()
  team.messages = [
    { id: 'partial', author: 'claude', authorName: '原作者', provider: 'claude', text: '已写入 draft.ts，测试失败', status: 'failed', to: 'all', time: '', kind: 'message', sample: false },
    { id: 'user', author: 'you', text: '必须保留原有接口', status: 'cancelled', to: 'all', time: '', kind: 'message', sample: false }
  ]
  const context = collaborationContext(team, undefined, team.messages)
  assert.equal(context.context.length, 2)
  assert.equal(context.context[0].status, 'failed')
  assert.equal(context.context[1].authorId, 'you')
})

test('follow-up turns receive runtime errors from persisted messages in both model input and archives', async (t) => {
  const error = 'workspace routing discovery timed out'
  const seen: Execution[] = []
  const runtime = fixture(t, async (input) => {
    seen.push(input)
    if (seen.length === 1) throw new Error(error)
    input.text(JSON.stringify({ action: 'ask', message: '已读取执行错误。' }))
  }, true)
  const team = createWorkspace('conversation', 'codex')
  connectStore(t, runtime, team)
  const leadId = team.members[0].id
  useCollaboration.getState().setDraft(team.id, '你好啊')
  const first = await useCollaboration.getState().send(team.id, leadId)
  await until(async () => (await runtime.api.run(first!)).status === 'failed')
  await refreshRun(first!)
  const saved = JSON.parse(JSON.stringify(useCollaboration.getState().teams[0])) as Team
  assert.equal(saved.messages.find((message) => message.author === leadId)!.error, error)
  assert.equal(saved.messages.find((message) => message.author === leadId)!.text, '')
  useCollaboration.setState({ teams: [saved] })
  for (const [prompt, included] of [['怎么回事', 2], ['为什么会失败呢', 4]] as const) {
    useCollaboration.getState().setDraft(team.id, prompt)
    const next = await useCollaboration.getState().send(team.id, leadId)
    await until(async () => (await runtime.api.run(next!)).status === 'completed')
    await refreshRun(next!)
    assert.ok(seen.at(-1)!.prompt.includes(error), 'the model must receive the error displayed in chat')
    const snapshot = await runtime.api.run(next!)
    assert.equal(snapshot.contextReport!.included, included)
    assert.equal(snapshot.contextReport!.omitted, 0)
    assert.equal(snapshot.contextReport!.compressed, 0)
    const archive = JSON.parse(fs.readFileSync(snapshot.contextReport!.archivePath!, 'utf8'))
    const failed = archive.history.find((message: any) => message.authorId === leadId && message.status === 'failed')
    assert.ok(failed.text.includes(error), 'the full context archive must retain the runtime error')
    assert.equal(archive.history[0].authorId, 'you')
    assert.ok(archive.history[0].text.startsWith('你好啊'))
    assert.ok(archive.history[0].text.includes(error), 'errors attached to user messages must also be shared')
  }
})

test('queued turns receive predecessor failures alongside partial output', async (t) => {
  const error = 'workspace routing discovery timed out'
  const seen: Execution[] = []
  let release!: () => void
  const runtime = fixture(t, async (input) => {
    seen.push(input)
    if (seen.length === 1) {
      input.text('部分结果')
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error(error)
    }
    input.text('已读取上轮失败原因。')
  }, true)
  await runtime.api.start(request({ id: 'failed-predecessor', queue: true }))
  await until(() => !!release)
  assert.equal((await runtime.api.start(request({ id: 'queued-follow-up', queue: true }))).status, 'queued')
  release()
  await until(async () => (await runtime.api.run('queued-follow-up')).status === 'completed')
  assert.equal((await runtime.api.run('failed-predecessor')).status, 'failed')
  assert.ok(seen[1].prompt.includes(error))
  assert.match(seen[1].prompt, /部分结果/)
  const snapshot = await runtime.api.run('queued-follow-up')
  const archive = JSON.parse(fs.readFileSync(snapshot.contextReport!.archivePath!, 'utf8'))
  assert.equal(archive.history[0].status, 'failed')
  assert.ok(archive.history[0].text.includes(error))
})

test('compression preserves decisions, attributed excerpts, recent input and one unified budget', () => {
  const context: RunRequest['context'] = [
    { id: 'decision', author: '用户', authorId: 'you', kind: 'decision', text: '必须保持接口 CONTRACT-42，不得改动付款模块。' },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `m-${i}`, author: 'employee', authorId: 'grok', provider: 'grok' as const, text: `起始 ${i}\n${'长代码'.repeat(2000)}\n测试失败：FAIL-${i}\n结尾 ${i}` }))
  ]
  const compacted = compactContext(context, [{ name: '验收标准', content: '必须通过已存在的全部测试。' }], 18000)
  assert.ok(JSON.stringify({ history: compacted.history, artifacts: compacted.artifacts }).length <= 18000)
  assert.match(JSON.stringify(compacted.history), /CONTRACT-42/)
  assert.match(JSON.stringify(compacted.history), /结尾 99/)
  assert.ok(compacted.report.compressed > 0)
  assert.ok(compacted.report.omitted > 0)
  const prompt = '当前请求不得截断 CURRENT-REQUEST'
  const assembled = assembleExecutionContext(request({ prompt, context }), '固定人格\n' + '中文约束'.repeat(2000), [
    { employeeId: 'previous', provider: 'claude', name: 'Claude', text: '开始 HEAD\n' + '"'.repeat(100000) + '\n结束 TAIL', images: [], status: 'completed' }
  ], '/workspace/context.json')
  assert.match(assembled.prompt, /CURRENT-REQUEST/)
  assert.match(assembled.prompt, /HEAD/)
  assert.match(assembled.prompt, /TAIL/)
  assert.ok(assembled.report.inputCharacters! <= INPUT_CHARACTER_BUDGET)
  assert.ok(assembled.report.estimatedTokens! <= INPUT_TOKEN_ESTIMATE_BUDGET)
  assert.ok(assembled.trimmed)
})

test('queued turns wait for cleanup, receive preceding results, and can be cancelled without execution', async (t) => {
  let release!: () => void
  const prompts: string[] = []
  const runtime = fixture(t, async (input) => {
    prompts.push(input.prompt)
    if (prompts.length === 1) await new Promise<void>((resolve) => { release = resolve })
    input.text(prompts.length === 1 ? 'PREVIOUS-DELIVERABLE' : 'NEXT-RESULT')
  })
  await runtime.api.start(request({ id: 'first', queue: true }))
  await until(() => !!release)
  assert.equal((await runtime.api.start(request({ id: 'second', queue: true }))).status, 'queued')
  assert.equal((await runtime.api.start(request({ id: 'third', queue: true }))).status, 'queued')
  assert.equal((await runtime.api.cancel('third')).status, 'cancelled')
  assert.equal(prompts.length, 1)
  release()
  await until(async () => (await runtime.api.run('second')).status === 'completed')
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /PREVIOUS-DELIVERABLE/)
  assert.equal((await runtime.api.run('third')).replies.length, 0)
})

test('global execution limit queues excess work and protects nested directories', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-queue-'))
  const started: string[] = []
  const releases = new Map<string, () => void>()
  const runtime = createRuntime({ providers: async () => catalog, skills: () => [],
    directory: (id) => { const dir = path.join(root, id === 'nested' ? 'one/child' : id!); fs.mkdirSync(dir, { recursive: true }); return dir },
    execute: async (input) => {
      const id = path.basename(input.cwd)
      started.push(id)
      await new Promise<void>((resolve) => { releases.set(id, resolve); input.signal.addEventListener('abort', () => resolve(), { once: true }) })
      input.text('finished')
    } })
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }) })
  for (const id of ['one', 'two', 'three', 'four', 'five', 'nested']) await runtime.api.start(request({ id, workspaceId: id, queue: true }))
  await until(() => started.length === 4)
  assert.equal((await runtime.api.run('five')).status, 'queued')
  assert.equal((await runtime.api.run('nested')).status, 'queued')
  releases.get('two')!()
  await until(() => started.includes('five'))
  assert.ok(!started.includes('child'))
  releases.get('one')!()
  await until(() => started.includes('child'))
})

test('concurrent duplicate starts are idempotent even while their receipt is being saved', async (t) => {
  let release!: () => void, calls = 0, saves = 0
  const runtime = createRuntime({ directory: () => process.cwd(), providers: async () => catalog, skills: () => [],
    journal: { load: async () => null, save: async () => { if (++saves === 1) await new Promise<void>((resolve) => { release = resolve }) } },
    execute: async () => { calls++ } })
  t.after(() => runtime.close())
  const first = runtime.api.start(request())
  await until(() => !!release)
  const duplicate = runtime.api.start(request())
  await assert.rejects(runtime.api.start(request({ prompt: 'changed' })), /冲突/)
  release()
  await Promise.all([first, duplicate])
  await until(async () => (await runtime.api.run('run-test')).status === 'completed')
  assert.equal(calls, 1)
})

test('completed runs and idempotency receipts survive a runtime restart', async (t) => {
  let calls = 0
  const first = fixture(t, async (input) => { calls++; input.text('DURABLE-RESULT') }, true)
  const original = request()
  await first.api.start(original)
  await until(async () => (await first.api.run(original.id)).status === 'completed')
  await first.close()
  const restarted = createRuntime({ directory: () => first.cwd, providers: async () => catalog, skills: () => [],
    journal: first.journal, execute: async () => { calls++ } })
  t.after(() => restarted.close())
  assert.equal((await restarted.api.run(original.id)).replies[0].text, 'DURABLE-RESULT')
  assert.equal((await restarted.api.start(original)).status, 'completed')
  await assert.rejects(restarted.api.start({ ...original, prompt: 'changed' }), /冲突/)
  assert.equal(calls, 1)
})

test('interrupted runs restore partial results, revoke permissions and never replay automatically', async (t) => {
  let calls = 0
  const runtime = fixture(t, async () => { calls++ }, true)
  const original = request()
  await runtime.journal!.save({ version: 1, fingerprint: createHash('sha256').update(JSON.stringify(original)).digest('hex'), snapshot: {
    id: original.id, workspaceId: original.workspaceId, revision: 10, status: 'needs_permission', createdAt: new Date().toISOString(), contextTrimmed: false,
    replies: [{ employeeId: 'codex', provider: 'codex', model: 'codex-model', text: 'PARTIAL-RESULT', status: 'running' }],
    permissions: [{ id: 'old-permission', employeeId: 'codex', title: 'write', detail: '', options: [{ id: 'allow', label: '允许' }] }]
  } })
  const restored = await runtime.api.run(original.id)
  assert.equal(restored.status, 'failed')
  assert.equal(restored.interrupted, true)
  assert.equal(restored.replies[0].text, 'PARTIAL-RESULT')
  assert.equal(restored.permissions.length, 0)
  await assert.rejects(runtime.api.permission(original.id, 'old-permission', 'allow'), /失效/)
  assert.equal((await runtime.api.start(original)).status, 'failed')
  assert.equal(calls, 0)
})

test('unreadable receipts and storage failure cannot cause new model work', async (t) => {
  let calls = 0
  const runtime = fixture(t, async () => { calls++ }, true)
  fs.mkdirSync(path.join(runtime.root, 'runs'), { recursive: true })
  fs.writeFileSync(path.join(runtime.root, 'runs', 'run-test.json'), '{broken')
  await assert.rejects(runtime.api.start(request()), /备份|无法读取/)
  const failing = createRuntime({ directory: () => runtime.cwd, providers: async () => catalog, skills: () => [],
    journal: { load: async () => null, save: async () => { throw new Error('disk full') } }, execute: async () => { calls++ } })
  await assert.rejects(failing.api.start(request()), /未调用模型/)
  await failing.close().catch(() => {})
  assert.equal(calls, 0)
})

test('permission waits pause the employee clock and each next employee gets a fresh budget', async (t) => {
  let first = true
  const runtime = createRuntime({ directory: () => process.cwd(), providers: async () => catalog, skills: () => [], executionMs: 100, permissionMs: 1000,
    execute: async (input) => {
      if (first) { first = false; await input.permission('确认', '', [{ id: 'allow', label: '允许' }]) }
      await delay(40)
      input.signal.throwIfAborted()
      input.text('done')
    } })
  t.after(() => runtime.close())
  await runtime.api.start(request({ employees: [employee('claude'), employee('grok')] }))
  await until(async () => (await runtime.api.run('run-test')).status === 'needs_permission')
  await delay(160)
  const waiting = await runtime.api.run('run-test')
  assert.equal(waiting.status, 'needs_permission')
  await runtime.api.permission('run-test', waiting.permissions[0].id, 'allow')
  await until(async () => (await runtime.api.run('run-test')).status === 'completed')
  assert.equal((await runtime.api.run('run-test')).replies.length, 2)
})

test('late callbacks from a finished employee cannot rewrite results or create stale permissions', async (t) => {
  let previous!: Execution
  const runtime = fixture(t, async (input) => {
    if (!previous) { previous = input; input.text('FINAL-FIRST'); return }
    previous.text('LATE-CORRUPTION')
    await assert.rejects(previous.permission('stale', '', [{ id: 'allow', label: 'allow' }]), /停止/)
    input.text('FINAL-SECOND')
  })
  await runtime.api.start(request({ employees: [employee('claude'), employee('grok')] }))
  await until(async () => (await runtime.api.run('run-test')).status === 'completed')
  const result = await runtime.api.run('run-test')
  assert.equal(result.replies[0].text, 'FINAL-FIRST')
  assert.equal(result.permissions.length, 0)
})

test('runtime rejects task owner and unaccepted dependency mismatches before execution', () => {
  const task = { id: 'task', title: '实现', description: '', owner: 'codex', acceptance: '', dependency: null }
  validateRequest(request({ task }))
  assert.throws(() => validateRequest(request({ task: { ...task, owner: 'claude' } })), /负责人/)
  assert.throws(() => validateRequest(request({ task: { ...task, dependency: { id: 'prior', state: 'review' } } })), /验收/)
})

test('task scheduling runs independent work, waits for user acceptance, then hands results to dependent providers', async (t) => {
  const seen: Execution[] = []
  const runtime = fixture(t, async (input) => { seen.push(input); input.text(`DELIVERY-${input.employee.provider}`) })
  const team = teamWithAllProviders()
  const task = (id: string, owner: string, dependency: string | null) => ({ id, owner, dependency, title: id, description: '交付与验证', acceptance: '测试通过', state: 'ready' as const })
  team.tasks = [task('design', 'claude', null), task('implementation', 'codex', 'design'), task('independent', 'grok', null), task('review', 'gemini', 'implementation')]
  connectStore(t, runtime, team)
  useCollaboration.getState().setDraft(team.id, '用户尚未发送的草稿')
  useCollaboration.getState().startTaskSchedule(team.id)
  await until(() => useCollaboration.getState().taskSchedules[team.id]?.status === 'waiting_review')
  assert.deepEqual(seen.map((item) => item.employee.provider), ['claude', 'grok'])
  assert.equal(useCollaboration.getState().drafts[team.id], '用户尚未发送的草稿')
  const design = useCollaboration.getState().teams[0].tasks.find((item) => item.id === 'design')!
  assert.equal(design.state, 'review')
  assert.ok(design.resultRunId)
  useCollaboration.getState().saveTask(team.id, { ...design, state: 'done' })
  await until(() => seen.length === 3 && useCollaboration.getState().teams[0].tasks[1].state === 'review')
  assert.match(seen[2].prompt, /DELIVERY-claude/)
  assert.match(seen[2].prompt, /已验收前置任务/)
  const implementation = useCollaboration.getState().teams[0].tasks[1]
  useCollaboration.getState().saveTask(team.id, { ...implementation, state: 'done' })
  await until(() => useCollaboration.getState().taskSchedules[team.id]?.status === 'completed')
  assert.deepEqual(seen.map((item) => item.employee.provider), [...providers.slice(0, 1), 'grok', 'codex', 'gemini'])
  assert.equal(useCollaboration.getState().teams[0].tasks[3].state, 'review')
  assert.equal(useCollaboration.getState().teams[0].tasks[0].acceptedRunId, design.resultRunId)
})

test('task failure stops scheduling without automatic retry and manual execution preserves composer attachments', async (t) => {
  let calls = 0
  const runtime = fixture(t, async (input) => { calls++; input.text('PARTIAL'); throw new Error('需要修复的真实错误') })
  const team = teamWithAllProviders()
  team.tasks = ['one', 'two'].map((id) => ({ id, title: id, owner: 'claude', description: '', acceptance: '', dependency: null, state: 'ready' }))
  connectStore(t, runtime, team)
  const attachments = [{ id: 'draft-file', name: 'draft.txt', path: '/draft.txt', size: 10, mime: 'text/plain' }]
  useCollaboration.setState({ drafts: { [team.id]: '保留草稿' }, attachmentDrafts: { [team.id]: attachments } })
  useCollaboration.getState().startTaskSchedule(team.id)
  await until(() => useCollaboration.getState().taskSchedules[team.id]?.status === 'failed')
  await delay(40)
  assert.equal(calls, 1)
  assert.equal(useCollaboration.getState().drafts[team.id], '保留草稿')
  assert.deepEqual(useCollaboration.getState().attachmentDrafts[team.id], attachments)
  assert.equal(useCollaboration.getState().teams[0].tasks[0].state, 'ready')
})

test('reloaded task schedules require an explicit resume instead of silently launching new model calls', () => {
  const team = teamWithAllProviders()
  const current = useCollaboration.getState()
  const restored = useCollaboration.persist.getOptions().merge!({ teams: [team], activeTeamId: team.id,
    taskSchedules: { [team.id]: { status: 'running', remaining: ['one'], runId: 'old', taskId: 'one' } }
  }, current)
  assert.equal(restored.taskSchedules[team.id].status, 'paused')
  assert.equal(restored.taskSchedules[team.id].runId, 'old')
})

test('pause during start acknowledgement cancels work and explicit resume reruns only the unfinished task', async (t) => {
  let release!: () => void
  let calls = 0
  const runtime = fixture(t, async (input) => {
    calls++
    if (calls === 1) await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    input.signal.throwIfAborted()
    input.text('RESUMED-RESULT')
  })
  const team = teamWithAllProviders()
  team.tasks = [{ id: 'one', owner: 'claude', title: 'one', description: '', acceptance: '', dependency: null, state: 'ready' }]
  connectStore(t, runtime, team)
  t.mock.method(runtimeClient, 'start', async (req: RunRequest) => {
    const result = await runtime.api.start(req)
    await new Promise<void>((resolve) => { release = resolve })
    return result
  })
  useCollaboration.getState().startTaskSchedule(team.id)
  await until(() => calls === 1 && !!release)
  await useCollaboration.getState().pauseTaskSchedule(team.id)
  release()
  await until(() => useCollaboration.getState().runs[useCollaboration.getState().taskSchedules[team.id].runId!]?.status === 'cancelled')
  assert.equal(useCollaboration.getState().taskSchedules[team.id].status, 'paused')
  await delay(25)
  assert.equal(calls, 1)
  t.mock.method(runtimeClient, 'start', runtime.api.start)
  useCollaboration.getState().startTaskSchedule(team.id)
  await until(() => useCollaboration.getState().taskSchedules[team.id].status === 'completed')
  assert.equal(calls, 2)
})

test('changing the scope of an accepted task invalidates its previous result and acceptance', async (t) => {
  const runtime = fixture(t, async () => {})
  const team = teamWithAllProviders()
  team.tasks = [
    { id: 'one', owner: 'claude', title: 'one', description: '', acceptance: '原标准', dependency: null, state: 'done', resultRunId: 'old', acceptedRunId: 'old' },
    { id: 'two', owner: 'codex', title: 'two', description: '', acceptance: '', dependency: 'one', state: 'done', resultRunId: 'second', acceptedRunId: 'second' },
    { id: 'three', owner: 'gemini', title: 'three', description: '', acceptance: '', dependency: 'two', state: 'review', resultRunId: 'third' }
  ]
  connectStore(t, runtime, team)
  assert.ok(useCollaboration.getState().saveTask(team.id, { ...team.tasks[0], acceptance: '新标准' }))
  const updated = useCollaboration.getState().teams[0].tasks[0]
  assert.equal(updated.state, 'ready')
  assert.equal(updated.resultRunId, undefined)
  assert.equal(updated.acceptedRunId, undefined)
  for (const downstream of useCollaboration.getState().teams[0].tasks.slice(1)) {
    assert.equal(downstream.state, 'ready')
    assert.equal(downstream.resultRunId, undefined)
    assert.equal(downstream.acceptedRunId, undefined)
  }
})

test('a valid journal backup repairs a damaged primary without permitting replay', async (t) => {
  const runtime = fixture(t, async (input) => input.text('SAVED'), true)
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('run-test')).status === 'completed')
  await runtime.close()
  const file = path.join(runtime.root, 'runs', 'run-test.json')
  fs.copyFileSync(file, `${file}.bak`)
  fs.writeFileSync(file, '{broken')
  const recovered = await runtime.journal!.load('run-test')
  assert.equal(recovered!.snapshot.replies[0].text, 'SAVED')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).snapshot.status, 'completed')
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).snapshot.status, 'completed')
})

function adapterInput(provider: typeof providers[number]) {
  const output: string[] = []
  const sessions: string[] = []
  const permissions: string[] = []
  const input: Execution = { employee: employee(provider), cwd: process.cwd(), prompt: 'SHARED-HISTORY', instructions: 'ROLE-AND-TASK',
    signal: new AbortController().signal, text: (text) => output.push(text), session: (id) => sessions.push(id),
    permission: async (title, _detail, options) => { permissions.push(title); return options[0].id } }
  return { input, output, sessions, permissions }
}

test('Claude adapter deduplicates partial text, isolates child output and requires a successful result', async () => {
  let options: any
  let closed = false
  const messages = [
    { type: 'stream_event', parent_tool_use_id: 'child', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CHILD-ONLY' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PRIMARY' } } },
    { type: 'assistant', session_id: 'claude-session', message: { content: [{ type: 'text', text: 'PRIMARY' }] } },
    { type: 'result', is_error: false, session_id: 'claude-session' }
  ]
  const dependencies = { cliOutput: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), claudeEntry: () => 'fixture',
    query: (args: any) => { options = args; return { async *[Symbol.asyncIterator]() { yield* messages }, close: () => { closed = true } } } } as any
  const successful = adapterInput('claude')
  await executeAdapter(successful.input, dependencies)
  assert.equal(successful.output.join(''), 'PRIMARY')
  assert.equal(options.prompt, 'SHARED-HISTORY')
  assert.equal(options.options.systemPrompt.append, 'ROLE-AND-TASK')
  assert.equal(successful.sessions.at(-1), 'claude-session')
  assert.equal((await options.options.canUseTool('Write', { file_path: 'result.md' })).behavior, 'allow')
  assert.equal(successful.permissions.length, 1)
  assert.ok(closed)
  messages.pop()
  await assert.rejects(executeAdapter(adapterInput('claude').input, dependencies), /完成确认/)
  messages.push({ type: 'result', is_error: true, errors: ['vendor failure'] } as any)
  await assert.rejects(executeAdapter(adapterInput('claude').input, dependencies), /vendor failure/)
})

class FixtureRpc extends EventEmitter {
  calls: { method: string; params: any; timeout?: number }[] = []
  responses: any[] = []
  stopped = false
  constructor(private handler: (method: string, params: any, rpc: FixtureRpc) => unknown) { super() }
  async request(method: string, params: any, timeout?: number) { this.calls.push({ method, params, timeout }); return this.handler(method, params, this) }
  respond(id: string, result: unknown) { this.responses.push({ id, result }) }
  reject(id: string, error: unknown) { this.responses.push({ id, error }) }
  close() { this.emit('closed', new Error('connection closed')) }
  async stop() { this.stopped = true }
}

test('Codex adapter passes unified context, filters foreign sessions and waits for a completed turn', async () => {
  let status = 'completed'
  const rpc = new FixtureRpc((method, _params, peer) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'thread/start') return { thread: { id: 'own-thread' } }
    if (method === 'turn/start') {
      peer.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'item', delta: 'FOREIGN' } })
      peer.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'own-thread', itemId: 'item', delta: 'CODEX-RESULT' } })
      peer.emit('notification', { method: 'item/completed', params: { threadId: 'own-thread', item: { id: 'item', type: 'agentMessage', text: 'CODEX-RESULT' } } })
      peer.emit('request', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'test', itemId: 'tool' } })
      peer.emit('notification', { method: 'turn/completed', params: { threadId: 'own-thread', turn: { status } } })
      return {}
    }
    return {}
  })
  const dependencies = { rpcFor: async () => ({ rpc }) } as any
  const successful = adapterInput('codex')
  await executeAdapter(successful.input, dependencies)
  assert.equal(successful.output.join(''), 'CODEX-RESULT')
  assert.deepEqual(successful.sessions, ['own-thread'])
  assert.equal(rpc.calls.find((call) => call.method === 'thread/start')!.params.developerInstructions, 'ROLE-AND-TASK')
  assert.equal(rpc.calls.find((call) => call.method === 'turn/start')!.params.input[0].text, 'SHARED-HISTORY')
  assert.equal(rpc.responses[0].result.decision, 'accept')
  assert.ok(rpc.stopped)
  rpc.removeAllListeners()
  status = 'interrupted'
  await assert.rejects(executeAdapter(adapterInput('codex').input, dependencies), /停止/)
})

test('Grok and Gemini ACP adapters carry identical context and reject missing or incomplete completion signals', async () => {
  for (const provider of ['grok', 'gemini'] as const) {
    for (const stopReason of ['end_turn', 'max_tokens', undefined]) {
      const rpc = new FixtureRpc((method, _params, peer) => {
        if (method === 'session/new') return { sessionId: 'own-session' }
        if (method === 'session/prompt') {
          for (const sessionId of ['other-session', 'own-session']) peer.emit('notification', { method: 'session/update', params: {
            sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sessionId } }
          } })
          return stopReason ? { stopReason } : undefined
        }
        return {}
      })
      const dependencies = { rpcFor: async () => ({ rpc }), readSubscriptionAuth: () => ({ signedIn: true }),
        geminiAccount: () => ({ canAuthenticate: true, methodId: 'oauth-personal' }) } as any
      const current = adapterInput(provider)
      if (stopReason === 'end_turn') await executeAdapter(current.input, dependencies)
      else await assert.rejects(executeAdapter(current.input, dependencies), /上限|完成确认/)
      assert.equal(current.output.join(''), 'own-session')
      const prompt = rpc.calls.find((call) => call.method === 'session/prompt')!
      assert.equal(prompt.params.prompt[0].text, 'ROLE-AND-TASK\n\nSHARED-HISTORY')
      assert.equal(prompt.timeout, 0)
      assert.ok(rpc.stopped)
    }
  }
})
