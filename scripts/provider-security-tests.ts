import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { subscriptionEnv, safeError } from '../src/main/runtime/cli'
import { login, closeLogins } from '../src/main/runtime/login'

const synthetic = 'SYNTHETIC_TEST_VALUE_NOT_A_REAL_CREDENTIAL'

test('subscription clients strip mixed-case API credentials and backend switches', () => {
  const source = {
    openai_api_key: synthetic, OpenAI_Base_URL: 'https://invalid.example',
    anthropic_api_key: synthetic, Anthropic_AUTH_TOKEN: synthetic,
    anthropic_base_url: 'https://invalid.example', claude_code_use_vertex: '1',
    Claude_Code_Use_Bedrock: '1', claude_code_use_foundry: '1', ClaudeCode: '1',
    gemini_api_key: synthetic, Google_Api_Key: synthetic, google_genai_use_vertexai: '1',
    xai_api_key: synthetic, Grok_API_KEY: synthetic, electron_run_as_node: '0',
    KEEP_ME: 'unchanged'
  }
  for (const provider of [undefined, 'claude', 'codex', 'grok'] as const) {
    assert.deepEqual(subscriptionEnv(provider, source), { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'unchanged' })
  }
  assert.equal(source.anthropic_api_key, synthetic, 'do not mutate the parent environment')
})

test('Gemini preserves its supported API key mode and canonicalizes mixed-case aliases', () => {
  const env = subscriptionEnv('gemini', { google_api_key: synthetic, OPENAI_API_KEY: synthetic })
  assert.equal(env.GEMINI_API_KEY, synthetic)
  assert.equal(env.GOOGLE_API_KEY, synthetic)
  assert.equal(env.google_api_key, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  const preferred = subscriptionEnv('gemini', { gemini_api_key: 'alias', GEMINI_API_KEY: 'canonical' })
  assert.equal(preferred.GEMINI_API_KEY, 'canonical')
  assert.equal(preferred.gemini_api_key, undefined)
})

test('Windows child cannot recover stripped credentials through case-insensitive lookup', {
  skip: process.platform !== 'win32'
}, () => {
  const env = subscriptionEnv('claude', { Path: process.env.Path ?? process.env.PATH, anthropic_api_key: synthetic })
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(Boolean(process.env.ANTHROPIC_API_KEY)))'], {
    env, encoding: 'utf8', windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'false')
})

test('error messages redact structured and prose credentials without losing useful diagnostics', () => {
  for (const label of ['api_key=', 'API key provided: ', 'token supplied: ', 'secret: ', 'Bearer ']) {
    const message = safeError(new Error(`Authentication failed: ${label}${synthetic}`))
    assert.equal(message.includes(synthetic), false)
    assert.match(message, /Authentication failed/)
  }
  for (const key of ['sk-proj-synthetic_not_a_real_key', 'sk-ant-api03-synthetic_not_a_real_key',
    'xai-synthetic_not_a_real_key', 'AIza-synthetic_not_a_real_key']) {
    assert.equal(safeError(new Error(`Rejected credential (${key})`)).includes(key), false)
  }
  assert.equal(safeError(new Error('Connection timed out after 15 seconds')), 'Connection timed out after 15 seconds')
  assert.equal(safeError(new Error('x'.repeat(1000))).length, 700)
})

async function codexLogin() {
  closeLogins()
  const rpc = Object.assign(new EventEmitter(), {
    closed: false,
    close() { this.closed = true },
    async request() { return { authUrl: 'https://auth.openai.com/synthetic-test-not-opened' } }
  })
  ;(globalThis as any).__providerSecurityRpc = rpc
  const snapshot = await login('codex')
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { rpc, snapshot }
}

test('malformed Codex completion notifications fail safely and release the client', async () => {
  for (const params of [undefined, null, [], 'success', {}, { success: 'false' }, { success: 1 }]) {
    const { rpc, snapshot } = await codexLogin()
    assert.doesNotThrow(() => rpc.emit('notification', { method: 'account/login/completed', params }))
    assert.equal(snapshot.status, 'failed')
    assert.match(snapshot.message, /无效的登录结果/)
    assert.equal(rpc.closed, true)
  }
  closeLogins()
})

test('valid Codex success and failure are preserved with sanitized errors', async () => {
  for (const [params, expected] of [
    [{ success: true }, 'completed'],
    [{ success: false, error: { unsafe: 'object' } }, 'failed'],
    [{ success: false, error: `API key provided: ${synthetic}` }, 'failed']
  ] as const) {
    const { rpc, snapshot } = await codexLogin()
    rpc.emit('notification', { method: 'unrelated/notification', params: null })
    assert.equal(snapshot.status, 'pending')
    rpc.emit('notification', { method: 'account/login/completed', params })
    assert.equal(snapshot.status, expected)
    assert.equal(snapshot.message.includes(synthetic), false)
    assert.equal(rpc.closed, true)
  }
  closeLogins()
})
