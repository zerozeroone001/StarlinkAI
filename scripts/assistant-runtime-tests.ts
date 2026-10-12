import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import { execute, type Execution } from '../src/main/runtime/adapters'
import { parseDecision } from '../src/main/runtime/coordinator'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'
import type { AssistantSnapshot } from '../src/shared/assistant'

const employee = (id: string, provider: 'codex' | 'claude' | 'grok' | 'gemini' = 'codex') =>
  ({ id, name: id, provider, role: 'test', persona: '' })
const catalog = [{ id: 'codex', auth: { signedIn: true }, models: [{ id: 'test', name: 'Test', efforts: [], isDefault: true }] }] as RuntimeProvider[]
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({
  id: 'assistant-run', workspaceId: 'assistant-space', prompt: 'test', goal: '',
  employees: [employee('lead'), employee('worker')], context: [], artifacts: [],
  coordination: { leadId: 'lead' }, ...patch
})
const task = (title: string, employeeId = 'worker') => ({ employeeId, title, description: title, acceptance: 'done', dependsOn: [] })
const assistant: AssistantSnapshot = {
  profile: { scopeId: 'project-one', name: 'PRIVATE-NAME', persona: 'PRIVATE-PERSONA', addressing: '', style: 'warm', updatedAt: '' },
  memories: [{ id: 'memory-one', kind: 'preference', content: 'PRIVATE-MEMORY', createdAt: '', updatedAt: '' }], commitments: [], revision: 0
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5) }
  throw new Error('test did not settle')
}
function fixture(t: TestContext, implementation: (input: Execution) => Promise<void>, extra: Record<string, unknown> = {}) {
  const runtime = createRuntime({ directory: () => process.cwd(), providers: async () => catalog, skills: () => [], execute: implementation, ...extra })
  t.after(() => runtime.close())
  return runtime
}
async function terminal(runtime: ReturnType<typeof createRuntime>, id = 'assistant-run') {
  await until(async () => !['running', 'queued', 'needs_permission'].includes((await runtime.api.run(id)).status))
  return runtime.api.run(id)
}

test('conversation input is single-assistant, text-only and bounds private history', () => {
  const valid = request({ employees: [employee('lead')], coordination: undefined, interaction: 'conversation', assistantScopeId: 'project-one' })
  validateRequest(valid)
  for (const patch of [
    { employees: [employee('lead'), employee('worker')] }, { coordination: { leadId: 'lead' } },
    { assistantScopeId: '../private' }, { privateContext: Array(201).fill({ author: 'user', text: 'x' }) },
    { interaction: 'unknown' }
  ]) assert.throws(() => validateRequest({ ...valid, ...patch } as RunRequest))
})

test('an invalid item leaves the entire delegated batch unstarted and uncounted', async (t) => {
  let rounds = 0, workerCalls = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id !== 'lead') { workerCalls++; return }
    if (++rounds === 1) input.text(JSON.stringify({ action: 'delegate_parallel', tasks: [task('valid'), task('invalid', 'missing')], message: 'batch' }))
    else input.text(JSON.stringify({ action: 'finish', message: 'corrected' }))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(workerCalls, 0)
  assert.deepEqual(snapshot.coordination?.tasks, [])
})

test('batch workers share a directory sequentially and each receives an independent deadline', async (t) => {
  let rounds = 0, active = 0, peak = 0, workerCalls = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'lead') {
      input.text(JSON.stringify(++rounds === 1
        ? { action: 'delegate_parallel', tasks: [task('slow'), task('next')], message: 'batch' }
        : { action: 'blocked', message: 'first worker timed out' }))
      return
    }
    active++; peak = Math.max(peak, active); workerCalls++
    try {
      if (workerCalls === 1) await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
      else { await delay(15); input.text('second completed') }
    } finally { active-- }
  }, { executionMs: 60 })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(peak, 1)
  assert.equal(workerCalls, 2)
  assert.equal(snapshot.coordination?.tasks[0].status, 'failed')
  assert.match(snapshot.coordination?.tasks[0].error || '', /超时/)
  assert.equal(snapshot.coordination?.tasks[1].status, 'review')
})

test('a worker resumes its own deadline only after all its permissions are answered', async (t) => {
  const runtime = fixture(t, async (input) => {
    await Promise.all(['first', 'second'].map((title) => input.permission(title, '', [{ id: 'allow', label: 'Allow' }])))
    await delay(20)
    input.text('done')
  }, { executionMs: 60, permissionMs: 500 })
  await runtime.api.start(request({ employees: [employee('worker')], coordination: undefined }))
  await until(async () => (await runtime.api.run('assistant-run')).permissions.length === 2)
  const waiting = await runtime.api.run('assistant-run')
  await runtime.api.permission(waiting.id, waiting.permissions[0].id, 'allow')
  await delay(90)
  assert.equal((await runtime.api.run(waiting.id)).status, 'needs_permission')
  await runtime.api.permission(waiting.id, waiting.permissions[1].id, 'allow')
  assert.equal((await terminal(runtime)).status, 'completed')
})

test('conversation can accompany same-directory work but duplicate conversations remain serialized', async (t) => {
  const inputs: Execution[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const runtime = fixture(t, async (input) => {
    inputs.push(input)
    await Promise.race([gate, new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))])
    input.text(input.conversationOnly ? JSON.stringify({ action: 'finish', message: 'done' }) : 'done')
  })
  t.after(release)
  await runtime.api.start(request({ id: 'work', employees: [employee('worker')], coordination: undefined }))
  await runtime.api.start(request({ id: 'chat', employees: [employee('lead')], coordination: undefined, interaction: 'conversation' }))
  await until(async () => inputs.length === 2)
  assert.equal(inputs.filter((input) => input.conversationOnly).length, 1)
  await assert.rejects(runtime.api.start(request({ id: 'chat-two', employees: [employee('lead')], coordination: undefined, interaction: 'conversation' })), /已有执行/)
  await assert.rejects(runtime.api.start(request({ id: 'work-two', employees: [employee('worker')], coordination: undefined })), /已有执行/)
  release()
  assert.equal((await terminal(runtime, 'chat')).status, 'completed')
  assert.equal((await terminal(runtime, 'work')).status, 'completed')
})

test('queued handoffs preserve assistant privacy, exact scope identity and the private-history bound', async (t) => {
  for (const destination of ['employee', 'same-scope', 'other-scope'] as const) {
    let release!: () => void, sourceRounds = 0, sourceStarted = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    let targetInput: Execution | undefined
    const runtime = fixture(t, async (input) => {
      if (input.employee.id === 'worker') { input.text('PUBLIC-WORKER-RESULT'); return }
      if (input.employee.id === 'target') {
        targetInput = input
        input.text(destination === 'employee' ? 'done' : JSON.stringify({ action: 'finish', message: 'done' }))
        return
      }
      sourceRounds++
      if (sourceRounds === 1) {
        sourceStarted = true
        await Promise.race([gate, new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))])
        input.text(JSON.stringify({ action: 'delegate', ...task('public task'), message: 'PRIVATE-PLAN' }))
      } else if (sourceRounds === 2) {
        const state = await runtime.api.run('source')
        input.text(JSON.stringify({ action: 'review', taskId: state.coordination!.tasks[0].id, accepted: true, evidence: 'public test', message: 'PRIVATE-REVIEW' }))
      } else input.text(JSON.stringify({ action: 'finish', message: 'PRIVATE-FINISH' }))
    })
    t.after(release)
    await runtime.api.start(request({ id: 'source', assistantScopeId: 'scope-one', prompt: 'PRIVATE-SOURCE-PROMPT' }))
    await until(async () => sourceStarted)
    await runtime.api.start(request({
      id: 'target', queue: true, employees: [employee('target')],
      coordination: destination === 'employee' ? undefined : { leadId: 'target' },
      assistantScopeId: destination === 'employee' ? undefined : destination === 'same-scope' ? 'scope-one' : 'scope-two',
      privateContext: destination === 'same-scope' ? Array.from({ length: 200 }, (_, index) => ({ author: 'user', text: `old-private-${index}` })) : undefined
    }))
    release()
    const source = await terminal(runtime, 'source')
    const target = await terminal(runtime, 'target')
    assert.equal(source.status, 'completed')
    assert.equal(source.assistantScopeId, 'scope-one')
    assert.equal(target.status, 'completed')
    assert.ok(targetInput)
    assert.match(targetInput.prompt, /PUBLIC-WORKER-RESULT/)
    if (destination === 'same-scope') {
      assert.match(targetInput.prompt, /PRIVATE-FINISH/)
      assert.equal(target.contextReport?.messages, 201, '200 private records plus one public worker receipt')
      assert.equal(target.contextTrimmed, true)
    } else assert.doesNotMatch(targetInput.prompt + targetInput.instructions, /PRIVATE-/)
  }
})

test('only the lead receives private profile/history; workers and their archives get the delegated task', async (t) => {
  const inputs: Execution[] = [], archives: RunRequest[] = []
  let rounds = 0
  const runtime = fixture(t, async (input) => {
    inputs.push(input)
    if (input.employee.id === 'lead') {
      input.text(JSON.stringify(++rounds === 1
        ? { action: 'delegate', ...task('public task'), message: 'PRIVATE-LEAD-COMMENT' }
        : { action: 'blocked', message: 'test complete' }))
    } else input.text('public result')
  }, { assistant: async () => assistant, archive: async (_cwd: string, value: RunRequest) => { archives.push(structuredClone(value)); return undefined } })
  await runtime.api.start(request({ assistantScopeId: 'project-one', prompt: 'PRIVATE-ORIGINAL-PROMPT', privateContext: [{ author: 'user', text: 'PRIVATE-HISTORY' }] }))
  await terminal(runtime)
  const lead = inputs.find((input) => input.employee.id === 'lead')!
  const worker = inputs.find((input) => input.employee.id === 'worker')!
  assert.equal(lead.employee.name, 'PRIVATE-NAME')
  assert.equal(lead.employee.persona, 'PRIVATE-PERSONA')
  assert.match(lead.instructions, /PRIVATE-MEMORY/)
  assert.match(lead.prompt, /PRIVATE-HISTORY/)
  assert.doesNotMatch(worker.instructions + worker.prompt, /PRIVATE-/)
  const publicArchive = archives.find((value) => !value.assistantScopeId)!
  assert.ok(publicArchive)
  assert.doesNotMatch(JSON.stringify(publicArchive), /PRIVATE-/)
})

test('an untouched assistant profile preserves the existing lead identity in work and conversation', async (t) => {
  const defaultProfile: AssistantSnapshot = {
    ...assistant,
    profile: { ...assistant.profile, name: '主agent', persona: '', updatedAt: new Date(0).toISOString() }
  }
  for (const interaction of [undefined, 'conversation'] as const) {
    const runtime = fixture(t, async (input) => {
      assert.equal(input.employee.name, 'Existing assistant')
      assert.equal(input.employee.persona, 'Existing persona')
      assert.match(input.instructions, /助理名字："Existing assistant"/)
      assert.match(input.instructions, /人格设定："Existing persona"/)
      input.text(JSON.stringify({ action: 'finish', message: 'hello' }))
    }, { assistant: async () => defaultProfile })
    await runtime.api.start(request({
      employees: [{ ...employee('lead'), name: 'Existing assistant', persona: 'Existing persona' }],
      assistantScopeId: 'project-one', interaction,
      coordination: interaction ? undefined : { leadId: 'lead' }
    }))
    const snapshot = await terminal(runtime)
    assert.equal(snapshot.status, 'completed')
    assert.equal(snapshot.replies[0].employeeName, 'Existing assistant')
  }
  assert.equal(defaultProfile.profile.name, '主agent', 'effective profile must not mutate the stored default')
})

test('both assistant protocols receive current ISO, local timezone and local time for relative reminders', async (t) => {
  const started = Date.now()
  for (const interaction of [undefined, 'conversation'] as const) {
    const runtime = fixture(t, async (input) => {
      const match = input.instructions.match(/宿主当前时间：(\{[^\n]+\})。相对日期/)
      assert.ok(match)
      const clock = JSON.parse(match[1])
      assert.ok(Date.parse(clock.iso) >= started && Date.parse(clock.iso) <= Date.now())
      assert.equal(clock.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
      assert.equal(clock.localTime, new Intl.DateTimeFormat('zh-CN', {
        timeZone: clock.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(new Date(clock.iso)))
      assert.match(input.instructions, /相对日期必须依据宿主提供的当前时间与时区计算/)
      input.text(JSON.stringify({ action: 'ask', message: 'What time tomorrow?' }))
    })
    await runtime.api.start(request({
      employees: [employee('lead')], interaction,
      coordination: interaction ? undefined : { leadId: 'lead' }
    }))
    assert.equal((await terminal(runtime)).status, 'completed')
  }
})

test('conversation has private context but no skill, archive, artifact or work-receipt side effects', async (t) => {
  let archiveCalls = 0, skillCalls = 0
  const runtime = fixture(t, async (input) => {
    assert.equal(input.conversationOnly, true)
    assert.match(input.instructions, /本轮只返回一个 grok-dispatch JSON/)
    assert.match(input.instructions, /PRIVATE-MEMORY/)
    assert.match(input.prompt, /PRIVATE-HISTORY/)
    assert.deepEqual(input.skills, [])
    input.receipt?.({ filesModified: ['should-not-exist'] })
    input.text(JSON.stringify({ action: 'finish', message: '```grok-artifact\n{"name":"private.md"}\nPRIVATE-CONTENT\n```' }))
  }, { assistant: async () => assistant, archive: async () => { archiveCalls++; return 'archive' }, skills: () => { skillCalls++; return [] } })
  await runtime.api.start(request({ employees: [employee('lead')], coordination: undefined, interaction: 'conversation', assistantScopeId: 'project-one', privateContext: [{ author: 'user', text: 'PRIVATE-HISTORY' }] }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed')
  assert.equal(archiveCalls, 0)
  assert.equal(skillCalls, 0)
  assert.equal(snapshot.sharedArtifacts, undefined)
  assert.equal(snapshot.replies[0].receipt, undefined)
})

test('only a successful host assistant action marks the run updated', async (t) => {
  const applied: unknown[] = []
  const runtime = fixture(t, async (input) => {
    input.text(JSON.stringify({ action: 'finish', message: 'remembered', memoryUpdates: [{ kind: 'preference', content: 'concise' }] }))
  }, { assistant: async () => assistant, assistantActions: async (...args: unknown[]) => { applied.push(args); return assistant } })
  await runtime.api.start(request({ assistantScopeId: 'project-one' }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.assistantUpdated, true)
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0], ['project-one', { memoryUpdates: [{ kind: 'preference', content: 'concise' }], forgetMemoryIds: undefined, commitmentUpdates: undefined }, 'assistant-run', 0])
  assert.throws(() => parseDecision(JSON.stringify({ action: 'finish', message: 'invalid', memoryUpdates: [{ kind: 'inferred_emotion', content: 'sad' }] })), /记忆/)
  assert.throws(() => parseDecision(JSON.stringify({ action: 'finish', message: 'invalid', commitmentUpdates: [{ title: 'remind', dueAt: 'tomorrow' }] })), /提醒/)
})

test('conversation remembers explicit requests through the host without exposing control JSON', async (t) => {
  const applied: unknown[] = []
  const runtime = fixture(t, async (input) => {
    assert.equal(input.conversationOnly, true)
    input.text(JSON.stringify({ action: 'finish', message: 'I will keep replies concise.', memoryUpdates: [{ kind: 'preference', content: 'Keep replies concise' }] }))
  }, { assistantActions: async (...args: unknown[]) => { applied.push(args); return assistant } })
  await runtime.api.start(request({ employees: [employee('lead')], coordination: undefined, interaction: 'conversation', assistantScopeId: 'project-one' }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.assistantUpdated, true)
  assert.equal(applied.length, 1)
  assert.equal(snapshot.replies[0].text, 'I will keep replies concise.')
  assert.deepEqual(snapshot.coordination?.tasks, [])
})

test('conversation refuses work delegation and does not claim a failed memory save succeeded', async (t) => {
  let calls = 0, saves = 0
  const runtime = fixture(t, async (input) => {
    assert.equal(input.employee.id, 'lead')
    input.text(JSON.stringify(++calls === 1
      ? { action: 'delegate', ...task('forbidden'), message: 'work' }
      : { action: 'finish', message: 'saved', memoryUpdates: [{ kind: 'fact', content: 'test' }] }))
  }, { assistantActions: async () => { saves++; throw new Error('disk failure') } })
  await runtime.api.start(request({ employees: [employee('lead')], coordination: undefined, interaction: 'conversation', assistantScopeId: 'project-one' }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.assistantUpdated, undefined)
  assert.deepEqual(snapshot.coordination?.tasks, [])
  assert.equal(saves, 2)
  assert.ok(snapshot.replies.every((reply) => reply.text !== 'saved'))
})

test('a concurrent user edit invalidates all later assistant mutations in the same run', async (t) => {
  let rounds = 0, saves = 0, revision = 3
  const runtime = fixture(t, async (input) => {
    rounds++
    if (rounds > 1) assert.match(input.instructions, /不要再次提交记忆或提醒更新/)
    revision = 4
    input.text(JSON.stringify(rounds < 3
      ? { action: 'finish', message: 'saved', memoryUpdates: [{ kind: 'preference', content: 'stale preference' }] }
      : { action: 'finish', message: 'The earlier preference was not saved.' }))
  }, {
    assistant: async () => ({ ...assistant, revision }),
    assistantActions: async (_scope: string, _actions: unknown, _source: string, expectedRevision: number) => {
      saves++
      assert.equal(expectedRevision, 3)
      throw Object.assign(new Error('changed by user'), { code: 'ASSISTANT_REVISION_CONFLICT' })
    }
  })
  await runtime.api.start(request({ employees: [employee('lead')], coordination: undefined, interaction: 'conversation', assistantScopeId: 'project-one' }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed')
  assert.equal(saves, 1, 'a newer context revision must not revive the stale action')
  assert.equal(snapshot.assistantUpdated, undefined)
  assert.ok(snapshot.replies.every((reply) => reply.text !== 'saved'))
})

class FixtureRpc extends EventEmitter {
  calls: { method: string; params: any }[] = []
  responses: { id: string; result?: any; error?: unknown }[] = []
  constructor(private handler: (method: string, params: any, rpc: FixtureRpc) => unknown) { super() }
  async request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(method, params, this) }
  respond(id: string, result: unknown) { this.responses.push({ id, result }) }
  reject(id: string, error: unknown) { this.responses.push({ id, error }) }
  close() { this.emit('closed', new Error('closed')) }
  async stop() {}
}
const adapterInput = (provider: 'claude' | 'codex' | 'grok' | 'gemini'): Execution => ({
  conversationOnly: true, employee: employee('lead', provider), cwd: process.cwd(), prompt: 'chat', instructions: 'chat only',
  signal: new AbortController().signal, text: () => {}, permission: async () => { throw new Error('chat must not prompt for permission') }
})

test('Claude conversations disable tools and refuse even explicit tool callbacks', async () => {
  let options: any
  await execute(adapterInput('claude'), {
    cliOutput: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), claudeEntry: () => 'fixture',
    query: (input: any) => { options = input.options; return { async *[Symbol.asyncIterator]() { yield { type: 'result', is_error: false } }, close() {} } }
  } as any)
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal((await options.canUseTool('Write', { file_path: 'x' })).behavior, 'deny')
})

test('Codex conversations use read-only sandbox, never approve and disable configured MCP servers', async () => {
  const rpc = new FixtureRpc((method, _params, peer) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'config/read') return { config: { mcp_servers: { 'external.with.dots': { enabled: true, command: 'fixture' } } } }
    if (method === 'thread/start') return { thread: { id: 'chat-thread' } }
    if (method === 'turn/start') {
      peer.emit('request', { id: 'write', method: 'item/fileChange/requestApproval', params: {} })
      peer.emit('notification', { method: 'turn/completed', params: { threadId: 'chat-thread', turn: { status: 'completed' } } })
    }
    return {}
  })
  await execute(adapterInput('codex'), { rpcFor: async () => ({ rpc }) } as any)
  const start = rpc.calls.find((call) => call.method === 'thread/start')!.params
  assert.equal(start.sandbox, 'read-only')
  assert.equal(start.approvalPolicy, 'never')
  assert.deepEqual(start.config.mcp_servers, { 'external.with.dots': { enabled: false } })
  assert.equal(start.config.features.hooks, false)
  assert.equal(start.config.features.shell_tool, false)
  assert.deepEqual(rpc.responses[0].result, { decision: 'decline' })
})

test('Codex conversations override only MCP enabled flags without replaying nullable config/read fields', async () => {
  const configured = {
    config: {
      mcp_servers: {
        node_repl: {
          command: 'node', args: ['fixture.mjs'], env: { FIXTURE_MODE: 'test' }, enabled: true,
          startup_timeout_sec: 120, tool_timeout_sec: null, enabled_tools: null, disabled_tools: null
        },
        'external.with.dots': {
          command: 'fixture', args: [], enabled: false, startup_timeout_sec: null, tool_timeout_sec: 60
        },
        'remote-tools/@v2': {
          url: 'https://example.invalid/mcp', http_headers: { 'X-Fixture': 'test' }, enabled: true,
          startup_timeout_sec: null, tool_timeout_sec: null, enabled_tools: ['lookup'], disabled_tools: null
        }
      }
    }
  }
  const original = structuredClone(configured)
  const rpc = new FixtureRpc((method, _params, peer) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'config/read') return configured
    if (method === 'thread/start') return { thread: { id: 'chat-thread' } }
    if (method === 'turn/start')
      peer.emit('notification', { method: 'turn/completed', params: { threadId: 'chat-thread', turn: { status: 'completed' } } })
    return {}
  })
  await execute(adapterInput('codex'), { rpcFor: async () => ({ rpc }) } as any)
  assert.deepEqual(rpc.calls.filter((call) => call.method === 'config/read').map((call) => call.params), [{ includeLayers: false }])
  const start = rpc.calls.find((call) => call.method === 'thread/start')!.params
  assert.deepEqual(start.config.mcp_servers, {
    node_repl: { enabled: false },
    'external.with.dots': { enabled: false },
    'remote-tools/@v2': { enabled: false }
  })
  assert.deepEqual(configured, original, 'disabling tools must not modify the configuration returned by the server')
})

test('Codex work execution does not read or override configured MCP servers', async () => {
  const rpc = new FixtureRpc((method, _params, peer) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'config/read') throw new Error('work execution must inherit its MCP configuration')
    if (method === 'thread/start') return { thread: { id: 'work-thread' } }
    if (method === 'turn/start')
      peer.emit('notification', { method: 'turn/completed', params: { threadId: 'work-thread', turn: { status: 'completed' } } })
    return {}
  })
  await execute({ ...adapterInput('codex'), conversationOnly: false }, { rpcFor: async () => ({ rpc }) } as any)
  assert.equal(rpc.calls.some((call) => call.method === 'config/read'), false)
  const start = rpc.calls.find((call) => call.method === 'thread/start')!.params
  assert.equal(start.sandbox, 'workspace-write')
  assert.equal(start.approvalPolicy, 'on-request')
  assert.equal(Object.hasOwn(start, 'config'), false)
  assert.equal(Object.hasOwn(start, 'dynamicTools'), false)
  assert.equal(Object.hasOwn(start, 'environments'), false)
})

test('ACP conversations request provider restrictions and reject permission and filesystem callbacks', async () => {
  for (const provider of ['grok', 'gemini'] as const) {
    let rpcArgs: unknown[] = []
    const rpc = new FixtureRpc((method, _params, peer) => {
      if (method === 'session/new') return { sessionId: 'chat-session' }
      if (method === 'session/prompt') {
        peer.emit('request', { id: 'permission', method: 'session/request_permission', params: {} })
        peer.emit('request', { id: 'write', method: 'fs/write_text_file', params: {} })
        return { stopReason: 'end_turn' }
      }
      return {}
    })
    await execute(adapterInput(provider), {
      rpcFor: async (...args: unknown[]) => { rpcArgs = args; return { rpc } },
      readSubscriptionAuth: () => ({ signedIn: true }), geminiAccount: () => ({ canAuthenticate: true, methodId: 'oauth-personal' })
    } as any)
    assert.equal(rpcArgs[4], true)
    if (provider === 'grok') assert.deepEqual((rpcArgs[2] as string[]).slice(0, 2), ['--tools', ''])
    assert.deepEqual(rpc.responses[0].result, { outcome: { outcome: 'cancelled' } })
    assert.ok(rpc.responses[1].error)
  }
})
