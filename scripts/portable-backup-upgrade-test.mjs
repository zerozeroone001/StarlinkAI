import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readWorkspace, seedWorkspace, waitForWorkspace, workspaceStorageNames } from './desktop-test-storage.mjs'

// Real installed 0.1.23 -> current portable restore -> blocked downgrade ->
// current rollback, using a single isolated profile and synthetic local data.
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--old-exe', '--new-exe', '--output-dir', '--playwright'].includes(process.argv[i]) && process.argv[i + 1])
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
const require = createRequire(import.meta.url)
const oldExe = path.resolve(options['old-exe'] || 'release/20261011-quality-0.1.23/installed/Grok.exe')
const newExe = path.resolve(options['new-exe'] || require('electron'))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.24')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'portable-upgrade-'))
const home = path.join(root, 'home'), profile = path.join(root, 'profile'), archive = path.join(root, 'synthetic-portable.zip')
const pw = await import(pathToFileURL(options.playwright || process.env.PLAYWRIGHT_PATH ||
  path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)
const { _electron } = pw._electron ? pw : pw.default
const results = [], errors = [], details = {}, screenshots = []
let app, page
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const savedFields = (value) => Object.fromEntries(['teams', 'activeTeamId', 'drafts', 'attachmentDrafts', 'defaultProvider', 'modelDefaults', 'deletedGalleryKeys'].map((key) => [key, value[key]]))
const stateDigest = (value) => digest(savedFields(value))
const contentDigest = (value) => digest(value.teams.map((team) => ({ name: team.name, texts: team.messages.map((message) => message.text),
  draft: value.drafts[team.id] || '', taskTexts: team.tasks.map((task) => task.title), artifactTexts: team.artifacts.map((artifact) => artifact.content) })).sort((a, b) => a.name.localeCompare(b.name)))
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
  for (const directory of [home, profile, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true })
  app = await _electron.launch({ executablePath: old ? oldExe : newExe,
    args: [`--user-data-dir=${profile}`, ...(!old && !options['new-exe'] ? [process.cwd()] : [])], env: environment(), timeout: 45000 })
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => void dialog.dismiss().catch((error) => { if (!/No dialog is showing/.test(error.message)) errors.push(String(error)) }))
  const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData'), electron: process.versions.electron }))
  assert.equal(path.resolve(metadata.profile), profile); details[old ? 'old' : 'new'] = metadata
  await page.locator(gate ? '.workspace-startup-error[role="alert"]' : 'textarea[aria-label="对话消息"]').waitFor()
  assert.equal((await page.evaluate(() => window.grok.snapshot())).auth.signedIn, false)
  if (!gate) await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
  if (!old) await app.evaluate(({ dialog }, file) => {
    globalThis.__portableDialogs = []
    dialog.showSaveDialog = async (...args) => {
      globalThis.__portableDialogs.push({ kind: 'save', options: args.at(-1) })
      return { canceled: false, filePath: file }
    }
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1); globalThis.__portableDialogs.push({ kind: 'open', options })
      if (options.properties?.includes('openDirectory')) throw Error('Synthetic text-only fixture must not request source-directory access')
      return { canceled: false, filePaths: [file] }
    }
  }, archive)
}
async function close() {
  if (!app) return
  const closing = app; app = null
  const child = closing.process(); let timer
  try { await Promise.race([closing.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Electron close timed out')), 15000) })]) }
  catch (error) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  } finally { clearTimeout(timer) }
}
function fixture() {
  const lead = { id: 'portable-lead', provider: 'grok', name: '主 agent', role: 'assistant', persona: '保留我的沟通方式', isLead: true }
  const team = (id) => ({ id, kind: 'conversation', parentId: null, name: `便携升级验收 ${id}`, goal: '', defaultProvider: 'grok',
    sample: false, paused: false, permissionMode: 'ask', members: [lead], tasks: [], artifacts: [],
    messages: Array.from({ length: 80 }, (_, i) => ({ id: `${id}-${i}`, author: i % 2 ? lead.id : 'you', to: 'all',
      text: `历史 ${id}/${i} ✓\n` + '中文 mixed text '.repeat(40), time: '10:00', kind: 'message', status: 'completed', sample: false })) })
  return { version: 2, state: { teams: [team('portable-a'), team('portable-b')], activeTeamId: 'portable-a',
    drafts: { 'portable-a': '导出时草稿 A', 'portable-b': '导出时草稿 B' }, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
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
const slot = (records, name) => records.find((row) => row.key[1] === name)?.value
function snapshot(records, head) {
  const row = (type, key) => records.find((row) => row.key[1] === type && row.key[2] === key)?.value
  return { ...head.meta, teams: head.teams.map((ref) => {
    const team = { ...row('team', ref.key).value }
    for (const [name, refs] of Object.entries(ref.collections || {})) team[name] = refs.map((item) => row({ messages: 'message', tasks: 'task', artifacts: 'artifact' }[name], item.key).value)
    return team
  }) }
}
async function capture(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await page.waitForTimeout(200)
  const file = path.join(root, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file)
}
async function settings() {
  await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
  return page.locator('.workspace-data-settings')
}
async function rollback() {
  const section = await settings()
  await section.getByRole('button', { name: '回退到替换前的工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '回退到替换前的工作区', exact: true })
  await dialog.getByRole('checkbox', { name: '我确认回退并替换当前工作区及助手资料', exact: true }).check()
  await dialog.getByRole('button', { name: '确认回退', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' }); await page.locator('.settings-close').click()
}
try {
  const expected = fixture()
  await launch(true); assert.equal(details.old.version, '0.1.23')
  await seedWorkspace(page, expected)
  await waitForWorkspace(page, (value) => stateDigest(value.state) === stateDigest(expected.state))
  assert.equal(slot(await rows(), 'head').format, 2)
  const sourceAssistant = await page.evaluate(async () => {
    await window.grok.workspace.updateAssistant('portable-a', { name: '保留记忆的助理', persona: '跨版本保持身份' })
    await window.grok.workspace.saveMemory('portable-a', { content: '固定测试记忆', kind: 'fact' })
    return window.grok.workspace.saveCommitment('portable-a', { title: '未来提醒', dueAt: '2099-01-01T00:00:00.000Z' })
  })
  const legacy = await page.evaluate((key) => localStorage.getItem(key), workspaceStorageNames.key)
  pass('installed 0.1.23 persists format 2 history, drafts and independent assistant memory')
  await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), stateDigest(expected.state))
  pass('new build loads the old format 2 workspace without data loss')
  const section = await settings(); await section.getByRole('button', { name: '导出便携 ZIP', exact: true }).click()
  const exportDialog = page.getByRole('dialog', { name: '导出便携备份', exact: true })
  await exportDialog.getByRole('button', { name: '选择位置并导出 ZIP', exact: true }).click()
  await exportDialog.waitFor({ state: 'hidden' }); assert.ok(fs.statSync(archive).size > 0)
  await page.locator('.settings-close').click()
  pass('portable ZIP export completes through the real renderer and main-process codec')

  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('替换前最新草稿：回退必须找回此内容')
  const original = await waitForWorkspace(page, (v) => v.state.drafts['portable-a'] === '替换前最新草稿：回退必须找回此内容')
  const originalHash = stateDigest(original.state)
  await (await settings()).getByRole('button', { name: '选择便携备份并预览', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: '预览并恢复便携备份', exact: true })
  await importDialog.getByRole('checkbox', { name: '我确认用此备份替换工作区及助手资料', exact: true }).check()
  await importDialog.getByRole('button', { name: '确认替换并恢复便携备份', exact: true }).click()
  await importDialog.waitFor({ state: 'hidden' }); await page.locator('.settings-close').click()
  const imported = await waitForWorkspace(page, (v) => v.state.teams.every((team) => !['portable-a', 'portable-b'].includes(team.id)))
  assert.equal(contentDigest(imported.state), contentDigest(expected.state))
  let records = await rows()
  assert.equal(slot(records, 'head').format, 4); assert.equal(slot(records, 'previous').format, 4)
  assert.equal(stateDigest(snapshot(records, slot(records, 'restorePoint').head)), originalHash)
  const importMarker = slot(records, 'importMarker').value
  assert.ok(importMarker)
  const importedScope = imported.state.teams.find((team) => team.name.endsWith('portable-a')).id
  const assistant = await page.evaluate((id) => window.grok.workspace.assistant(id), importedScope)
  assert.equal(assistant.remindersPaused, true); assert.deepEqual(assistant.memories, sourceAssistant.memories)
  assert.deepEqual(assistant.commitments, sourceAssistant.commitments)
  pass('portable restore remaps identities, preserves assistant records, pauses reminders and commits format 4 plus fixed rollback point')

  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('导入后继续编辑，固定恢复点不得轮换')
  const edited = await waitForWorkspace(page, (v) => v.state.drafts[v.state.activeTeamId] === '导入后继续编辑，固定恢复点不得轮换')
  records = await rows()
  assert.equal(stateDigest(snapshot(records, slot(records, 'restorePoint').head)), originalHash)
  assert.equal(slot(records, 'importMarker').value, importMarker)
  const editedHash = stateDigest(edited.state)
  await capture('portable-imported-format-4'); await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), editedHash)
  records = await rows(); const beforeDowngrade = digest(records)
  pass('ordinary editing and restart retain the complete fixed rollback point')
  await close(); await launch(true, true)
  assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '恢复上一份快照', exact: true }).count(), 0)
  assert.equal(digest(await rows()), beforeDowngrade)
  await page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await page.locator('.workspace-startup-error[role="alert"]').waitFor()
  assert.equal(digest(await rows()), beforeDowngrade)
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), workspaceStorageNames.key), legacy)
  await capture('old-0.1.23-format-4-gate')
  pass('installed 0.1.23 gates format 4 and cannot bypass the pin through previous recovery; retry preserves every DB row and legacy byte')
  await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), editedHash)
  pass('returning to new build preserves all imported history and latest draft after blocked downgrade')
  await rollback()
  const restored = await waitForWorkspace(page, (v) => stateDigest(v.state) === originalHash)
  assert.equal(stateDigest(restored.state), originalHash)
  records = await rows(); assert.equal(slot(records, 'head').format, 4)
  assert.equal(stateDigest(snapshot(records, slot(records, 'restorePoint').head)), editedHash)
  assert.notEqual(slot(records, 'importMarker').value, importMarker)
  const originalAssistant = await page.evaluate(() => window.grok.workspace.assistant('portable-a'))
  assert.deepEqual(originalAssistant.memories, sourceAssistant.memories)
  assert.deepEqual(originalAssistant.commitments, sourceAssistant.commitments)
  assert.equal(originalAssistant.remindersPaused, false)
  await capture('portable-rollback-restored')
  pass('explicit rollback restores pre-import workspace and assistant scope while retaining the imported workspace as the next rollback point')
  await close(); await launch(false)
  assert.equal(stateDigest((await readWorkspace(page)).state), originalHash)
  await rollback(); await waitForWorkspace(page, (v) => stateDigest(v.state) === editedHash)
  pass('rollback survives restart and can itself be undone without losing either workspace')
  details.hashes = { original: originalHash, imported: editedHash, blockedDowngradeRecords: beforeDowngrade }
  assert.deepEqual(errors, []); await close()
  pass('all applications close normally with no renderer exceptions or model requests')
} catch (error) {
  results.push({ name: 'portable upgrade journey', ok: false, error: error.stack || String(error) }); console.error(error)
  try { if (page && !page.isClosed()) await capture('failure') } catch { /* retain original error */ }
} finally {
  try { await close() } catch (error) { errors.push(String(error)) }
  const reportFile = path.join(root, 'results.json'), ok = results.every((item) => item.ok) && errors.length === 0
  fs.writeFileSync(reportFile, JSON.stringify({ ok, results, details, errors, screenshots }, null, 2))
  console.log(JSON.stringify({ ok, passed: results.filter((item) => item.ok).length, reportFile })); process.exitCode = ok ? 0 : 1
}
