import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readWorkspace, seedWorkspace, waitForWorkspace, workspaceStorageNames } from './desktop-test-storage.mjs'

// Actual 0.1.22 -> current -> 0.1.22 -> current process launches with the same
// isolated profile. No model request, account changes or genuine profile access.
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--old-exe', '--new-exe', '--output-dir', '--playwright'].includes(process.argv[i]) && process.argv[i + 1])
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
const require = createRequire(import.meta.url)
const oldExe = path.resolve(options['old-exe'] || 'release/20261011-quality-0.1.22/installed/Grok.exe')
const newExe = path.resolve(options['new-exe'] || require('electron'))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.23')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'storage-upgrade-'))
const pw = await import(pathToFileURL(options.playwright || process.env.PLAYWRIGHT_PATH ||
  path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)
const { _electron } = pw._electron ? pw : pw.default
const results = [], errors = [], details = {}, screenshots = []
let app, page
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const stateDigest = (value) => digest(Object.fromEntries(['teams', 'activeTeamId', 'drafts', 'attachmentDrafts', 'defaultProvider', 'modelDefaults', 'deletedGalleryKeys'].map((key) => [key, value[key]])))
const pass = (name, detail = {}) => { results.push({ name, ok: true, ...detail }); console.log('PASS', name) }
function environment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/i.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
}
async function launch(old, gate = false, name = 'shared-profile') {
  const home = path.join(root, name, 'home'), profile = path.join(root, name, 'profile')
  for (const directory of [home, profile, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true })
  app = await _electron.launch({ executablePath: old ? oldExe : newExe,
    args: [`--user-data-dir=${profile}`, ...(!old && !options['new-exe'] ? [process.cwd()] : [])], env: environment(home), timeout: 45000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => void dialog.dismiss().catch((error) => { if (!/No dialog is showing/.test(error.message)) errors.push(String(error)) }))
  const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData') }))
  assert.equal(path.resolve(metadata.profile), profile)
  details[`${old ? 'old' : 'new'}-${name}`] = metadata
  await page.locator(gate ? '.workspace-startup-error[role="alert"]' : 'textarea[aria-label="对话消息"]').waitFor()
}
async function close() { if (app) { const closing = app; app = null; await closing.close() } }
function fixture() {
  const lead = { id: 'upgrade-lead', provider: 'grok', name: '主 agent', role: 'assistant', persona: '保留我的自定义沟通方式', isLead: true }
  const team = (id) => ({ id, kind: 'conversation', parentId: null, name: `升级验收 ${id}`, goal: '', defaultProvider: 'grok',
    sample: false, paused: false, permissionMode: 'ask', members: [lead], tasks: [], artifacts: [],
    messages: Array.from({ length: 100 }, (_, i) => ({ id: `${id}-${i}`, author: i % 2 ? lead.id : 'you', to: 'all',
      text: `保留历史 ${id}/${i} ✓\n` + '中文 mixed text '.repeat(100), time: '10:00', kind: 'message', status: 'completed', sample: false })) })
  return { version: 2, state: { teams: [team('upgrade-a'), team('upgrade-b')], activeTeamId: 'upgrade-a',
    drafts: { 'upgrade-a': '旧版本草稿 A', 'upgrade-b': '旧版本草稿 B' }, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
}
async function rows() {
  return page.evaluate(async ({ key, database }) => {
    const request = (op) => new Promise((resolve, reject) => { op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error) })
    const db = await request(indexedDB.open(database))
    try {
      const tx = db.transaction('records', 'readonly'), store = tx.objectStore('records')
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]); await done
      return keys.map((item, index) => ({ key: item, value: values[index] })).filter((row) => row.key[0] === key)
    } finally { db.close() }
  }, workspaceStorageNames)
}
const head = (records) => records.find((row) => row.key[1] === 'head').value
async function capture(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  const file = path.join(root, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file)
}
async function settings() {
  await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
  return page.locator('.workspace-data-settings')
}
async function exportBackup() {
  const file = path.join(root, 'portable-backup.json'), section = await settings()
  await app.evaluate(({ session }, file) => {
    globalThis.__upgradeDownload = 'pending'
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file); item.once('done', (_event, state) => { globalThis.__upgradeDownload = state })
    })
  }, file)
  await section.getByRole('button', { name: '导出工作区备份', exact: true }).click()
  const end = Date.now() + 15000
  while (Date.now() < end && await app.evaluate(() => globalThis.__upgradeDownload) === 'pending') await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await app.evaluate(() => globalThis.__upgradeDownload), 'completed')
  await page.locator('.settings-close').click()
  return file
}
try {
  const expected = fixture()
  await launch(true)
  assert.equal(details['old-shared-profile'].version, '0.1.22')
  await seedWorkspace(page, expected)
  await waitForWorkspace(page, (value) => stateDigest(value.state) === stateDigest(expected.state))
  assert.equal(head(await rows()).format, 1)
  pass('installed 0.1.22 saves a real format 1 database with 200 messages and two drafts')
  const legacy = await page.evaluate((key) => localStorage.getItem(key), workspaceStorageNames.key)
  await close()

  await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), stateDigest(expected.state))
  pass('new build loads format 1 history and drafts without loss')
  expected.state.drafts['upgrade-a'] = '新版最新草稿；不能由旧版本读取过时副本覆盖。'
  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(expected.state.drafts['upgrade-a'])
  await waitForWorkspace(page, (value) => stateDigest(value.state) === stateDigest(expected.state))
  assert.equal(head(await rows()).format, 4)
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), workspaceStorageNames.key), legacy)
  pass('new save commits format 4 and leaves retained legacy bytes unchanged')
  const backup = await exportBackup()
  assert.equal(stateDigest(JSON.parse(fs.readFileSync(backup, 'utf8')).state), stateDigest(expected.state))
  pass('new version exports a portable backup matching all persisted contents')
  await capture('upgraded-format-4')
  await close()

  await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), stateDigest(expected.state))
  const beforeDowngrade = digest(await rows())
  pass('restart reads format 4 without losing the latest draft')
  await close()

  await launch(true, true)
  assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
  assert.equal(digest(await rows()), beforeDowngrade)
  await page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await page.locator('.workspace-startup-error[role="alert"]').waitFor()
  assert.equal(digest(await rows()), beforeDowngrade)
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), workspaceStorageNames.key), legacy)
  pass('0.1.22 safely gates format 4; retry does not overwrite database or silently use old localStorage')
  await capture('old-version-safely-gated')
  await close()

  await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), stateDigest(expected.state))
  pass('returning to new build restores every message and latest draft after blocked downgrade')
  await close()

  await launch(true, false, 'explicit-backup-restore')
  const section = await settings()
  await page.getByLabel('导入工作区备份文件', { exact: true }).setInputFiles(backup)
  await section.getByRole('checkbox', { name: '我确认用此备份替换本地工作区' }).check()
  await section.getByRole('button', { name: '确认替换并恢复', exact: true }).click()
  await waitForWorkspace(page, (value) => stateDigest(value.state) === stateDigest(expected.state))
  assert.equal(head(await rows()).format, 1)
  pass('explicitly importing the new backup into a separate old-version profile preserves all tested content')
  await close()
  assert.deepEqual(errors, [])
  pass('no renderer exceptions across upgrade, blocked downgrade and explicit backup restore')
} catch (error) {
  results.push({ name: 'storage upgrade journey', ok: false, error: error.stack || String(error) })
  console.error(error)
} finally {
  try { await close() } catch (error) { errors.push(String(error)) }
  const reportFile = path.join(root, 'results.json'), ok = results.every((item) => item.ok) && errors.length === 0
  fs.writeFileSync(reportFile, JSON.stringify({ ok, results, details, errors, screenshots }, null, 2))
  console.log(JSON.stringify({ ok, passed: results.filter((item) => item.ok).length, reportFile }))
  process.exitCode = ok ? 0 : 1
}
