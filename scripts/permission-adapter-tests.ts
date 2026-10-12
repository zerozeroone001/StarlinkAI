import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execute, type Execution } from '../src/main/runtime/adapters'
import { providerRuntimeArgs } from '../src/main/runtime/providers'
import type { PermissionMode, ProviderId } from '../src/shared/types'

const modes: PermissionMode[] = ['ask', 'review', 'auto']
const providers: ProviderId[] = ['codex', 'claude', 'grok', 'gemini']
const inputFor = (provider: ProviderId, permissionMode: PermissionMode, conversationOnly = false): Execution => ({
  employee: { id: 'worker', name: 'Worker', provider, role: 'test', persona: '' },
  permissionMode, conversationOnly, cwd: process.cwd(), prompt: 'test', instructions: 'test',
  signal: new AbortController().signal, text: () => {}, permission: async () => 'deny'
})

class FixtureRpc extends EventEmitter {
  calls: { method: string; params: any }[] = []
  responses: { id: string; result?: any; error?: unknown }[] = []
  constructor(private provider: ProviderId, private additionalRequests: any[] = [], private notifications: any[] = []) { super() }
  async request(method: string, params: any) {
    this.calls.push({ method, params })
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'config/read') return { config: { mcp_servers: { node_repl: { command: 'node', tool_timeout_sec: null } } } }
    if (method === 'thread/start') return { thread: { id: 'thread' } }
    if (method === 'session/new') return { sessionId: 'session' }
    if (method === 'turn/start' || method === 'session/prompt') {
      const requests = this.provider === 'codex' ? [
        { id: 'command', method: 'item/commandExecution/requestApproval', params: { command: 'test' } },
        { id: 'file', method: 'item/fileChange/requestApproval', params: { grantRoot: process.cwd() } }
      ] : [{
        id: 'tool', method: 'session/request_permission', params: {
          toolCall: { title: 'write_file', rawInput: { path: 'fixture.txt' } },
          options: [
            { optionId: 'persist', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
          ]
        }
      }]
      for (const request of [...requests, ...this.additionalRequests])
        for (const listener of this.listeners('request')) await listener(request)
      for (const notification of this.notifications) this.emit('notification', notification)
      if (method === 'turn/start') this.emit('notification', {
        method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } }
      })
      return { stopReason: 'end_turn' }
    }
    return {}
  }
  respond(id: string, result: unknown) { this.responses.push({ id, result }) }
  reject(id: string, error: unknown) { this.responses.push({ id, error }) }
  close() {}
  async stop() {}
}

async function runFixture(provider: ProviderId, mode: PermissionMode, conversationOnly = false, additionalRequests: any[] = []) {
  const rpc = new FixtureRpc(provider, additionalRequests)
  const state = { approvals: 0, rpcArgs: [] as any[], claudeOptions: undefined as any, claudeDecision: undefined as any }
  const input = inputFor(provider, mode, conversationOnly)
  input.permission = async (_title, _detail, options) => {
    state.approvals++
    return options.find((option) => option.id === 'deny' || option.id === 'decline')!.id
  }
  await execute(input, {
    rpcFor: async (...args: unknown[]) => { state.rpcArgs = args; return { rpc } },
    readSubscriptionAuth: () => ({ signedIn: true }),
    geminiAccount: () => ({ canAuthenticate: true, methodId: 'oauth-personal' }),
    cliOutput: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    claudeEntry: () => 'fixture',
    query: ({ options }: any) => {
      state.claudeOptions = options
      return {
        async *[Symbol.asyncIterator]() {
          state.claudeDecision = await options.canUseTool('Write', { file_path: 'fixture.txt' })
          yield { type: 'result', is_error: false }
        }, close() {}
      }
    }
  } as any)
  return { rpc, ...state }
}

for (const provider of providers) {
  for (const mode of modes) {
    test(`${provider} ${mode} uses native permissions and only full access approves host callbacks`, async () => {
      const result = await runFixture(provider, mode)
      if (provider === 'claude') {
        assert.equal(result.claudeOptions.permissionMode, { ask: 'default', review: 'auto', auto: 'bypassPermissions' }[mode])
        assert.equal(result.claudeOptions.allowDangerouslySkipPermissions === true, mode === 'auto')
        assert.equal(result.claudeDecision.behavior, mode === 'auto' ? 'allow' : 'deny')
        assert.equal(result.approvals, mode === 'auto' ? 0 : 1)
        if (mode === 'auto') assert.equal(result.claudeOptions.sandbox.enabled, false)
      } else {
        assert.equal(result.rpcArgs[5], mode)
        if (provider === 'codex') {
          const start = result.rpc.calls.find((call) => call.method === 'thread/start')!.params
          assert.equal(start.approvalPolicy, mode === 'auto' ? 'never' : 'on-request')
          assert.equal(start.approvalsReviewer, mode === 'review' ? 'auto_review' : 'user')
          assert.equal(start.sandbox, mode === 'auto' ? 'danger-full-access' : 'workspace-write')
          assert.deepEqual(result.rpc.responses.map((response) => response.result.decision), mode === 'auto' ? ['accept', 'accept'] : ['decline', 'decline'])
          assert.equal(result.approvals, mode === 'auto' ? 0 : 2)
        } else {
          const args = providerRuntimeArgs(provider, [], false, mode)
          const flag = provider === 'grok' ? '--permission-mode' : '--approval-mode'
          assert.equal(args[args.indexOf(flag) + 1], provider === 'grok'
            ? { ask: 'default', review: 'auto', auto: 'bypassPermissions' }[mode]
            : mode === 'auto' ? 'yolo' : 'default')
          assert.deepEqual(result.rpc.responses[0].result, {
            outcome: { outcome: 'selected', optionId: mode === 'auto' ? 'once' : 'deny' }
          })
          assert.equal(result.approvals, mode === 'auto' ? 0 : 1)
          if (mode === 'auto') assert.ok(provider === 'grok' ? args.includes('off') : args.includes('--sandbox=false'))
        }
      }
    })

    test(`${provider} conversation mode overrides ${mode} and rejects tool requests`, async () => {
      const result = await runFixture(provider, mode, true)
      assert.equal(result.approvals, 0)
      if (provider === 'claude') {
        assert.equal(result.claudeOptions.permissionMode, 'default')
        assert.notEqual(result.claudeOptions.allowDangerouslySkipPermissions, true)
        assert.deepEqual(result.claudeOptions.tools, [])
        assert.equal(result.claudeDecision.behavior, 'deny')
      } else {
        assert.equal(result.rpcArgs[4], true)
        assert.equal(result.rpcArgs[5], 'ask')
        const args = providerRuntimeArgs(provider, [], true, mode)
        assert.ok(!args.includes('yolo') && !args.includes('bypassPermissions') && !args.includes('auto'))
        if (provider === 'codex') {
          const start = result.rpc.calls.find((call) => call.method === 'thread/start')!.params
          assert.equal(start.approvalPolicy, 'never')
          assert.equal(start.approvalsReviewer, 'user')
          assert.equal(start.sandbox, 'read-only')
          assert.deepEqual(start.config.mcp_servers, { node_repl: { enabled: false } })
          assert.ok(result.rpc.responses.every((response) => response.result.decision === 'decline'))
        } else assert.deepEqual(result.rpc.responses[0].result, { outcome: { outcome: 'cancelled' } })
      }
    })
  }
}

test('full access never fabricates user input or accepts unsupported RPC requests', async () => {
  for (const provider of ['codex', 'grok', 'gemini'] as const) {
    const result = await runFixture(provider, 'auto', false, [{
      id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ question: 'Choose a destination' }] }
    }])
    const response = result.rpc.responses.find((entry) => entry.id === 'question')!
    assert.equal(response.result, undefined)
    assert.equal(typeof response.error, 'string')
  }
  const claude = await runFixture('claude', 'auto')
  const decision = await claude.claudeOptions.canUseTool('AskUserQuestion', { questions: [{ question: 'Choose a destination' }] })
  assert.equal(decision.behavior, 'deny')
})

test('full access does not invent or persist an ACP approval when allow_once is absent', async () => {
  const result = await runFixture('grok', 'auto', false, [{
    id: 'persistent', method: 'session/request_permission', params: {
      toolCall: { title: 'write_file' }, options: [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]
    }
  }])
  assert.deepEqual(result.rpc.responses.find((entry) => entry.id === 'persistent')!.result, { outcome: { outcome: 'cancelled' } })
})

test('catalog launches and omitted permission modes retain manual defaults', () => {
  assert.deepEqual(providerRuntimeArgs('grok'), ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'])
  assert.deepEqual(providerRuntimeArgs('gemini'), ['--acp', '--approval-mode', 'default'])
  assert.deepEqual(providerRuntimeArgs('codex'), ['app-server', '-c', 'model_provider="openai"'])
})

type ReceiptPatch = Parameters<NonNullable<Execution['receipt']>>[0]
const claudeAssistant = (content: any[], parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { content }
})
const claudeToolResult = (id: string, isError = false, parent: string | null = null) => ({
  type: 'user', parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'Rejected or failed' : 'Success' }] }
})
async function runClaudeTrace(messages: (options: any) => AsyncIterable<any>, decision = 'deny') {
  const receipts: ReceiptPatch[] = []
  const text: string[] = []
  await execute({ ...inputFor('claude', 'ask'), permission: async () => decision,
    receipt: (patch) => receipts.push(patch), text: (delta) => text.push(delta) }, {
    cliOutput: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    claudeEntry: () => 'fixture',
    query: ({ options }: any) => ({
      async *[Symbol.asyncIterator]() {
        yield* messages(options)
        yield { type: 'result', is_error: false }
      }, close() {}
    })
  } as any)
  return { receipts, text: text.join('') }
}

test('Claude denied Write and Bash do not produce execution receipts and preserve response text', async () => {
  const tools = [
    { type: 'tool_use', id: 'write-denied', name: 'Write', input: { file_path: 'denied.txt', content: 'not written' } },
    { type: 'tool_use', id: 'bash-denied', name: 'Bash', input: { command: 'echo not executed' } }
  ]
  const result = await runClaudeTrace(async function* (options) {
    yield claudeAssistant(tools)
    for (const tool of tools) {
      assert.equal((await options.canUseTool(tool.name, tool.input)).behavior, 'deny')
      yield claudeToolResult(tool.id, true)
    }
    yield claudeAssistant([{ type: 'text', text: 'The requested operations were declined.' }])
  })
  assert.deepEqual(result.receipts, [])
  assert.equal(result.text, 'The requested operations were declined.')
})

test('Claude successful tool results produce one receipt per id despite repeated frames', async () => {
  const tools = [
    { type: 'tool_use', id: 'write-success', name: 'Write', input: { file_path: 'written.txt' } },
    { type: 'tool_use', id: 'bash-success', name: 'Bash', input: { command: 'echo executed' } }
  ]
  const result = await runClaudeTrace(async function* (options) {
    yield claudeAssistant(tools)
    for (const tool of tools) {
      assert.equal((await options.canUseTool(tool.name, tool.input)).behavior, 'allow')
      yield claudeToolResult(tool.id)
      yield claudeAssistant([tool])
      yield claudeToolResult(tool.id)
    }
    yield claudeAssistant([{ type: 'text', text: 'Finished.' }])
  }, 'allow')
  assert.deepEqual(result.receipts, [
    { filesModified: ['written.txt'] },
    { commands: [{ command: 'echo executed', exitCode: undefined }] }
  ])
  assert.equal(result.text, 'Finished.')
})

test('Claude failed or unfinished tools never claim successful file modifications', async () => {
  const result = await runClaudeTrace(async function* (options) {
    const failed = { type: 'tool_use', id: 'write-failed', name: 'Write', input: { file_path: 'failed.txt' } }
    yield claudeAssistant([failed, { type: 'tool_use', id: 'unfinished', name: 'Write', input: { file_path: 'unfinished.txt' } }])
    assert.equal((await options.canUseTool(failed.name, failed.input)).behavior, 'allow')
    yield claudeToolResult(failed.id, true)
    yield claudeAssistant([{ type: 'text', text: 'Writing failed.' }])
  }, 'allow')
  assert.deepEqual(result.receipts, [])
  assert.equal(result.text, 'Writing failed.')
})

test('Claude caches complete streamed tool input without assistant frames and ignores subagents', async () => {
  const stream = (event: any, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event })
  const result = await runClaudeTrace(async function* () {
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working. ' } })
    yield stream({ type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'stream-write', name: 'Write', input: {} } })
    yield stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } })
    yield stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"streamed.txt"}' } })
    yield stream({ type: 'content_block_stop', index: 1 })
    yield claudeAssistant([{ type: 'tool_use', id: 'nested', name: 'Write', input: { file_path: 'subagent.txt' } }], 'parent-tool')
    yield claudeToolResult('nested', false, 'parent-tool')
    // Even a subagent result reusing a parent's id must not consume the parent's pending trace.
    yield claudeToolResult('stream-write', false, 'parent-tool')
    yield claudeToolResult('stream-write')
    yield claudeToolResult('stream-write')
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })
    yield claudeAssistant([{ type: 'text', text: 'Working. Done.' }])
  })
  assert.deepEqual(result.receipts, [{ filesModified: ['streamed.txt'] }])
  assert.equal(result.text, 'Working. Done.')
})

test('Codex file receipts include only successfully completed changes', async () => {
  const statuses = ['failed', 'declined', 'completed']
  const rpc = new FixtureRpc('codex', [], statuses.map((status) => ({
    method: 'item/completed', params: { threadId: 'thread', item: {
      type: 'fileChange', id: status, status, changes: [{ path: `${status}.txt` }]
    } }
  })))
  const receipts: ReceiptPatch[] = []
  await execute({ ...inputFor('codex', 'ask'), receipt: (patch) => receipts.push(patch) }, {
    rpcFor: async () => ({ rpc })
  } as any)
  assert.deepEqual(receipts, [{ filesModified: ['completed.txt'] }])
})

test('Codex declined commands are omitted while executed failures keep their exit code', async () => {
  const rpc = new FixtureRpc('codex', [], [
    { status: 'declined', command: 'echo denied', exitCode: null },
    { status: 'failed', command: 'exit 2', exitCode: 2 },
    { status: 'completed', command: 'echo done', exitCode: 0 }
  ].map((item) => ({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'commandExecution', ...item } } })))
  const receipts: ReceiptPatch[] = []
  await execute({ ...inputFor('codex', 'ask'), receipt: (patch) => receipts.push(patch) }, {
    rpcFor: async () => ({ rpc })
  } as any)
  assert.deepEqual(receipts, [
    { commands: [{ command: 'exit 2', exitCode: 2 }] },
    { commands: [{ command: 'echo done', exitCode: 0 }] }
  ])
})
