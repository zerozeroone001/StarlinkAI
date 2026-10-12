import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { seedWorkspace, waitForWorkspace } from './desktop-test-storage.mjs'

// Real renderer/preload/IPC with isolated provider diagnostics; never sends a prompt.
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const explicitExe = option('--exe', undefined)
const executablePath = path.resolve(explicitExe || require('electron'))
const output = path.resolve(option('--output-dir', '.tmp/iteration-0122/providers'))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'journey-'))
const home = path.join(root, 'home'), userData = path.join(root, 'user-data')
fs.mkdirSync(home, { recursive: true })
let entry = process.env.PLAYWRIGHT_PATH
if (!entry) { try { entry = require.resolve('playwright') } catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') } }
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const imported = await import(pathToFileURL(entry).href)
const { _electron } = imported._electron ? imported : imported.default
const env = { ...process.env, GROK_HOME: path.join(home, '.grok'), HOME: home, USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key) ||
  /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
const results = [], errors = [], metrics = {}
let app, page
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.error('PASS', name) }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error('FAIL', name, error.message) }
}
const settings = async () => page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
try {
  app = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, ...(!explicitExe ? [process.cwd()] : [])], env, timeout: 45000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
  await app.evaluate(({ ipcMain }) => {
    globalThis.__providerFixture = { mode: 'slow', calls: {}, completed: {}, sends: 0 }
    globalThis.__providerSlow = new Promise((resolve) => { globalThis.__releaseProvider = resolve })
    ipcMain.removeHandler('workspace:providers')
    ipcMain.handle('workspace:providers', async (_event, _refresh, ids = ['claude', 'codex', 'grok', 'gemini']) => Promise.all(ids.map(async (id) => {
      const fixture = globalThis.__providerFixture
      fixture.calls[id] = (fixture.calls[id] || 0) + 1
      if (id === 'codex' && ['slow', 'selected-failure'].includes(fixture.mode)) await globalThis.__providerSlow
      if (id === 'gemini' && fixture.mode === 'failure') throw new Error('Gemini fixture unavailable')
      if (id === 'grok' && fixture.mode === 'selected-failure') throw new Error('Grok fixture unavailable: timeout Bearer fixture-secret-token\n at private-fixture.ts:10')
      fixture.completed[id] = (fixture.completed[id] || 0) + 1
      return { id, cli: { state: 'installed', path: 'offline-fixture', version: '1.0' }, checkedAt: new Date().toISOString(),
        auth: { signedIn: id === 'grok', email: id === 'grok' ? 'offline@example.test' : null, name: null, userId: null },
        models: id === 'grok' ? [{ id: 'offline-fast', name: 'Offline fast model', efforts: ['low', 'high'], isDefault: true }] : [],
        usage: null, loginCommand: 'offline-fixture' }
    })))
    ipcMain.removeHandler('workspace:start')
    ipcMain.handle('workspace:start', () => { globalThis.__providerFixture.sends++; throw new Error('This journey must not send model requests') })
  })
  const started = performance.now()
  await page.reload()
  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('只验证可发送状态，不发送请求。')
  await check('a ready Grok account enables composing before unrelated Codex completes', async () => {
    await page.waitForFunction(() => !document.querySelector('button[aria-label="发送消息"]').disabled, null, { timeout: 1800 })
    metrics.readyComposerMs = Math.round(performance.now() - started)
    assert.equal(await app.evaluate(() => globalThis.__providerFixture.completed.codex || 0), 0)
  })
  await settings()
  await check('the ready account exposes its model picker while another provider is checking', async () => {
    const card = page.getByRole('region', { name: 'Grok 账号卡片', exact: true })
    await card.waitFor({ timeout: 1200 })
    assert.equal(await card.getByRole('combobox', { name: '具体型号', exact: true }).isEnabled(), true)
    await card.getByRole('combobox', { name: '具体型号', exact: true }).selectOption('offline-fast')
    assert.equal(await card.getByRole('button', { name: '刷新状态', exact: true }).isEnabled(), true)
  })
  await page.screenshot({ path: path.join(root, 'partial-ready.png') })
  await app.evaluate(() => { globalThis.__providerFixture.mode = 'ready'; globalThis.__releaseProvider() })
  await page.getByRole('button', { name: '全部刷新', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.__providerFixture.mode = 'failure' })
  await page.getByRole('button', { name: '全部刷新', exact: true }).click()
  await page.getByText('Gemini fixture unavailable', { exact: false }).first().waitFor()
  await page.locator('.settings-close').click()
  await check('a failed unrelated provider does not disable a successfully checked account', async () => {
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true)
  })
  await settings()
  await check('failed providers can be retried individually without probing ready accounts again', async () => {
    const before = await app.evaluate(() => ({ ...globalThis.__providerFixture.calls }))
    await app.evaluate(() => { globalThis.__providerFixture.mode = 'ready' })
    await page.getByRole('button', { name: '重新检测 Gemini', exact: true }).click({ timeout: 1000 })
    await page.getByText('Gemini fixture unavailable', { exact: false }).waitFor({ state: 'hidden' })
    const after = await app.evaluate(() => ({ ...globalThis.__providerFixture.calls }))
    assert.equal(after.gemini, before.gemini + 1)
    assert.equal(after.grok, before.grok)
    assert.equal(after.codex, before.codex)
    assert.equal(after.claude, before.claude)
  })
  await page.screenshot({ path: path.join(root, 'provider-recovery.png') })
  await check('the composer retries its failed provider while an unrelated inspection remains pending', async () => {
    const codexCompleted = await app.evaluate(() => globalThis.__providerFixture.completed.codex)
    await app.evaluate(() => {
      globalThis.__providerFixture.mode = 'selected-failure'
      globalThis.__providerSlow = new Promise((resolve) => { globalThis.__releaseProvider = resolve })
    })
    await page.getByRole('button', { name: '全部刷新', exact: true }).click()
    await page.getByText('Grok fixture unavailable', { exact: false }).first().waitFor()
    await page.locator('.settings-close').click()
    const retry = page.locator('.composer-account-notice').getByRole('button', { name: '重新检测', exact: true })
    await retry.waitFor()
    const notice = page.locator('.composer-account-notice')
    assert.match(await notice.innerText(), /检测超时，请重试/)
    assert.doesNotMatch(await notice.innerText(), /Bearer|fixture-secret|private-fixture|Error invoking/)
    assert.equal(await notice.getByRole('button', { name: '模型与账号', exact: true }).isEnabled(), true)
    assert.equal(await retry.isEnabled(), true, 'an unrelated pending inspection cannot disable the selected provider retry')
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), false)
    const before = await app.evaluate(() => ({ ...globalThis.__providerFixture.calls }))
    await page.screenshot({ path: path.join(root, 'composer-retry.png') })
    await app.evaluate(() => { globalThis.__providerFixture.mode = 'slow' })
    await retry.click()
    await page.waitForFunction(() => !document.querySelector('button[aria-label="发送消息"]').disabled)
    const after = await app.evaluate(() => ({ ...globalThis.__providerFixture.calls }))
    assert.equal(after.grok, before.grok + 1)
    for (const id of ['codex', 'claude', 'gemini']) assert.equal(after[id], before[id])
    assert.equal(await app.evaluate(() => globalThis.__providerFixture.completed.codex), codexCompleted)
    await page.screenshot({ path: path.join(root, 'composer-recovered.png') })
  })
  await app.evaluate(() => { globalThis.__providerFixture.mode = 'ready'; globalThis.__releaseProvider() })
  await check('connection loss shows an uncertain state, preserves output and recovers without sending again', async () => {
    const value = await waitForWorkspace(page, (value) => value?.state.teams.some((team) => team.id === value.state.activeTeamId))
    const team = value.state.teams.find((team) => team.id === value.state.activeTeamId)
    team.messages = [{ id: 'provider-run-source', author: 'you', to: 'all', text: '离线断连验收', time: '10:00',
      kind: 'message', sample: false, status: 'running', runId: 'provider-run-fixture' }]
    const run = { id: 'provider-run-fixture', workspaceId: team.id, revision: 1, status: 'running', interaction: 'conversation',
      createdAt: new Date().toISOString(), permissions: [], contextTrimmed: false,
      replies: [{ id: 'provider-partial', employeeId: team.members[0].id, provider: 'grok', model: 'offline-fast', text: '断连前收到的部分输出', status: 'running' }] }
    await app.evaluate(({ ipcMain }, run) => {
      globalThis.__connectionFixture = { disconnected: false, run }
      ipcMain.removeHandler('workspace:run')
      ipcMain.handle('workspace:run', (_event, id) => {
        if (id !== run.id) throw new Error('Unexpected offline run')
        if (globalThis.__connectionFixture.disconnected) throw new Error('ECONNRESET offline fixture')
        return globalThis.__connectionFixture.run
      })
    }, run)
    await seedWorkspace(page, value)
    await page.getByText('断连前收到的部分输出', { exact: true }).waitFor()
    await app.evaluate(() => { globalThis.__connectionFixture.disconnected = true })
    await page.getByRole('button', { name: '立即重连', exact: true }).waitFor()
    const status = page.getByRole('status', { name: '执行状态', exact: true })
    assert.match(await status.innerText(), /连接中断 · 执行状态待确认/)
    assert.doesNotMatch(await status.innerText(), /回复中/)
    assert.equal(await status.locator('.runtime-pulse').count(), 0)
    assert.equal(await status.getByRole('button', { name: '停止生成', exact: true }).isEnabled(), true)
    assert.equal(await page.getByText('断连前收到的部分输出', { exact: true }).isVisible(), true)
    await page.screenshot({ path: path.join(root, 'connection-lost.png') })
    await app.evaluate(() => { globalThis.__connectionFixture.disconnected = false })
    await page.getByRole('button', { name: '立即重连', exact: true }).click()
    await page.getByRole('button', { name: '立即重连', exact: true }).waitFor({ state: 'hidden' })
    assert.match(await status.innerText(), /回复中/)
    assert.equal(await status.locator('.runtime-pulse').count(), 1)
    assert.equal(await page.getByText('断连前收到的部分输出', { exact: true }).isVisible(), true)
    assert.equal(await app.evaluate(() => globalThis.__providerFixture.sends), 0)
    await page.screenshot({ path: path.join(root, 'connection-recovered.png') })
    await app.evaluate(() => {
      globalThis.__connectionFixture.run.revision++
      globalThis.__connectionFixture.run.status = 'completed'
      globalThis.__connectionFixture.run.replies[0].status = 'completed'
    })
    await status.waitFor({ state: 'hidden' })
  })
  await check('no model requests or renderer errors', async () => {
    assert.equal(await app.evaluate(() => globalThis.__providerFixture.sends), 0)
    assert.deepEqual(errors, [])
  })
} catch (error) { results.push({ name: 'harness', ok: false, error: error.stack }) }
finally {
  if (app) await check('clean exit', () => app.close())
  const report = { ok: results.length > 0 && results.every((item) => item.ok), executablePath, root, metrics, results, errors }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
