import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, validateRequest, buildContext } from '../src/main/runtime/service'
import { StdioRpc } from '../src/main/runtime/rpc'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { geminiAccount, subscriptionEnv, desktopCodexCandidates, safeError, workspaceDir } from '../src/main/runtime/cli'
import { createProviderCatalog } from '../src/main/runtime/provider-cache'
import { isLocalWorkspaceRequest } from './runtime-middleware'
import type { RunRecord } from '../src/main/runtime/run-journal'

test('Gemini keeps API keys only in its subprocess and respects the selected auth method', () => {
  const env = { GEMINI_API_KEY: 'test-gemini', GOOGLE_API_KEY: 'test-google', OPENAI_API_KEY: 'test-openai' }
  assert.equal(subscriptionEnv('gemini', env).GEMINI_API_KEY, 'test-gemini')
  assert.equal(subscriptionEnv('gemini', { GOOGLE_API_KEY: 'fallback' }).GEMINI_API_KEY, 'fallback')
  assert.equal(subscriptionEnv('gemini', env).OPENAI_API_KEY, undefined)
  assert.equal(subscriptionEnv('codex', env).GEMINI_API_KEY, undefined)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-test-'))
  try {
    assert.equal(geminiAccount(root, env).methodId, 'gemini-api-key')
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }))
    const keyAccount = geminiAccount(root, {})
    assert.equal(keyAccount.canAuthenticate, true, 'allow CLI to read its secure key store')
    assert.equal(keyAccount.signedIn, false, 'do not claim auth until CLI accepts it')
    assert.equal(keyAccount.email, null)
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }))
    fs.writeFileSync(path.join(root, 'oauth_creds.json'), '{}')
    fs.writeFileSync(path.join(root, 'google_accounts.json'), JSON.stringify({ active: 'full.account@example.com' }))
    assert.equal(geminiAccount(root, env).methodId, 'oauth-personal')
    assert.equal(geminiAccount(root, env).email, 'full.account@example.com')
    fs.unlinkSync(path.join(root, 'oauth_creds.json'))
    assert.equal(geminiAccount(root, env).canAuthenticate, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('discovers versioned Codex desktop binaries without PATH and skips incomplete updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-codex-test-'))
  try {
    const bin = path.join(root, 'OpenAI', 'Codex', 'bin')
    for (const version of ['old', 'new', 'incomplete']) fs.mkdirSync(path.join(bin, version), { recursive: true })
    const old = path.join(bin, 'old', 'codex.exe')
    const recent = path.join(bin, 'new', 'codex.exe')
    fs.writeFileSync(old, '')
    fs.writeFileSync(recent, '')
    fs.utimesSync(old, new Date(0), new Date(0))
    assert.equal(desktopCodexCandidates(root)[0], recent)
    assert.ok(!desktopCodexCandidates(root).some((p) => p.includes('incomplete')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('client errors never expose localized PowerShell stacks or Google API keys', () => {
  assert.doesNotMatch(safeError(new Error('Command failed: powershell Get-Command codex.exe \ufffd')), /Get-Command|\ufffd/)
  assert.doesNotMatch(safeError(new Error('Invalid key AIza-secret-example')), /AIza-secret-example/)
})

const employee = (id: string, provider: 'codex' | 'grok' = 'codex') => ({
  id,
  provider,
  name: id,
  role: '核对资料',
  persona: '简短',
  model: 'model-a',
  effort: 'low'
})

test('preview API accepts its actual loopback port and still rejects cross-origin hosts', () => {
  assert.ok(isLocalWorkspaceRequest({ host: '127.0.0.1:5191', origin: 'http://127.0.0.1:5191' }, 5191))
  for (const headers of [
    { host: '127.0.0.1:5187' }, { host: 'evil.test:5191' },
    { host: 'localhost:5191', origin: 'https://evil.test' },
    { host: 'localhost:5191', 'sec-fetch-site': 'cross-site' }
  ]) assert.equal(isLocalWorkspaceRequest(headers, 5191), false)
})
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({
  id: 'test-run',
  workspaceId: 'test-space',
  prompt: '测试',
  goal: '',
  employees: [employee('a')],
  context: [],
  artifacts: [],
  ...patch
})
const catalog = ['codex', 'grok'].map((id) => ({
  id,
  auth: { signedIn: true },
  models: [
    { id: 'model-a', name: 'A', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }
  ]
})) as RuntimeProvider[]
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw Error('test timed out')
}
function harness(execute: any, providers = async () => structuredClone(catalog)) {
  return createRuntime({ execute, providers, directory: () => process.cwd() })
}

test('cache pressure preserves results whose latest journal write failed', async () => {
  const disk = new Map<string, RunRecord>()
  let unavailable = false
  let calls = 0
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => {
      calls++
      input.text(calls === 1 ? 'Result that exists only in memory' : 'Saved result')
      if (calls === 1) unavailable = true
    },
    journal: {
      load: async (id) => structuredClone(disk.get(id) || null),
      save: async (record) => {
        if (unavailable) throw new Error('simulated disk full')
        disk.set(record.snapshot.id, structuredClone(record))
      }
    }
  })
  try {
    await h.api.start(request())
    await until(async () => (await h.api.run('test-run')).error?.includes('立即导出') === true)
    const failedSave = await h.api.run('test-run')
    assert.equal(failedSave.replies[0].text, 'Result that exists only in memory')
    unavailable = false
    for (let i = 0; i < 101; i++) {
      const id = `cache-pressure-${i}`
      await h.api.start(request({ id }))
      await until(async () => disk.get(id)?.snapshot.status === 'completed')
    }
    assert.deepEqual(await h.api.run('test-run'), failedSave, 'only durable terminal records may be evicted')
    assert.deepEqual(await h.api.start(request()), failedSave, 'repeated start must retain unsaved results without replay')
    assert.equal(calls, 102)
  } finally { unavailable = false; await h.close() }
  assert.equal(disk.get('test-run')?.snapshot.replies[0].text, 'Result that exists only in memory')
})

test('browsing old journal records bounds the cache and retains recently accessed entries', async () => {
  const loads = new Map<string, number>()
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async () => assert.fail('history browsing cannot execute models'),
    journal: {
      load: async (id) => {
        loads.set(id, (loads.get(id) || 0) + 1)
        return { version: 1, fingerprint: 'a'.repeat(64), snapshot: {
          id, workspaceId: 'test-space', status: 'completed', replies: [], permissions: [],
          revision: 1, createdAt: new Date().toISOString(), contextTrimmed: false
        } }
      },
      save: async () => assert.fail('reading terminal history must not rewrite it')
    }
  })
  try {
    for (let i = 0; i < 100; i++) await h.api.run(`history-${i}`)
    await h.api.run('history-0')
    await h.api.run('history-100')
    await h.api.run('history-0')
    assert.equal(loads.get('history-0'), 1, 'recently accessed history stays cached')
    await h.api.run('history-1')
    assert.equal(loads.get('history-1'), 2, 'least recently used durable history is loaded again after eviction')
  } finally { await h.close() }
})

test('cache pressure cannot evict a terminal result while its journal write is still pending', async () => {
  const disk = new Map<string, RunRecord>()
  let releaseSave = () => {}
  let savingTerminal = false
  let calls = 0
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => { calls++; input.text('Pending durable result') },
    journal: {
      load: async (id) => structuredClone(disk.get(id) || (id.startsWith('history-') ? {
        version: 1, fingerprint: 'a'.repeat(64), snapshot: { id, workspaceId: 'history', status: 'completed', replies: [],
          permissions: [], revision: 1, createdAt: new Date().toISOString(), contextTrimmed: false }
      } : null)),
      save: async (record) => {
        if (record.snapshot.id === 'test-run' && record.snapshot.status === 'completed') {
          savingTerminal = true
          await new Promise<void>((resolve) => { releaseSave = resolve })
        }
        disk.set(record.snapshot.id, structuredClone(record))
      }
    }
  })
  let closing: Promise<void> | undefined
  try {
    await h.api.start(request())
    await until(async () => savingTerminal)
    const expected = await h.api.run('test-run')
    assert.equal(expected.status, 'completed')
    assert.notEqual(disk.get('test-run')?.snapshot.status, 'completed')
    for (let i = 0; i < 105; i++) await h.api.run(`history-${i}`)
    assert.deepEqual(await h.api.run('test-run'), expected)
    assert.deepEqual(await h.api.start(request()), expected)
    assert.equal(calls, 1)
    let closed = false
    closing = h.close().then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'close must wait for the same pending durable write')
    releaseSave()
    await closing
    assert.equal(disk.get('test-run')?.snapshot.replies[0].text, 'Pending durable result')
  } finally { releaseSave(); await closing; await h.close() }
})

test('a failed recovery write remains cached through history pressure and retries on close', async () => {
  let rejectSave = true
  const loads = new Map<string, number>()
  const disk = new Map<string, RunRecord>()
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async () => assert.fail('recovery cannot restart execution'), journal: {
      load: async (id) => {
        loads.set(id, (loads.get(id) || 0) + 1)
        return structuredClone(disk.get(id) || { version: 1, fingerprint: 'a'.repeat(64), snapshot: {
          id, workspaceId: 'test-space', status: id === 'recovering' ? 'running' : 'completed', replies: [], permissions: [],
          revision: 1, createdAt: new Date().toISOString(), contextTrimmed: false
        } })
      },
      save: async (record) => { if (rejectSave) throw new Error('recovery disk full'); disk.set(record.snapshot.id, structuredClone(record)) }
    }
  })
  try {
    await assert.rejects(h.api.run('recovering'), /recovery disk full/)
    const recovered = await h.api.run('recovering')
    assert.equal(recovered.status, 'failed')
    assert.equal(recovered.interrupted, true)
    for (let i = 0; i < 105; i++) await h.api.run(`history-${i}`)
    assert.deepEqual(await h.api.run('recovering'), recovered)
    assert.equal(loads.get('recovering'), 1, 'stale running disk state must not replace the in-memory interrupted state')
  } finally { rejectSave = false; await h.close() }
  assert.equal(disk.get('recovering')?.snapshot.interrupted, true)
})

test('history cache pressure and access order do not reorder active FIFO work', async () => {
  const calls: string[] = []
  const disk = new Map<string, RunRecord>()
  let release = () => {}
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => {
      calls.push(input.userPrompt || '')
      if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve })
      input.text('Retained predecessor result')
    }, journal: {
      load: async (id) => structuredClone(disk.get(id) || (id.startsWith('history-') ? {
        version: 1, fingerprint: 'a'.repeat(64), snapshot: { id, workspaceId: 'history', status: 'completed', replies: [],
          permissions: [], revision: 1, createdAt: new Date().toISOString(), contextTrimmed: false }
      } : null)),
      save: async (record) => { disk.set(record.snapshot.id, structuredClone(record)) }
    }
  })
  try {
    await h.api.start(request({ id: 'fifo-1', prompt: 'first' }))
    await until(async () => calls.length === 1)
    await h.api.start(request({ id: 'fifo-2', prompt: 'second', queue: true }))
    await h.api.start(request({ id: 'fifo-3', prompt: 'third', queue: true }))
    for (let i = 0; i < 105; i++) await h.api.run(`history-${i}`)
    await h.api.run('fifo-3'); await h.api.run('fifo-2'); await h.api.run('fifo-1')
    assert.deepEqual(calls, ['first'])
    release()
    await until(async () => (await h.api.run('fifo-3')).status === 'completed')
    assert.deepEqual(calls, ['first', 'second', 'third'])
  } finally { release(); await h.close() }
})

test('a later queued request cannot bypass an earlier request awaiting its first durable save', async () => {
  const calls: string[] = []
  let releaseSave = () => {}
  let savingFirst = false
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => { calls.push(input.userPrompt || ''); input.text('Saved result') }, journal: {
      load: async () => null,
      save: async (record) => {
        if (record.snapshot.id === 'first-saving' && record.snapshot.revision === 0) {
          savingFirst = true
          await new Promise<void>((resolve) => { releaseSave = resolve })
        }
      }
    }
  })
  const first = h.api.start(request({ id: 'first-saving', prompt: 'first', queue: true }))
  try {
    await until(async () => savingFirst)
    await h.api.start(request({ id: 'second-saving', prompt: 'second', queue: true }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [], 'the later same-directory request must wait for the earlier durable enqueue')
    releaseSave(); await first
    await until(async () => (await h.api.run('second-saving')).status === 'completed')
    assert.deepEqual(calls, ['first', 'second'])
  } finally { releaseSave(); await first; await h.close() }
})

test('a failed initial enqueue write wakes later queued requests without executing the failed one', async () => {
  const calls: string[] = []
  let releaseSave = () => {}
  let savingFirst = false
  let failFirst = true
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => { calls.push(input.userPrompt || ''); input.text('Saved result') }, journal: {
      load: async () => null,
      save: async (record) => {
        if (failFirst && record.snapshot.id === 'failed-saving' && record.snapshot.revision === 0) {
          savingFirst = true
          await new Promise<void>((resolve) => { releaseSave = resolve })
          throw new Error('initial save failed')
        }
      }
    }
  })
  const first = h.api.start(request({ id: 'failed-saving', prompt: 'must not execute', queue: true }))
  const rejected = assert.rejects(first, /未调用模型/)
  try {
    await until(async () => savingFirst)
    await h.api.start(request({ id: 'following-saving', prompt: 'following', queue: true }))
    releaseSave(); await rejected
    await until(async () => (await h.api.run('following-saving')).status === 'completed')
    assert.deepEqual(calls, ['following'])
  } finally { releaseSave(); await rejected; failFirst = false; await h.close() }
})

test('an unrelated real directory can execute while an earlier enqueue is still saving', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-queue-independent-'))
  const firstDirectory = path.join(root, 'first'), secondDirectory = path.join(root, 'second')
  fs.mkdirSync(firstDirectory); fs.mkdirSync(secondDirectory)
  const calls: string[] = []
  let releaseSave = () => {}
  let savingFirst = false
  const h = createRuntime({ directory: (_id, directory) => directory!, providers: async () => structuredClone(catalog),
    execute: async (input) => { calls.push(input.userPrompt || ''); input.text('Independent result') }, journal: {
      load: async () => null,
      save: async (record) => {
        if (record.snapshot.id === 'slow-directory' && record.snapshot.revision === 0) {
          savingFirst = true
          await new Promise<void>((resolve) => { releaseSave = resolve })
        }
      }
    }
  })
  const first = h.api.start(request({ id: 'slow-directory', workspaceId: 'first-space', directory: firstDirectory, prompt: 'first', queue: true }))
  try {
    await until(async () => savingFirst)
    await h.api.start(request({ id: 'independent-directory', workspaceId: 'second-space', directory: secondDirectory, prompt: 'independent', queue: true }))
    await until(async () => (await h.api.run('independent-directory')).status === 'completed')
    assert.deepEqual(calls, ['independent'], 'an unrelated directory must not wait behind the slow journal write')
    releaseSave(); await first
    await until(async () => (await h.api.run('slow-directory')).status === 'completed')
    assert.deepEqual(calls, ['independent', 'first'])
  } finally {
    releaseSave(); await first; await h.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('grok-queue-independent-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a queued autosave cannot make an initial write failure look durably saved', async () => {
  const disk = new Map<string, RunRecord>()
  let releaseSave = () => {}
  let savingFirst = false
  let failFirstSave = true
  const h = createRuntime({ directory: () => process.cwd(), providers: async () => structuredClone(catalog),
    execute: async (input) => input.text('Following result'), journal: {
      load: async (id) => structuredClone(disk.get(id) || null),
      save: async (record) => {
        if (failFirstSave && record.snapshot.id === 'failed-autosave' && record.snapshot.revision === 0) {
          savingFirst = true
          await new Promise<void>((resolve) => { releaseSave = resolve })
          failFirstSave = false
          throw new Error('initial save failed')
        }
        disk.set(record.snapshot.id, structuredClone(record))
      }
    }
  })
  const first = h.api.start(request({ id: 'failed-autosave', queue: true }))
  const rejected = assert.rejects(first, /未调用模型/)
  try {
    await until(async () => savingFirst)
    await h.api.start(request({ id: 'following-autosave', queue: true }))
    // The production debounce is 500ms. Let its queued-position snapshot join
    // the save tail while the initial durable write is deliberately blocked.
    await new Promise((resolve) => setTimeout(resolve, 550))
    releaseSave(); await rejected
    await until(async () => (await h.api.run('following-autosave')).status === 'completed')
    const failed = await h.api.run('failed-autosave')
    assert.equal(failed.status, 'failed')
    await h.close()
    assert.deepEqual(disk.get('failed-autosave')?.snapshot, failed,
      'closing must save the actual failed snapshot, not retain an older queued snapshot at the same revision')
  } finally { releaseSave(); await rejected; failFirstSave = false; await h.close() }
})

test('project execution and skills use source cwd while uploads and previews retain a separate asset scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bound-directory-'))
  const previousHome = process.env.GROK_HOME
  process.env.GROK_HOME = path.join(root, 'state')
  const inputs: any[] = []
  const assets = path.join(root, 'managed-assets')
  fs.mkdirSync(assets)
  const h = createRuntime({ directory: workspaceDir, assetDirectory: () => assets, providers: async () => structuredClone(catalog), execute: async (input) => { inputs.push(input) } })
  try {
    const directory = await h.api.prepareDirectory({ mode: 'new', parent: root, name: '项目 files' })
    const image = await h.api.upload('bound-project', { name: 'sample.png', data: fs.readFileSync('resources/icon.png').toString('base64') }, directory)
    assert.ok(image.path.startsWith(assets + path.sep))
    assert.equal(fs.existsSync(path.join(directory, 'attachments')), false)
    assert.equal((await h.api.media('bound-project', image.path, directory)).kind, 'image')
    const skill = await h.api.createSkill('bound-project', { name: 'project-check', description: 'inspect project', scope: 'project' }, directory)
    assert.ok(skill.ok)
    const skills = await h.api.skills('bound-child', directory)
    const local = skills.find((item) => item.name === 'project-check')!
    assert.ok(local.path.startsWith(directory + path.sep))
    assert.match((await h.api.readSkill('bound-child', local.path, directory))?.body || '', /inspect project/)
    await h.api.toggleSkill('bound-child', 'project-check', true, directory)
    assert.equal((await h.api.skills('bound-project', directory)).find((item) => item.name === 'project-check')?.disabled, true)
    const r = request({ id: 'bound-run', workspaceId: 'bound-child', assetScopeId: 'bound-project', directory, attachments: [image] })
    await h.api.start(r)
    await until(async () => (await h.api.run(r.id)).status === 'completed')
    assert.equal(inputs[0].cwd, directory)
    assert.equal((await h.api.run(r.id)).replies[0].cwd, directory)
    const missing = path.join(root, 'missing')
    await assert.rejects(h.api.start(request({ id: 'missing-directory', directory: missing })), /不存在/)
    const continued = await h.api.upload('bound-project', { name: 'file.txt', data: '' }, missing)
    assert.ok(continued.path.startsWith(assets + path.sep))
    assert.equal(fs.existsSync(missing), false)
    assert.equal(inputs.length, 1)
    assert.throws(() => validateRequest(request({ directory: 'relative' })), /绝对路径/)
    assert.throws(() => validateRequest(request({ directory: 123 as any })), /绝对路径/)
  } finally {
    await h.close()
    if (previousHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-bound-directory-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('uploaded files and images reach each participating agent; invalid attachments never execute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-runtime-upload-'))
  const seen: any[] = []
  const h = createRuntime({ directory: () => dir, assetDirectory: () => dir, providers: async () => structuredClone(catalog), execute: async (input) => { seen.push(input) } })
  try {
    const image = await h.api.upload('test-space', { name: 'sample.png', data: fs.readFileSync('resources/icon.png').toString('base64') })
    const file = await h.api.upload('test-space', { name: 'notes.txt', data: Buffer.from('reference text').toString('base64') })
    await assert.rejects(h.api.upload('../escape', { name: 'x', data: '' }), /编号/)
    await assert.rejects(h.api.start(request({ attachments: [{ ...image, path: path.resolve('resources/icon.png') }] })), /当前对话/)
    assert.equal(seen.length, 0)
    const r = request({ attachments: [image, file], employees: [employee('a'), employee('b', 'grok')] })
    await h.api.start(r)
    await until(async () => (await h.api.run(r.id)).status === 'completed')
    assert.equal(seen.length, 2)
    for (const input of seen) {
      assert.equal(input.attachments[0].mime, 'image/png')
      assert.equal(input.hasImageContext, true)
      assert.equal(input.attachments[1].name, 'notes.txt')
      assert.match(input.prompt, /sample.png/)
      assert.match(input.prompt, /notes.txt/)
      assert.equal(fs.readFileSync(input.attachments[1].path, 'utf8'), 'reference text')
    }
  } finally { h.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('follow-up image edits receive image context from recent conversation history', async () => {
  const seen: any[] = []
  const h = harness(async (input: any) => { seen.push(input) })
  try {
    const r = request({ prompt: '衣服换成jk', context: [{ author: '主 agent', text: '图片文件：images/portrait.png' }] })
    await h.api.start(r)
    await until(async () => (await h.api.run(r.id)).status === 'completed')
    assert.equal(seen[0].hasImageContext, true)
    assert.equal(seen[0].userPrompt, '衣服换成jk')
    const next = request({ id: 'no-image', prompt: '修改这段说明', context: [{ author: '用户', text: '普通文字' }] })
    await h.api.start(next)
    await until(async () => (await h.api.run(next.id)).status === 'completed')
    assert.equal(seen[1].hasImageContext, false)
  } finally { h.close() }
})

test('validates recipients, traversal, malformed data and model configuration types', () => {
  validateRequest(request())
  for (const patch of [
    { workspaceId: '../escape' },
    { id: {} },
    { employees: [null] },
    { employees: [employee('a'), employee('a')] },
    { employees: [{ ...employee('a'), model: {} }] },
    { prompt: ' '.repeat(5) },
    { artifacts: [{ name: 'a', content: 3 }] }
  ])
    assert.throws(() => validateRequest(request(patch as any)))
})
test('context budget retains recent messages and latest prompt, reports omitted artifacts', () => {
  const r = request({
    prompt: '不可丢失的本次请求',
    context: [
      { author: 'old', text: 'a'.repeat(60001) },
      { author: 'recent', text: '最近消息' }
    ],
    artifacts: [{ name: 'big', content: 'b'.repeat(60001) }]
  })
  const context = buildContext(r)
  assert.equal(context.trimmed, true)
  assert.match(context.text, /最近消息/)
  assert.match(context.text, /不可丢失/)
  assert.ok(context.text.length < 61000)
})
test('executes employees in order, passes role/persona and preceding reply, honors model/effort', async () => {
  const seen: any[] = []
  const h = harness(async (input: any) => {
    seen.push(input)
    input.text(input.employee.id === 'a' ? 'SHARED-42' : '已读')
  })
  const r = request({ employees: [employee('a'), employee('b', 'grok')] })
  await h.api.start(r)
  await until(async () => (await h.api.run(r.id)).status === 'completed')
  assert.equal(seen.length, 2)
  assert.match(seen[1].prompt, /SHARED-42/)
  assert.match(seen[0].instructions, /核对资料/)
  assert.match(seen[0].instructions, /简短/)
  assert.equal(seen[0].employee.effort, 'low')
  assert.equal(seen[0].employee.model, 'model-a')
  assert.equal(r.employees[0].model, 'model-a')
  h.close()
})
test('duplicate start is idempotent, changed payload and concurrent workspace run rejected', async () => {
  let release!: () => void
  let calls = 0
  const h = harness(async () => {
    calls++
    await new Promise<void>((r) => {
      release = r
    })
  })
  const r = request()
  await h.api.start(r)
  await until(async () => calls === 1)
  await h.api.start(r)
  assert.equal(calls, 1)
  await assert.rejects(h.api.start({ ...r, prompt: 'different' }), /冲突/)
  await assert.rejects(h.api.start({ ...r, id: 'another' }), /已有执行/)
  release()
  await until(async () => (await h.api.run(r.id)).status === 'completed')
  h.close()
})
test('validates every employee before first execution and rejects unsupported reasoning', async () => {
  let calls = 0
  const h = harness(async () => {
    calls++
  })
  const r = request({ employees: [employee('a'), { ...employee('b'), effort: 'ultra' }] })
  await h.api.start(r)
  await until(async () => (await h.api.run(r.id)).status === 'failed')
  assert.equal(calls, 0)
  assert.match((await h.api.run(r.id)).error!, /不支持/)
  h.close()
})
test('signed-out provider never executes or silently falls back', async () => {
  let calls = 0
  const h = harness(
    async () => {
      calls++
    },
    async () => catalog.map((p) => ({ ...p, auth: { ...p.auth!, signedIn: false } }))
  )
  await h.api.start(request())
  await until(async () => (await h.api.run('test-run')).status === 'failed')
  assert.equal(calls, 0)
  h.close()
})
test('Claude catalog entries do not grant execution without an authorized account', async () => {
  let calls = 0
  const h = harness(async () => { calls++ }, async () => [{ ...catalog[0], id: 'claude',
    auth: { signedIn: false, email: null, name: null, userId: null } }])
  try {
    await h.api.start(request({ employees: [{ ...employee('claude-lead'), provider: 'claude' }] }))
    await until(async () => (await h.api.run('test-run')).status === 'failed')
    assert.equal(calls, 0)
    assert.match((await h.api.run('test-run')).error!, /登录 claude/)
  } finally { h.close() }
})

test('explicit usage authentication failures override stale signed-in diagnostics', async () => {
  for (const error of ['auth', 'signed_out']) {
    let calls = 0
    const h = harness(async () => { calls++ }, async () => catalog.map((provider) => ({ ...provider,
      usage: { plan: null, fetchedAt: new Date().toISOString(), windows: [], error } })))
    try {
      await h.api.start(request())
      await until(async () => (await h.api.run('test-run')).status === 'failed')
      assert.equal(calls, 0)
      assert.match((await h.api.run('test-run')).error!, /登录/)
    } finally { h.close() }
  }
})

test('a usage network error alone does not sign an authorized account out', async () => {
  let calls = 0
  const h = harness(async (input: any) => { calls++; input.text('verified') }, async () => catalog.map((provider) => ({ ...provider,
    usage: { plan: null, fetchedAt: new Date().toISOString(), windows: [], error: 'network' } })))
  try {
    await h.api.start(request())
    await until(async () => (await h.api.run('test-run')).status === 'completed')
    assert.equal(calls, 1)
  } finally { h.close() }
})

test('permission only accepts offered choice, is single-use and resumes execution', async () => {
  let decision = ''
  const h = harness(async (input: any) => {
    decision = await input.permission('操作', '详情', [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ])
    input.text(decision)
  })
  await h.api.start(request())
  await until(async () => (await h.api.run('test-run')).status === 'needs_permission')
  const p = (await h.api.run('test-run')).permissions[0]
  await assert.rejects(h.api.permission('test-run', p.id, 'always'), /无效/)
  await h.api.permission('test-run', p.id, 'deny')
  await assert.rejects(h.api.permission('test-run', p.id, 'allow'), /失效/)
  await until(async () => (await h.api.run('test-run')).status === 'completed')
  assert.equal(decision, 'deny')
  h.close()
})
test('cancellation rejects pending permission, preserves partial text and prevents later employees', async () => {
  let calls = 0
  const h = harness(async (input: any) => {
    calls++
    input.text('partial')
    await input.permission('操作', '详情', [{ id: 'allow', label: '允许' }])
  })
  await h.api.start(request({ employees: [employee('a'), employee('b')] }))
  await until(async () => (await h.api.run('test-run')).status === 'needs_permission')
  await h.api.cancel('test-run')
  await until(async () => (await h.api.run('test-run')).status === 'cancelled')
  const result = await h.api.run('test-run')
  assert.equal(calls, 1)
  assert.equal(result.replies[0].text, 'partial')
  assert.equal(result.permissions.length, 0)
  h.close()
})
test('adapter failure preserves partial reply and records error without completing other employees', async () => {
  const h = harness(async (input: any) => {
    input.text('partial')
    throw Error('provider unavailable')
  })
  await h.api.start(request())
  await until(async () => (await h.api.run('test-run')).status === 'failed')
  const result = await h.api.run('test-run')
  assert.equal(result.replies[0].text, 'partial')
  assert.match(result.error!, /provider unavailable/)
  h.close()
})
for (const outcome of ['failure', 'cancellation'] as const) test(`${outcome} preserves completed tool receipts and partial file changes`, async () => {
  const parent = path.resolve('.tmp')
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'partial-receipts-'))
  const h = createRuntime({ providers: async () => structuredClone(catalog), directory: () => directory,
    skills: () => [], archive: async () => path.join(directory, 'context.json'),
    execute: async (input) => {
      input.receipt?.({ filesRead: ['source.txt'], commands: [{ command: 'check', exitCode: 0 }] })
      fs.writeFileSync(path.join(directory, 'partial.txt'), 'work completed before interruption')
      input.text('partial')
      if (outcome === 'failure') throw new Error('provider disconnected')
      await input.permission('next operation', 'await confirmation', [{ id: 'allow', label: '允许' }])
    }
  })
  try {
    await h.api.start(request())
    if (outcome === 'cancellation') {
      await until(async () => (await h.api.run('test-run')).status === 'needs_permission')
      await h.api.cancel('test-run')
    }
    await until(async () => !!(await h.api.run('test-run')).finishedAt)
    const result = await h.api.run('test-run')
    assert.equal(result.status, outcome === 'failure' ? 'failed' : 'cancelled')
    assert.equal(result.replies[0].text, 'partial')
    assert.deepEqual(result.replies[0].receipt?.filesRead, ['source.txt'])
    assert.deepEqual(result.replies[0].receipt?.commands, [{ command: 'check', exitCode: 0 }])
    assert.ok(result.replies[0].receipt?.filesModified?.includes('partial.txt'))
    assert.equal(result.metrics?.fileScans, 2)
  } finally {
    await h.close()
    assert.ok(path.resolve(directory).startsWith(parent + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('cancellation during final archiving remains cancelled after cleanup', async () => {
  const parent = path.resolve('.tmp')
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'cancel-archive-'))
  let archiving = false
  let release = () => {}
  const h = createRuntime({ providers: async () => structuredClone(catalog), directory: () => directory,
    skills: () => [], execute: async (input) => { input.text('completed employee output') },
    archive: async (_cwd, _request, handoffs) => {
      if (handoffs.length) {
        archiving = true
        await new Promise<void>((resolve) => { release = resolve })
      }
      return path.join(directory, 'context.json')
    }
  })
  try {
    await h.api.start(request())
    await until(async () => archiving)
    assert.equal((await h.api.cancel('test-run')).status, 'cancelled')
    release()
    await until(async () => !!(await h.api.run('test-run')).finishedAt)
    const result = await h.api.run('test-run')
    assert.equal(result.status, 'cancelled')
    assert.match(result.error!, /用户已停止/)
    assert.equal(result.replies[0].text, 'completed employee output')
    assert.equal(result.replies[0].status, 'completed', 'finished work remains available after cancelling cleanup')
  } finally {
    release()
    await h.close()
    assert.ok(path.resolve(directory).startsWith(parent + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('JSON RPC handles UTF-8 split frames, server errors, timeout, and process close', async () => {
  const program = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='hang')continue;if(m.method==='exit'){process.exit(0)}const r=Buffer.from(JSON.stringify(m.method==='fail'?{id:m.id,error:{message:'bad request'}}:{id:m.id,result:'你好'})+'\\n');process.stdout.write(r.subarray(0,r.length-4));setTimeout(()=>process.stdout.write(r.subarray(r.length-4)),5)}})`
  const rpc = new StdioRpc({ file: process.execPath, args: ['-e', program] }, process.cwd())
  try {
    assert.equal(await rpc.request('hello', {}), '你好')
    await assert.rejects(rpc.request('fail', {}), /bad request/)
    await assert.rejects(rpc.request('hang', {}, 20), /超时/)
    await assert.rejects(rpc.request('exit', {}), /退出/)
  } finally {
    rpc.close()
  }
})

for (const noise of ['null', '42', '[]', '{"id":1}', '{"method":2,"id":1}', '{"id":1,"error":null}']) test(`JSON RPC ignores invalid protocol output ${noise} without losing a pending response`, async () => {
  const program = `process.stdin.once('data', d => { const m = JSON.parse(d); process.stdout.write(${JSON.stringify(noise + '\n')} + JSON.stringify({jsonrpc:'2.0',id:m.id,result:'valid reply'}) + '\\n') })`
  const rpc = new StdioRpc({ file: process.execPath, args: ['-e', program] }, process.cwd())
  try {
    assert.equal(await rpc.request('hello', {}, 500), 'valid reply')
  } finally { await rpc.stop() }
})

test('runtime shutdown waits for starts already recovering a persisted run', async () => {
  let loading = false
  let release = () => {}
  let closed = false
  let calls = 0
  const h = createRuntime({ providers: async () => structuredClone(catalog), directory: () => process.cwd(),
    execute: async () => { calls++ }, journal: {
      load: async () => { loading = true; await new Promise<void>((resolve) => { release = resolve }); return null },
      save: async () => {}
    }
  })
  const starting = h.api.start(request())
  const rejected = assert.rejects(starting, /已关闭/)
  let closing: Promise<void> | undefined
  try {
    await until(async () => loading)
    closing = h.close().then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown cannot finish while journal recovery is still using the runtime')
    release()
    await closing
    await rejected
    assert.equal(calls, 0)
  } finally {
    release()
    await rejected
    await closing
    await h.close()
  }
})

test('runtime shutdown waits for an in-flight recovered record to be durably marked interrupted', async () => {
  let releaseLoad = () => {}
  let releaseSave = () => {}
  let loading = false
  let saving = false
  let closed = false
  const h = createRuntime({ providers: async () => structuredClone(catalog), directory: () => process.cwd(),
    execute: async () => assert.fail('recovery must not execute a model'), journal: {
      load: async () => {
        loading = true
        await new Promise<void>((resolve) => { releaseLoad = resolve })
        return { version: 1, fingerprint: 'a'.repeat(64), snapshot: {
          id: 'interrupted-run', workspaceId: 'test-space', status: 'running', replies: [], permissions: [],
          revision: 1, createdAt: new Date().toISOString(), contextTrimmed: false
        } }
      },
      save: async () => { saving = true; await new Promise<void>((resolve) => { releaseSave = resolve }) }
    }
  })
  const recovering = h.api.run('interrupted-run')
  let closing: Promise<void> | undefined
  try {
    await until(async () => loading)
    closing = h.close().then(() => { closed = true })
    releaseLoad()
    await until(async () => saving)
    assert.equal(closed, false)
    releaseSave()
    const result = await recovering
    await closing
    assert.equal(result.status, 'failed')
    assert.equal(result.interrupted, true)
  } finally {
    releaseLoad()
    releaseSave()
    await recovering
    await closing
    await h.close()
  }
})

test('image-only replies persist and share file references with the next employee', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-runtime-image-'))
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII='
  let shared = ''
  const h = createRuntime({ providers: async () => structuredClone(catalog), directory: () => dir, assetDirectory: () => dir,
    execute: async (input) => {
      if (input.employee.id === 'a') {
        input.media?.({ type: 'image', mimeType: 'image/png', data: png })
        input.media?.({ type: 'image', mimeType: 'image/png', data: png })
      } else { shared = input.prompt; input.text('已收到图片') }
    }
  })
  try {
    await h.api.start(request({ employees: [employee('a'), employee('b')] }))
    await until(async () => (await h.api.run('test-run')).status === 'completed')
    const reply = (await h.api.run('test-run')).replies[0]
    assert.equal(reply.text, '')
    assert.equal(reply.images?.length, 1)
    assert.equal(reply.images![0].dataUrl, undefined)
    const handoffs = JSON.parse(shared.slice(shared.lastIndexOf('\n') + 1))
    assert.ok(handoffs.some((item: { images: string[] }) => item.images.includes(reply.images![0].path!)))
    assert.ok((await h.api.media('test-space', reply.images![0].path!)).dataUrl)
  } finally { h.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('cancelled runs retain directory exclusivity until the adapter finishes cleanup', async () => {
  let release!: () => void
  let started = false
  const h = harness(async () => { started = true; await new Promise<void>((r) => { release = r }) })
  try {
    await h.api.start(request())
    await until(async () => started)
    await h.api.cancel('test-run')
    await assert.rejects(h.api.start(request({ id: 'second' })), /已有执行/)
    await assert.rejects(h.api.start(request({ id: 'sibling', workspaceId: 'different-space' })), /已有执行/)
    release()
    await new Promise((r) => setImmediate(r))
    started = false
    await h.api.start(request({ id: 'second' }))
    await until(async () => started)
    release()
  } finally { h.close() }
})

test('snapshots are immutable copies with monotonic revisions and shutdown rejects new work', async () => {
  let input: any
  let release!: () => void
  const h = harness(async (value: any) => { input = value; await new Promise<void>((r) => { release = r }) })
  await h.api.start(request())
  await until(async () => !!input)
  const before = await h.api.run('test-run')
  before.status = 'completed'
  before.replies[0].text = 'tampered'
  input.text('actual')
  const after = await h.api.run('test-run')
  assert.equal(after.status, 'running')
  assert.equal(after.replies[0].text, 'actual')
  assert.ok(after.revision! > before.revision!)
  release()
  h.close()
  await assert.rejects(h.api.start(request({ id: 'after-close' })), /已关闭/)
})

test('execution inspects only selected providers and reports missing catalog entries clearly', async () => {
  let selected: string[] = []
  let calls = 0
  const h = createRuntime({ directory: () => process.cwd(), execute: async () => { calls++ },
    providers: async (_refresh, ids) => { selected = ids || []; return [] }
  })
  try {
    await h.api.start(request())
    await until(async () => (await h.api.run('test-run')).status === 'failed')
    assert.deepEqual(selected, ['codex'])
    assert.equal(calls, 0)
    assert.match((await h.api.run('test-run')).error!, /未找到所选模型提供商/)
  } finally { h.close() }
})

test('provider caching coalesces duplicate probes without waiting for unrelated clients', async () => {
  const calls: string[] = []
  let release!: () => void
  let now = 0
  const catalogFor = createProviderCatalog(async (id) => {
    calls.push(id)
    if (id === 'grok') await new Promise<void>((r) => { release = r })
    return structuredClone(catalog.find((p) => p.id === id)!)
  }, ['grok', 'codex'], () => now)
  const slow = catalogFor(false, ['grok'])
  const duplicate = catalogFor(false, ['grok'])
  const fast = await catalogFor(false, ['codex'])
  assert.deepEqual(calls.sort(), ['codex', 'grok'])
  fast[0].models.length = 0
  assert.equal((await catalogFor(false, ['codex']))[0].models.length, 1)
  release()
  await Promise.all([slow, duplicate])
  await catalogFor(false, ['codex'])
  assert.equal(calls.length, 2)
  now = 300001
  await catalogFor(false, ['codex'])
  assert.equal(calls.length, 3)
})

test('escaped history and artifact names count toward the shared context budget', () => {
  const result = buildContext(request({ context: [{ author: 'quote', text: '"'.repeat(40000) }],
    artifacts: [{ name: 'large', content: '\\'.repeat(40000) }] }))
  assert.ok(result.trimmed)
  assert.ok(result.text.length < 61000)
})

test('long agent handoffs remain valid, attributed JSON within the handoff budget', async () => {
  let prompt = ''
  const h = harness(async (input: any) => {
    prompt = input.prompt
    input.text('"'.repeat(40000) + input.employee.id)
  })
  try {
    await h.api.start(request({ employees: [employee('a'), employee('b'), employee('c'), employee('d')] }))
    await until(async () => (await h.api.run('test-run')).status === 'completed')
    const raw = prompt.slice(prompt.lastIndexOf('\n') + 1)
    assert.ok(raw.length <= 80000)
    const entries = JSON.parse(raw)
    assert.equal(entries.at(-1).employeeId, 'c')
    assert.equal(entries.at(-1).name, 'c')
    assert.ok(entries.every((entry: any) => entry.truncated && entry.text.endsWith(entry.employeeId)))
    assert.ok((await h.api.run('test-run')).contextTrimmed)
  } finally { h.close() }
})
