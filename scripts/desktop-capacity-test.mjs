import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readWorkspace, waitForWorkspace, WORKSPACE_STORAGE_KEY, WORKSPACE_DATABASE_NAME } from './desktop-test-storage.mjs'

// Real capacity and durability checks. Fixtures contain only synthetic local
// history. Native storage is timed without changing its behavior or quota.
// Build/install separately. Nonzero exit means a product or harness check failed.
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--exe', '--app', '--playwright', '--output-dir', '--sizes'].includes(key) || !process.argv[index + 1])
    throw new Error(`Unsupported or incomplete option: ${key}`)
  options[key.slice(2)] = process.argv[index + 1]
}
const require = createRequire(import.meta.url)
const executable = path.resolve(options.exe || require('electron'))
const application = options.app || (options.exe ? null : '.')
const sizes = (options.sizes || '2,4,6,9,12').split(',').map(Number)
assert.ok(sizes.every((size) => Number.isFinite(size) && size >= 0.1 && size <= 16), 'sizes must be between 0.1 and 16 MiB')
assert.ok(fs.existsSync(executable), 'Electron executable does not exist')
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.22')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'capacity-'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportFile = path.join(output, `desktop-capacity-${runId}.json`)
let entry = options.playwright || process.env.PLAYWRIGHT_PATH
if (!entry) {
  try { entry = require.resolve('playwright') }
  catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') }
}
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const module = await import(pathToFileURL(entry).href)
const { _electron } = module._electron ? module : module.default
const results = [], scenarios = [], rendererErrors = []
let metadata
const rounded = (n) => Math.round(n * 100) / 100
const hash = (text) => createHash('sha256').update(text).digest('hex')
const record = (name, ok, details = {}) => {
  results.push({ name, ok, ...details })
  console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${details.error ? `: ${details.error}` : ''}`)
}
const check = async (name, fn) => {
  try { record(name, true, await fn() || {}); return true }
  catch (error) { record(name, false, { error: error.message }); return false }
}
process.on('unhandledRejection', (error) => record('unhandled harness rejection', false, { error: String(error) }))
function environment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }
}
function fixture(size) {
  const messages = Array.from({ length: size ? 240 : 60 }, (_, index) => ({ id: `message-${index}`,
    author: index % 2 ? 'capacity-lead' : 'you', to: 'all', time: '10:00', kind: 'message', sample: false,
    status: 'completed', text: `Synthetic capacity history ${index}. No model request.` }))
  const team = { id: size ? `capacity-${size}` : 'capacity-baseline', kind: 'conversation', parentId: null,
    defaultProvider: 'grok', name: size ? `容量验收 ${size} MiB` : '小工作区基线', goal: '', sample: false, paused: false,
    permissionMode: 'ask', members: [{ id: 'capacity-lead', name: '主 agent', provider: 'grok', role: 'assistant', persona: '', isLead: true }],
    messages, tasks: [], artifacts: [] }
  const value = { format: 'workspace-backup', version: 1, createdAt: '2026-01-01T00:00:00.000Z',
    state: { teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
  if (size) {
    const target = Math.round(size * 1024 * 1024)
    const remaining = target - Buffer.byteLength(JSON.stringify(value))
    const count = messages.length - 60
    for (let index = 0; index < count; index++) messages[index].text += 'x'.repeat(Math.floor(remaining / count) + (index < remaining % count ? 1 : 0))
    assert.equal(Buffer.byteLength(JSON.stringify(value)), target)
  }
  return value
}
function summarize(state) {
  return { activeTeamId: state.activeTeamId, teams: state.teams.map((team) => ({ id: team.id,
    messages: team.messages.length, messageChars: team.messages.reduce((sum, message) => sum + message.text.length, 0),
    contentSha256: hash(JSON.stringify(team.messages.map((message) => ({ id: message.id, text: message.text })))) })),
    drafts: Object.fromEntries(Object.entries(state.drafts).map(([id, text]) => [id, { chars: text.length, sha256: hash(text) }])) }
}
async function close(app) {
  const child = app.process()
  let timer
  try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron did not exit within 15 seconds')), 15000) })]) }
  catch (error) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  } finally { clearTimeout(timer) }
}
async function launch(directory, label) {
  const home = path.join(directory, 'home'), userData = path.join(directory, 'profile')
  for (const item of [home, userData, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(item, { recursive: true })
  const started = performance.now()
  const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`, ...(application ? [path.resolve(application)] : [])],
    env: environment(home), timeout: 45000 })
  try {
    const page = await app.firstWindow({ timeout: 30000 })
    page.setDefaultTimeout(20000)
    page.on('pageerror', (error) => rendererErrors.push({ label, message: error.message }))
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron,
      packaged: app.isPackaged, userData: app.getPath('userData') }))
    assert.equal(path.resolve(info.userData), path.resolve(userData), 'test must use its isolated profile')
    metadata ||= { version: info.version, electron: info.electron, packaged: info.packaged }
    const snapshot = await page.evaluate(() => window.grok.snapshot())
    assert.equal(snapshot.auth.signedIn, false, 'test must be account-free')
    await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
    await page.evaluate(({ key, database }) => {
      window.__capacitySamples = { writes: [], longTasks: [] }
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (name, value) {
        if (name !== key) return original.call(this, name, value)
        const start = performance.now()
        let errorName
        try { return original.call(this, name, value) }
        catch (error) { errorName = error.name; throw error }
        finally { window.__capacitySamples.writes.push({ storage: 'localStorage', chars: value.length, durationMs: performance.now() - start, errorName: errorName || null }) }
      }
      const transaction = IDBDatabase.prototype.transaction
      const samples = new WeakMap()
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args)
        if (this.name === database && args[1] === 'readwrite') {
          const started = performance.now(), sample = { storage: 'indexedDB', records: 0, teamRecords: 0 }
          samples.set(tx, sample)
          const finished = () => window.__capacitySamples.writes.push({ ...sample,
            durationMs: performance.now() - started, errorName: tx.error?.name || null })
          tx.addEventListener('complete', finished)
          tx.addEventListener('abort', () => {
            if (!tx.error) window.__capacitySamples.writes.push({ ...sample, durationMs: performance.now() - started, errorName: 'AbortError' })
            else finished()
          })
        }
        return tx
      }
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, ...args) {
        const sample = samples.get(this.transaction)
        if (sample) { sample.records++; if (value?.kind === 'workspace-team') sample.teamRecords++ }
        return put.call(this, value, ...args)
      }
      new PerformanceObserver((list) => { for (const task of list.getEntries()) window.__capacitySamples.longTasks.push(task.duration) }).observe({ type: 'longtask', buffered: false })
    }, { key: WORKSPACE_STORAGE_KEY, database: WORKSPACE_DATABASE_NAME })
    return { app, page, startupMs: rounded(performance.now() - started) }
  } catch (error) { await close(app); throw error }
}
async function settings(page) {
  if (!await page.getByRole('region', { name: '工作区数据' }).isVisible()) {
    await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
  }
  return page.getByRole('region', { name: '工作区数据' })
}
async function importBackup(page, file) {
  const section = await settings(page)
  const started = performance.now()
  await page.getByLabel('导入工作区备份文件', { exact: true }).setInputFiles(file)
  const confirm = section.getByRole('button', { name: '确认替换并恢复', exact: true })
  await confirm.waitFor()
  assert.equal(await confirm.isEnabled(), false)
  const validatedMs = rounded(performance.now() - started)
  await section.getByRole('checkbox', { name: '我确认用此备份替换本地工作区' }).check()
  const clicked = performance.now()
  await confirm.click()
  await section.getByRole('status').filter({ hasText: '工作区已恢复' }).waitFor()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return { validateMs: validatedMs, confirmToPaintMs: rounded(performance.now() - clicked) }
}
async function exportBackup(app, page, file) {
  const section = await settings(page)
  await app.evaluate(({ session }, file) => {
    globalThis.__capacityDownload = 'pending'
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file)
      item.once('done', (_event, state) => { globalThis.__capacityDownload = state })
    })
  }, file)
  await section.getByRole('button', { name: '导出工作区备份', exact: true }).click()
  const deadline = Date.now() + 15000
  let state
  while (Date.now() < deadline) {
    state = await app.evaluate(() => globalThis.__capacityDownload)
    if (state !== 'pending') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(state, 'completed', 'export of live memory must complete')
  return JSON.parse(fs.readFileSync(file, 'utf8')).state
}
async function screenshot(app, page, file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.screenshot({ path: file })
    const colors = await app.evaluate(({ nativeImage }, file) => {
      const data = nativeImage.createFromPath(file).toBitmap(), colors = new Set()
      const stride = Math.max(4, Math.floor(data.length / 16384) * 4)
      for (let index = 0; index < data.length; index += stride) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`)
      return colors.size
    }, file)
    if (colors > 8) return path.relative(output, file)
  }
  throw new Error('Screenshot remained blank after paint waits')
}
async function scenario(size) {
  const label = `${size} MiB`, directory = path.join(root, `size-${size}`)
  fs.mkdirSync(directory, { recursive: true })
  const base = fixture(0), target = fixture(size), targetText = JSON.stringify(target)
  const baseFile = path.join(directory, 'baseline.json'), targetFile = path.join(directory, 'capacity.json')
  fs.writeFileSync(baseFile, JSON.stringify(base)); fs.writeFileSync(targetFile, targetText)
  const detail = { sizeMiB: size, fixtureBytes: Buffer.byteLength(targetText), fixtureSha256: hash(targetText), latest60MaxChars: Math.max(...target.state.teams[0].messages.slice(-60).map((message) => message.text.length)) }
  scenarios.push(detail)
  let app, page
  try {
    ({ app, page, startupMs: detail.startupMs } = await launch(directory, label))
    await importBackup(page, baseFile)
    await waitForWorkspace(page, (value) => value?.state.activeTeamId === base.state.activeTeamId, { label: 'small baseline committed' })
    await page.evaluate(() => { window.__capacitySamples.writes = []; window.__capacitySamples.longTasks = [] })
    detail.import = await importBackup(page, targetFile)
    await check(`${label}: imported history is committed to workspace storage`, async () => {
      await waitForWorkspace(page, (value) => value && JSON.stringify(summarize(value.state)) === JSON.stringify(summarize(target.state)), { label: `${label} import persisted` })
    })
    detail.importWrites = await page.evaluate(() => window.__capacitySamples.writes)
    detail.alertsAfterImport = await page.getByRole('alert').allTextContents()
    detail.importScreenshot = await screenshot(app, page, path.join(directory, 'import.png'))
    const imported = summarize(await exportBackup(app, page, path.join(directory, 'memory-imported.json')))
    detail.memoryAfterImport = imported
    record(`${label}: legal backup restored fully into memory`, JSON.stringify(imported) === JSON.stringify(summarize(target.state)))
    const quotaFailures = detail.importWrites.filter((item) => item.errorName === 'QuotaExceededError')
    detail.nativeQuotaFailures = quotaFailures.length
    const writeFailures = detail.importWrites.filter((item) => item.errorName)
    record(`${label}: persistence accepts legal backup`, detail.importWrites.length > 0 && writeFailures.length === 0,
      writeFailures.length ? { error: `Native storage failed on ${writeFailures.length} writes: ${writeFailures.map((item) => item.errorName).join(', ')}` }
        : !detail.importWrites.length ? { error: 'No native persistence transaction was observed' } : {})
    if (quotaFailures.length) record(`${label}: real quota failure is visible to the user`, detail.alertsAfterImport.some((text) => /保存失败|存储写入失败/.test(text)))
    await page.locator('.settings-close').click()
    const composer = page.getByRole('textbox', { name: '对话消息', exact: true })
    const draft = `capacity-${size}-latest-draft`
    await page.evaluate(() => { window.__capacitySamples.writes = []; window.__capacitySamples.longTasks = [] })
    const editStart = performance.now()
    await composer.pressSequentially(draft)
    detail.draftInputMs = rounded(performance.now() - editStart)
    await waitForWorkspace(page, (value) => value?.state.drafts[target.state.activeTeamId] === draft, { label: 'latest draft committed' })
    detail.draftWrites = await page.evaluate(() => window.__capacitySamples.writes)
    detail.draftTeamRecordsWritten = detail.draftWrites.reduce((sum, item) => sum + (item.teamRecords || 0), 0)
    if (detail.draftWrites.some((item) => item.storage === 'indexedDB'))
      record(`${label}: draft edits do not rewrite unchanged conversation history`, detail.draftTeamRecordsWritten === 0)
    detail.longTasksMs = await page.evaluate(() => window.__capacitySamples.longTasks.map((n) => Math.round(n * 100) / 100))
    detail.draftScreenshot = await screenshot(app, page, path.join(directory, 'draft.png'))
    detail.memoryBeforeExit = summarize(await exportBackup(app, page, path.join(directory, 'memory-before-exit.json')))
    target.state.drafts[target.state.activeTeamId] = draft
    const expected = summarize(target.state)
    record(`${label}: draft remains exportable from live memory`, JSON.stringify(detail.memoryBeforeExit) === JSON.stringify(expected))
    const quitStart = performance.now()
    await close(app); app = null
    detail.shutdownMs = rounded(performance.now() - quitStart)
    ;({ app, page, startupMs: detail.restartMs } = await launch(directory, `${label} restarted`))
    detail.persistedAfterRestart = summarize((await readWorkspace(page)).state)
    detail.restartScreenshot = await screenshot(app, page, path.join(directory, 'restart.png'))
    detail.afterRestart = summarize(await exportBackup(app, page, path.join(directory, 'after-restart.json')))
    detail.retainedAfterRestart = JSON.stringify(detail.afterRestart) === JSON.stringify(expected)
    detail.revertedToSmallBaseline = JSON.stringify(detail.afterRestart) === JSON.stringify(summarize(base.state))
    record(`${label}: confirmed import and latest draft survive process restart`, detail.retainedAfterRestart,
      detail.retainedAfterRestart ? {} : { error: detail.revertedToSmallBaseline ? 'Reverted to the old small workspace; imported history and draft are absent' : 'Restarted state does not match the exported live memory' })
    const writes = detail.draftWrites.map((item) => item.durationMs).sort((a, b) => a - b)
    detail.draftStorageSummary = { writes: writes.length, totalMs: rounded(writes.reduce((sum, n) => sum + n, 0)),
      medianMs: rounded(writes[Math.floor(writes.length / 2)] || 0), maxMs: rounded(writes.at(-1) || 0), failures: detail.draftWrites.filter((item) => item.errorName).length }
  } catch (error) { record(`${label}: harness`, false, { error: error.message }) }
  finally { if (app) await check(`${label}: clean exit`, () => close(app)) }
}
try { for (const size of sizes) await scenario(size) }
finally {
  record('no uncaught renderer errors', rendererErrors.length === 0)
  const report = { ok: results.every((result) => result.ok), runId, metadata, modelPromptsSent: 0,
    isolation: 'Fresh profile, GROK_HOME, provider homes and disabled proxy per scenario. No user credentials.',
    instrumentation: 'Native IndexedDB transaction completion/abort and record-write timing; legacy Storage.setItem timing retained. No quota or runtime mocks.',
    scenarios, results, rendererErrors }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: report.ok, reportFile, scenarios: scenarios.map((item) => ({ sizeMiB: item.sizeMiB,
    nativeQuotaFailures: item.nativeQuotaFailures, retainedAfterRestart: item.retainedAfterRestart, draftInputMs: item.draftInputMs,
    draftStorageSummary: item.draftStorageSummary })) }, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
