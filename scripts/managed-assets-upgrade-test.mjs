import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readWorkspace, seedWorkspace, waitForWorkspace, workspaceStorageNames } from './desktop-test-storage.mjs'

// Account-free installed 0.1.24 -> current -> installed 0.1.24 -> current,
// with actual source-directory and managed uploads in one isolated profile.
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--old-exe', '--new-exe', '--output-dir', '--playwright'].includes(process.argv[i]) && process.argv[i + 1])
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
const require = createRequire(import.meta.url)
const oldExe = path.resolve(options['old-exe'] || 'release/legacy-installed-0.1.24/Grok.exe')
const newExe = path.resolve(options['new-exe'] || require('electron'))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.25/managed-upgrade')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'journey-'))
const home = path.join(root, 'home'), profile = path.join(root, 'profile'), source = path.join(root, 'source')
for (const directory of [home, profile, source, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(source, 'source.ts'), 'export const upgradeFixture = true\n')
const imageFile = path.join(root, 'new-managed-upload.png'), imageBytes = fs.readFileSync('resources/icon.png')
fs.writeFileSync(imageFile, imageBytes)
const pw = await import(pathToFileURL(options.playwright || process.env.PLAYWRIGHT_PATH ||
  path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)
const { _electron } = pw._electron ? pw : pw.default
const results = [], errors = [], details = {}, screenshots = [], processes = []
let app, page
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const stateDigest = value => digest(Object.fromEntries(['teams', 'activeTeamId', 'drafts', 'attachmentDrafts', 'defaultProvider', 'modelDefaults', 'deletedGalleryKeys'].map(key => [key, value[key]])))
const pass = (name, detail = {}) => { results.push({ name, ok: true, ...detail }); console.log('PASS', name) }
function environment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/i.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
}
async function launch(old, gate = false) {
  app = await _electron.launch({ executablePath: old ? oldExe : newExe,
    args: [`--user-data-dir=${profile}`, ...(!old && !options['new-exe'] ? [process.cwd()] : [])], env: environment(), timeout: 45000 })
  const childProcess = app.process()
  processes.push({ process: childProcess, pid: childProcess.pid, version: old ? 'old' : 'new' })
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(String(error)))
  const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData'), electron: process.versions.electron }))
  assert.equal(path.resolve(metadata.profile), profile)
  assert.equal(metadata.version, old ? '0.1.24' : '0.1.25')
  if (old) assert.equal(metadata.packaged, true)
  details[old ? 'old' : 'new'] = metadata
  await app.evaluate(({ ipcMain }) => {
    globalThis.__assetUpgradeCalls = { starts: 0, logins: 0 }
    for (const channel of ['workspace:start', 'workspace:login']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => { globalThis.__assetUpgradeCalls[channel === 'workspace:start' ? 'starts' : 'logins']++; throw Error('This isolated fixture forbids model and login requests') })
    }
    ipcMain.removeHandler('workspace:providers')
    ipcMain.handle('workspace:providers', () => [])
  })
  await page.locator(gate ? '.workspace-startup-error[role="alert"]' : 'textarea[aria-label="对话消息"]').waitFor()
  assert.equal((await page.evaluate(() => window.grok.snapshot())).auth.signedIn, false)
  if (!gate) await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
}
async function close() {
  if (!app) return
  const closing = app; app = null
  const child = closing.process(); let timer
  try {
    const calls = await closing.evaluate(() => globalThis.__assetUpgradeCalls)
    assert.deepEqual(calls, { starts: 0, logins: 0 })
    await Promise.race([closing.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Electron close timed out')), 15000) })])
  } catch (error) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  } finally { clearTimeout(timer) }
}
function fixture(attachment) {
  const lead = { id: 'lead', provider: 'grok', name: '主 agent', role: 'assistant', persona: '', isLead: true }
  const common = { goal: '', defaultProvider: 'grok', sample: false, paused: false, permissionMode: 'ask', members: [lead], tasks: [], artifacts: [], directory: source }
  const project = { ...common, id: 'asset-upgrade-project', kind: 'project', parentId: null, name: '跨版本开发项目', messages: [] }
  const child = { ...common, id: 'asset-upgrade-child', kind: 'conversation', parentId: project.id, name: '保留图片与附件', messages: [
    { id: 'question', author: 'you', to: 'lead', text: '旧版本历史和附件必须保留。', time: '10:00', kind: 'message', sample: false, attachments: [attachment], cwd: source },
    { id: 'answer', author: 'lead', to: 'all', text: '旧版本图片引用。', time: '10:00', kind: 'message', sample: false, images: [{ path: attachment.path, alt: '旧版本图片' }], cwd: source }
  ] }
  return { version: 2, state: { teams: [project, child], activeTeamId: child.id, drafts: { [child.id]: '旧版本未发送的草稿' }, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
}
async function rows() {
  return page.evaluate(async ({ key, database }) => {
    const request = op => new Promise((resolve, reject) => { op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error) })
    const db = await request(indexedDB.open(database))
    try {
      const tx = db.transaction('records', 'readonly'), store = tx.objectStore('records')
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]); await done
      return keys.map((item, index) => ({ key: item, value: values[index] })).filter(row => row.key[0] === key)
    } finally { db.close() }
  }, workspaceStorageNames)
}
const slot = (records, name) => records.find(row => row.key[1] === name)?.value
async function capture(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await page.waitForTimeout(250)
  const file = path.join(root, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file)
}
function sourceFiles() {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
  return walk(source).sort().map(file => ({ path: path.relative(source, file), hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }))
}
try {
  await launch(true)
  const oldAttachment = await page.evaluate(({ source, data }) => window.grok.workspace.upload('asset-upgrade-project', { name: 'old-source-image.png', data }, source), { source, data: imageBytes.toString('base64') })
  assert.equal(path.dirname(oldAttachment.path), path.join(source, 'attachments'))
  const expected = fixture(oldAttachment)
  await seedWorkspace(page, expected)
  await waitForWorkspace(page, value => stateDigest(value.state) === stateDigest(expected.state))
  assert.equal(slot(await rows(), 'head').format, 2)
  const assistant = await page.evaluate(async () => {
    await window.grok.workspace.updateAssistant('asset-upgrade-project', { name: '跨版本助手', persona: '保留个人偏好' })
    return window.grok.workspace.saveMemory('asset-upgrade-project', { content: '保留本地开发偏好', kind: 'preference' })
  })
  const legacy = await page.evaluate(key => localStorage.getItem(key), workspaceStorageNames.key), sourceBefore = sourceFiles()
  pass('installed 0.1.24 creates source-directory media, assistant memory, child history and drafts in format 2')
  await capture('old-0.1.24-history'); await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), stateDigest(expected.state))
  assert.deepEqual(await page.evaluate(() => window.grok.workspace.assistant('asset-upgrade-project')), assistant)
  pass('0.1.25 reads the prior format without changing historical content or assistant records')

  await page.getByLabel('选择对话附件', { exact: true }).setInputFiles(imageFile)
  let current = await waitForWorkspace(page, value => value.state.attachmentDrafts['asset-upgrade-child']?.length === 1)
  const managed = current.state.attachmentDrafts['asset-upgrade-child'][0]
  assert.equal(path.dirname(managed.path), path.join(home, '.grok/desktop/workspaces/asset-upgrade-project/attachments'))
  assert.deepEqual(fs.readFileSync(managed.path), imageBytes)
  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('新版本已保存的草稿与托管图片，回退不得覆盖。')
  current = await waitForWorkspace(page, value => value.state.drafts['asset-upgrade-child'] === '新版本已保存的草稿与托管图片，回退不得覆盖。')
  const expectedHash = stateDigest(current.state), records = await rows()
  assert.equal(slot(records, 'head').format, 4); assert.equal(slot(records, 'previous').format, 4)
  assert.deepEqual(sourceFiles(), sourceBefore)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), workspaceStorageNames.key), legacy)
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="待发送附件"] img')].some(image => image.complete && image.naturalWidth > 0))
  pass('new UI upload uses the parent managed root, decodes successfully and commits both head and previous as format 4 without source pollution')
  await capture('new-0.1.25-managed-upload'); await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), expectedHash)
  const beforeDowngrade = digest(await rows())
  pass('new version restart retains the managed attachment, all history and latest draft')
  await close(); await launch(true, true)
  assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '恢复上一份快照', exact: true }).count(), 0)
  assert.equal(digest(await rows()), beforeDowngrade)
  await page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await page.locator('.workspace-startup-error[role="alert"]').waitFor()
  assert.equal(digest(await rows()), beforeDowngrade)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), workspaceStorageNames.key), legacy)
  assert.deepEqual(fs.readFileSync(managed.path), imageBytes)
  pass('installed 0.1.24 gates format 4 including previous recovery and preserves every database row, legacy byte and managed asset on retry')
  await capture('old-0.1.24-format-4-gate'); await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), expectedHash)
  assert.deepEqual(await page.evaluate(() => window.grok.workspace.assistant('asset-upgrade-project')), assistant)
  assert.deepEqual(sourceFiles(), sourceBefore)
  const preview = await page.evaluate(({ file, missing }) => window.grok.workspace.media('asset-upgrade-project', file, missing), { file: managed.path, missing: path.join(root, 'missing-source') })
  assert.equal(preview.dataUrl, `data:image/png;base64,${imageBytes.toString('base64')}`)
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="待发送附件"] img')].some(image => image.complete && image.naturalWidth > 0))
  pass('returning to 0.1.25 preserves exact content hashes and assistant records; managed preview works even without source cwd')
  details.hashes = { workspace: expectedHash, beforeDowngradeRecords: beforeDowngrade, managedImage: createHash('sha256').update(imageBytes).digest('hex'), originalSource: digest(sourceBefore), assistant: digest(assistant) }
  await capture('new-0.1.25-after-blocked-downgrade'); await close()
  assert.deepEqual(errors, [])
  assert.ok(processes.every(item => item.process.exitCode !== null || item.process.signalCode !== null))
  pass('all five real app launches close normally with zero model and login requests')
} catch (error) {
  results.push({ name: 'managed asset version upgrade', ok: false, error: error.stack || String(error) }); console.error(error)
  if (page && !page.isClosed()) {
    try { await capture('failure'); fs.writeFileSync(path.join(root, 'failure-ui.txt'), await page.locator('body').innerText()) } catch { /* preserve original failure */ }
  }
} finally {
  try { await close() } catch (error) { errors.push(String(error)) }
  const allProcessesExited = processes.every(item => item.process.exitCode !== null || item.process.signalCode !== null)
  const ok = results.every(item => item.ok) && errors.length === 0 && allProcessesExited
  const reportFile = path.join(root, 'results.json')
  fs.writeFileSync(reportFile, JSON.stringify({ ok, results, details, errors, screenshots, allProcessesExited,
    processes: processes.map(({ process, ...rest }) => ({ ...rest, exitCode: process.exitCode, signalCode: process.signalCode })) }, null, 2))
  console.log(JSON.stringify({ ok, passed: results.filter(item => item.ok).length, allProcessesExited, reportFile }))
  process.exitCode = ok ? 0 : 1
}
