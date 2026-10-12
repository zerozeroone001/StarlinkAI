import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execute } from '../src/main/runtime/adapters'
import { createAcpToolTrace } from '../src/main/runtime/acp-tool-trace'
import type { WorkReceipt } from '../src/shared/runtime'

test('ACP null and omitted raw inputs preserve the original completed command', () => {
  const receipts: WorkReceipt[] = []
  const trace = createAcpToolTrace('grok', (receipt) => receipts.push(receipt), undefined)
  trace.update({ toolCallId: 'shell', kind: 'execute', status: 'in_progress', rawInput: { command: 'node sum.test.mjs' } })
  trace.update({ toolCallId: 'shell', status: 'completed', rawInput: null, rawOutput: { exitCode: 0 } })
  trace.update({ toolCallId: 'shell', status: 'completed' })
  assert.deepEqual(receipts, [{ commands: [{ command: 'node sum.test.mjs', exitCode: 0 }] }])
})
test('Gemini permission metadata and a delta-only completion preserve native command evidence', async () => {
  class Rpc extends EventEmitter {
    async request(method: string) {
      if (method === 'authenticate' || method === 'session/set_model') return {}
      if (method === 'session/new') return { sessionId: 'fixture-session' }
      if (method === 'session/prompt') {
        const calls = [
          { toolCallId: 'write', status: 'pending', title: 'Writing to sum.mjs', kind: 'edit',
            content: [{ type: 'diff', path: '/fixture/sum.mjs', oldText: '', newText: 'fixture' }], locations: [{ path: '/fixture/sum.mjs' }] },
          { toolCallId: 'exec', status: 'pending', title: 'node sum.test.mjs', kind: 'execute', content: [], locations: [] }
        ]
        for (const toolCall of calls) {
          for (const listener of this.listeners('request')) await listener({ id: toolCall.toolCallId, method: 'session/request_permission',
            params: { sessionId: 'fixture-session', toolCall, options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }] } })
          this.emit('notification', { method: 'session/update', params: { sessionId: 'fixture-session', update: {
            sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed', rawInput: null,
            content: [{ type: 'content', content: { type: 'text', text: 'LOCAL_NODE_OK' } }]
          } } })
        }
        return { stopReason: 'end_turn' }
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    }
    respond() {}
    reject() { throw new Error('Unexpected permission rejection') }
    close() {}
    async stop() {}
  }
  const receipts: WorkReceipt[] = []
  const rpc = new Rpc()
  await execute({ employee: { id: 'a', name: 'a', role: 'test', persona: '', provider: 'gemini' }, cwd: '/fixture',
    prompt: 'fixture', instructions: '', signal: new AbortController().signal, text: () => {},
    receipt: (receipt) => receipts.push(receipt), permission: async () => 'proceed_once' }, {
    rpcFor: async () => ({ rpc }), geminiAccount: () => ({ canAuthenticate: true, methodId: 'oauth-personal' })
  } as any)
  assert.deepEqual(receipts, [{ filesModified: ['/fixture/sum.mjs'] }, { commands: [{ command: 'node sum.test.mjs' }] }])
})
test('standard kind and locations/diffs record completed files without rawInput', () => {
  const receipts: WorkReceipt[] = []
  const trace = createAcpToolTrace('gemini', (receipt) => receipts.push(receipt), undefined)
  trace.update({ toolCallId: 'edit', kind: 'edit', status: 'in_progress', locations: [{ path: '/a' }], content: [{ type: 'diff', path: '/b', oldText: null, newText: 'content' }] })
  trace.update({ toolCallId: 'edit', status: 'completed' })
  trace.update({ toolCallId: 'read', kind: 'read', status: 'completed', locations: [{ path: '/c' }] })
  trace.update({ toolCallId: 'failed', kind: 'edit', status: 'failed', locations: [{ path: '/failed' }] })
  trace.update({ toolCallId: 'unfinished', kind: 'edit', status: 'pending', locations: [{ path: '/unfinished' }] })
  assert.deepEqual(receipts, [{ filesModified: ['/a', '/b'] }, { filesRead: ['/c'] }])
})
test('permission alone cannot claim completion and generic titles are not invented as commands', () => {
  const receipts: WorkReceipt[] = []
  const trace = createAcpToolTrace('grok', (receipt) => receipts.push(receipt), undefined)
  trace.permission({ toolCallId: 'pending', title: 'node test.mjs', kind: 'execute', status: 'pending' })
  trace.update({ toolCallId: 'generic', title: 'Running local tests', kind: 'execute', status: 'completed' })
  for (const invalid of [null, [], {}, { toolCallId: 123, status: 'completed' }]) trace.update(invalid)
  assert.deepEqual(receipts, [])
})
test('failed commands keep known exit codes without claiming failed files were modified', () => {
  const receipts: WorkReceipt[] = []
  const trace = createAcpToolTrace('gemini', (receipt) => receipts.push(receipt), undefined)
  trace.update({ toolCallId: 'shell', kind: 'execute', title: 'node failed.mjs', status: 'in_progress' })
  trace.update({ toolCallId: 'shell', status: 'failed', rawOutput: { exitCode: 7 } })
  trace.update({ toolCallId: 'shell', status: 'failed', rawOutput: { exitCode: 7 } })
  trace.update({ toolCallId: 'unknown', kind: 'execute', title: 'node unknown.mjs', status: 'failed' })
  trace.update({ toolCallId: 'write', kind: 'edit', locations: [{ path: '/failed' }], status: 'failed' })
  assert.deepEqual(receipts, [{ commands: [{ command: 'node failed.mjs', exitCode: 7 }] }])
})
