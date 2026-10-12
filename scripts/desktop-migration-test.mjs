import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readWorkspace, waitForWorkspace, failWorkspaceWrites, restoreWorkspaceWrites,
  WORKSPACE_STORAGE_KEY as key, WORKSPACE_DATABASE_NAME as database } from './desktop-test-storage.mjs'

// Upgrade a real 0.1.21 profile through the old UI, then launch current out using
// that exact profile. All data is synthetic and no provider request is submitted.
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  if (!['--old-exe', '--new-exe', '--project', '--output-dir', '--playwright', '--include-reload', '--only-reload', '--include-close', '--only-close'].includes(name) || !process.argv[index + 1])
    throw new Error(`Unsupported or incomplete option: ${name}`)
  options[name.slice(2)] = process.argv[index + 1]
}
const project = path.resolve(options.project || '.'), require = createRequire(import.meta.url)
const oldExe = path.resolve(options['old-exe'] || 'release/20261011-commercial/installed/Grok.exe')
const newExe = path.resolve(options['new-exe'] || require('electron'))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.22')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'migration-'))
const reportFile = path.join(root, 'results.json'), results = [], screenshots = [], errors = [], details = {}
let entry = options.playwright || process.env.PLAYWRIGHT_PATH
if (!entry) {
  try { entry = require.resolve('playwright') }
  catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') }
}
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const loaded = await import(pathToFileURL(entry).href), { _electron } = loaded._electron ? loaded : loaded.default
const hash = (text) => createHash('sha256').update(text).digest('hex')
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, canonical(item)])) : value
const portable = (value) => Object.fromEntries(['teams', 'activeTeamId', 'drafts', 'attachmentDrafts', 'defaultProvider', 'modelDefaults', 'deletedGalleryKeys'].map((name) => [name, value[name]]))
const digest = (value) => hash(JSON.stringify(canonical(portable(value))))
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true, ...detail }); console.error('PASS', name); return true }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.error('FAIL', name, error.message); return false }
}
process.on('unhandledRejection', (error) => { errors.push(String(error)); console.error('UNHANDLED', String(error)) })
function env(home) {
  const result = { ...process.env }
  for (const name of Object.keys(result)) if (/^(?:ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/.test(name) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(name)) delete result[name]
  return { ...result, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }
}
function fixture() {
  const member = { id: 'migration-lead', provider: 'grok', name: '主 agent', role: 'assistant', persona: '', isLead: true }
  const team = (id, title) => ({ id, kind: 'conversation', parentId: null, name: title, goal: '', defaultProvider: 'grok',
    sample: false, paused: false, permissionMode: 'ask', members: [member], tasks: [], artifacts: [],
    messages: Array.from({ length: 80 }, (_, index) => ({ id: `${id}-${index}`, author: index % 2 ? member.id : 'you', to: 'all',
      text: `迁移验收 ${id} 消息 ${index}；固定 Unicode 内容 ✓。`, time: '10:00', kind: 'message', status: 'completed', sample: false })) })
  return { format: 'workspace-backup', version: 1, createdAt: '2026-01-01T00:00:00.000Z', state: {
    teams: [team('migration-one', '迁移验收一'), team('migration-two', '迁移验收二')], activeTeamId: 'migration-one',
    drafts: { 'migration-one': '旧版本当前草稿', 'migration-two': '旧版本另一个草稿' }, attachmentDrafts: {},
    defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
}
async function close(app) {
  const child = app.process(); let timer
  try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron close timed out')), 15000) })]) }
  catch (error) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  } finally { clearTimeout(timer) }
}
async function launch(name, old = false, expectGate = false) {
  const directory = path.join(root, name), home = path.join(directory, 'home'), profile = path.join(directory, 'profile')
  for (const file of [profile, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(file, { recursive: true })
  const app = await _electron.launch({ executablePath: old ? oldExe : newExe,
    args: [`--user-data-dir=${profile}`, ...(!old && !options['new-exe'] ? [project] : [])], env: env(home), timeout: 45000 })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => errors.push({ name, old, message: error.message }))
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch((error) => {
        // Electron can resolve beforeunload in main before CDP dismiss arrives.
        if (/No dialog is showing/.test(error.message)) details.dialogDismissRaces = (details.dialogDismissRaces || 0) + 1
        else errors.push({ name, dialog: error.message })
      })
    })
    const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, profile: app.getPath('userData') }))
    assert.equal(path.resolve(info.profile), path.resolve(profile))
    if (expectGate) await page.locator('.workspace-startup-error[role="alert"]').waitFor()
    else await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    assert.equal((await page.evaluate(() => window.grok.snapshot())).auth.signedIn, false)
    if (!expectGate) await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
    return { app, page, info: { version: info.version, electron: info.electron } }
  } catch (error) { await close(app); throw error }
}
async function settings(page) {
  const region = page.getByRole('region', { name: '工作区数据' })
  if (!await region.isVisible()) {
    await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
  }
  return region
}
async function importFixture(page, backup) {
  const section = await settings(page)
  await page.getByLabel('导入工作区备份文件', { exact: true }).setInputFiles({ name: 'migration-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
  await section.getByRole('checkbox', { name: '我确认用此备份替换本地工作区' }).check()
  await section.getByRole('button', { name: '确认替换并恢复', exact: true }).click()
  await waitForWorkspace(page, (value) => value && digest(value.state) === digest(backup.state), { label: 'imported fixed history and drafts' })
  await page.locator('.settings-close').click()
}
async function exportFixture(app, page, name) {
  const file = path.join(root, `${name}.json`), section = await settings(page)
  await app.evaluate(({ session }, file) => {
    globalThis.__migrationDownload = 'pending'
    session.defaultSession.once('will-download', (_event, item) => { item.setSavePath(file); item.once('done', (_event, state) => { globalThis.__migrationDownload = state }) })
  }, file)
  await section.getByRole('button', { name: '导出工作区备份', exact: true }).click()
  const end = Date.now() + 15000; let state
  do { state = await app.evaluate(() => globalThis.__migrationDownload); if (state !== 'pending') break; await new Promise((resolve) => setTimeout(resolve, 50)) } while (Date.now() < end)
  assert.equal(state, 'completed')
  return JSON.parse(fs.readFileSync(file, 'utf8')).state
}
async function capture(app, page, name) {
  const file = path.join(root, `${name}.png`)
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.screenshot({ path: file })
    const colors = await app.evaluate(({ nativeImage }, file) => {
      const bytes = nativeImage.createFromPath(file).toBitmap(), colors = new Set(), step = Math.max(4, Math.floor(bytes.length / 16384) * 4)
      for (let index = 0; index < bytes.length; index += step) colors.add(`${bytes[index]},${bytes[index + 1]},${bytes[index + 2]}`)
      return colors.size
    }, file)
    if (colors > 8) { screenshots.push(path.basename(file)); return }
  }
  throw new Error('Screenshot remained blank')
}
async function records(page, damage = false) {
  return page.evaluate(async ({ database, key, damage }) => {
    const request = (operation) => new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error) })
    const db = await request(indexedDB.open(database))
    try {
      const tx = db.transaction('records', damage ? 'readwrite' : 'readonly'), store = tx.objectStore('records')
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      if (damage) { const head = await request(store.get([key, 'head'])); store.put({ ...head, format: 999 }, [key, 'head']) }
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]); await done
      return keys.map((key, index) => ({ key, value: values[index] }))
    } finally { db.close() }
  }, { database, key, damage })
}
function snapshotFrom(rows, slot) {
  const head = rows.find((row) => JSON.stringify(row.key) === JSON.stringify([key, slot]))?.value
  if (!head) return null
  assert.ok(head.kind === 'workspace-head' && [1, 2, 3, 4].includes(head.format), 'Snapshot head must have a supported format')
  const collections = { messages: 'message', tasks: 'task', artifacts: 'artifact' }
  const lookup = (type, ref) => {
    const row = rows.find((row) => JSON.stringify(row.key) === JSON.stringify([key, type, ref.key]))?.value
    assert.ok(row?.kind === `workspace-${type}` && row.value?.id === ref.id, `Missing or invalid ${type} ${ref.id}`)
    return row.value
  }
  const teams = head.teams.map((ref) => {
    const team = { ...lookup('team', ref) }
    for (const [field, refs] of Object.entries(ref.collections || {})) {
      assert.ok([2, 3, 4].includes(head.format) && Object.hasOwn(collections, field) && !Object.hasOwn(team, field), 'Invalid collection reference')
      team[field] = refs.map((item) => lookup(collections[field], item))
    }
    return team
  })
  return { ...head.meta, teams }
}
async function upgrade() {
  let app, page
  const expected = fixture()
  try {
    let launched = await launch('upgrade', true); ({ app, page } = launched); details.old = launched.info
    await importFixture(page, expected)
    const legacy = await page.evaluate((key) => localStorage.getItem(key), key)
    assert.equal(digest((await readWorkspace(page)).state), digest(expected.state))
    details.legacySourceSha256 = hash(legacy)
    await capture(app, page, 'old-imported')
    await close(app); app = null
    launched = await launch('upgrade'); ({ app, page } = launched); details.new = launched.info
    await check('old installed profile migrates all messages and both drafts without changing legacy bytes', async () => {
      const migrated = await readWorkspace(page)
      assert.equal(digest(migrated.state), digest(expected.state))
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), legacy)
      const rows = await records(page)
      assert.ok(snapshotFrom(rows, 'head'))
      return { hash: digest(migrated.state), messages: migrated.state.teams.reduce((n, team) => n + team.messages.length, 0) }
    })
    const newDraft = '新版数据库中的最新草稿，旧版 localStorage 必须保持原样。'
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(newDraft)
    expected.state.drafts['migration-one'] = newDraft
    await waitForWorkspace(page, (value) => value?.state.drafts['migration-one'] === newDraft)
    await check('new draft commits to IndexedDB while retained legacy source remains stale and intact', async () => {
      assert.equal(digest((await readWorkspace(page)).state), digest(expected.state))
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), legacy)
      assert.equal(JSON.parse(legacy).state.drafts['migration-one'], '旧版本当前草稿')
    })
    await capture(app, page, 'migrated-new-draft')
    await close(app); app = null
    ;({ app, page } = await launch('upgrade'))
    await check('restart reads authoritative IndexedDB instead of reverting to old localStorage', async () => {
      assert.equal(digest((await readWorkspace(page)).state), digest(expected.state))
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), newDraft)
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), legacy)
    })
    await capture(app, page, 'migrated-restart')
  } finally { if (app) await close(app) }
}
async function brokenLegacy() {
  let app, page
  const raw = '{"state":{"teams":'
  try {
    ({ app, page } = await launch('broken-legacy', true))
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setScriptExecutionDisabled', { value: true })
    await page.reload()
    const { frameTree } = await session.send('Page.getFrameTree')
    const { storageKey } = await session.send('Storage.getStorageKeyForFrame', { frameId: frameTree.frame.id })
    await session.send('DOMStorage.setDOMStorageItem', { storageId: { storageKey, isLocalStorage: true }, key, value: raw })
    await session.detach()
    await close(app); app = null
    ;({ app, page } = await launch('broken-legacy', false, true))
    await check('truncated legacy enters a safe startup gate without rendering an editable empty workspace', async () => {
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
      assert.match(await page.locator('.workspace-startup-error').innerText(), /旧版工作区无法读取|原有数据已保留/)
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), raw)
      assert.equal(snapshotFrom(await records(page), 'head'), null)
    })
    await page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
    await page.locator('.workspace-startup-error').waitFor()
    await check('retrying malformed legacy preserves the exact original bytes', async () => {
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), raw)
      assert.equal(snapshotFrom(await records(page), 'head'), null)
    })
    await capture(app, page, 'broken-legacy-gate')
  } finally { if (app) await close(app) }
}
async function previousRecovery() {
  let app, page
  try {
    ({ app, page } = await launch('previous'))
    await importFixture(page, fixture())
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('上一份可用草稿')
    await waitForWorkspace(page, (value) => value?.state.drafts['migration-one'] === '上一份可用草稿')
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('故障发生前的最新草稿')
    await waitForWorkspace(page, (value) => value?.state.drafts['migration-one'] === '故障发生前的最新草稿')
    const previous = snapshotFrom(await records(page), 'previous')
    assert.equal(previous.drafts['migration-one'], '上一份可用草稿')
    const damagedRows = await records(page, true)
    await page.reload(); await page.locator('.workspace-startup-error').waitFor()
    const restore = page.getByRole('button', { name: '恢复上一份快照', exact: true })
    await restore.waitFor()
    await check('damaged head preserves raw records and requires explicit previous-snapshot confirmation', async () => {
      assert.equal(await restore.isEnabled(), false)
      assert.equal(JSON.stringify(canonical(await records(page))), JSON.stringify(canonical(damagedRows)))
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
    })
    await capture(app, page, 'previous-recovery-gate')
    await page.getByRole('checkbox', { name: '我确认恢复上一份可用快照', exact: true }).check()
    await restore.click()
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    await check('explicit recovery restores the valid previous snapshot and keeps its backup usable', async () => {
      assert.equal(digest((await readWorkspace(page)).state), digest(previous))
      assert.equal(digest(snapshotFrom(await records(page), 'previous')), digest(previous))
    })
    await capture(app, page, 'previous-recovered')
  } finally { if (app) await close(app) }
}
async function abortedWrite() {
  let app, page, failing = false
  try {
    ({ app, page } = await launch('aborted-write'))
    await importFixture(page, fixture())
    const persisted = digest((await readWorkspace(page)).state), draft = '事务失败时仅在内存中的草稿，重试后必须保留。'
    await failWorkspaceWrites(page); failing = true
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(draft)
    await page.getByRole('alert').filter({ hasText: /存储写入失败/ }).waitFor()
    await capture(app, page, 'aborted-write-warning')
    await check('native transaction abort leaves old committed data and exposes an exportable in-memory draft', async () => {
      assert.equal(digest((await readWorkspace(page)).state), persisted)
      const memory = await exportFixture(app, page, 'abort-memory-export')
      assert.equal(memory.drafts['migration-one'], draft)
    })
    await page.locator('.settings-close').click()
    await restoreWorkspaceWrites(page); failing = false
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await waitForWorkspace(page, (value) => value?.state.drafts['migration-one'] === draft)
    await page.getByRole('alert').filter({ hasText: /存储写入失败/ }).waitFor({ state: 'hidden' })
    await close(app); app = null
    ;({ app, page } = await launch('aborted-write'))
    await check('retry commits the latest failed draft and a new process restores it', async () => {
      assert.equal((await readWorkspace(page)).state.drafts['migration-one'], draft)
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
    })
    await capture(app, page, 'aborted-write-retried')
  } finally {
    if (app && failing) await restoreWorkspaceWrites(page).catch(() => {})
    if (app) await close(app)
  }
}
async function holdWorkspaceLock(page) {
  // A real competing readwrite transaction holds the store lock, so the
  // application's actual draft transaction cannot finish before navigation.
  await page.evaluate(async (database) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      window.__migrationDocument = 'before-pending-reload'
      window.__migrationLockActive = true
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records')
      const end = performance.now() + 2000
      await new Promise((resolve, reject) => {
        let started = false
        const keepAlive = () => {
          const request = store.get('migration-test-keepalive')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            if (!started) { started = true; resolve() }
            if (performance.now() < end) keepAlive()
          }
        }
        keepAlive()
      })
      tx.oncomplete = tx.onabort = () => { window.__migrationLockActive = false; db.close() }
  }, database)
}
async function pendingReload(mode = 'keyboard') {
  let app, page
  try {
    ({ app, page } = await launch(`pending-reload-${mode}`))
    await importFixture(page, fixture())
    assert.equal(await page.evaluate(() => typeof window.grok.persistence?.onPrepareClose), 'function', 'build must include the persistence handshake')
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.__migrationInputs = []
      BrowserWindow.getAllWindows()[0].webContents.on('before-input-event', (_event, input) => {
        globalThis.__migrationInputs.push({ type: input.type, code: input.code, key: input.key, control: input.control, meta: input.meta })
      })
    })
    await holdWorkspaceLock(page)
    const draft = '重载前尚在真实事务队列中的草稿。'
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(draft)
    const started = performance.now()
    let navigation
    if (mode === 'keyboard' || mode === 'f5') await app.evaluate(({ BrowserWindow }, mode) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.focus(); window.webContents.focus()
      const modifiers = mode === 'f5' ? [] : [process.platform === 'darwin' ? 'meta' : 'control']
      const keyCode = mode === 'f5' ? 'F5' : 'R'
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }, mode)
    else {
      navigation = page.reload().catch((error) => {
        // The original reload may be cancelled by beforeunload; the main
        // process issues a new navigation after receiving the save receipt.
        if (!/ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error
      })
      void navigation.catch(() => {})
    }
    await page.locator('.workspace-save-overlay').waitFor()
    await check(`${mode} reload waits with editing frozen while a real draft transaction is still pending`, async () => {
      assert.equal(await page.evaluate(() => window.__migrationDocument), 'before-pending-reload')
      assert.equal(await page.evaluate(() => window.__migrationLockActive), true)
      assert.equal(await page.locator('.workspace-ready-content').getAttribute('inert'), '')
    })
    await capture(app, page, `pending-reload-${mode}-saving`)
    await page.waitForFunction(() => !window.__migrationDocument, { timeout: 15000 })
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    if (navigation) await navigation
    details[`${mode}ReloadWaitMs`] = Math.round(performance.now() - started)
    await check(`${mode} reload commits the queued draft before replacing the renderer and restores it afterward`, async () => {
      assert.equal((await readWorkspace(page)).state.drafts['migration-one'], draft)
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
      assert.ok(details[`${mode}ReloadWaitMs`] >= 500, 'reload did not wait for the deliberately blocked transaction')
    })
    await capture(app, page, `pending-reload-${mode}-restored`)
  } catch (error) {
    if (page) {
      details[`${mode}FailureState`] = await page.evaluate(() => ({ document: window.__migrationDocument, lock: window.__migrationLockActive, body: document.body.innerText.slice(0, 500) })).catch(() => null)
      await capture(app, page, `pending-reload-${mode}-failed`).catch(() => {})
    }
    throw error
  } finally {
    if (app) {
      details[`${mode}Inputs`] = await app.evaluate(() => globalThis.__migrationInputs).catch(() => [])
      await close(app)
    }
  }
}
async function exited(child) {
  if (child.exitCode !== null) { assert.equal(child.exitCode, 0); return }
  let timer
  try {
    const code = await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Requested exit did not complete within 15 seconds')), 15000) })])
    assert.equal(code, 0)
  } finally { clearTimeout(timer) }
}
async function pendingClose(mode) {
  let app, page
  const name = `pending-close-${mode}`, draft = `退出路径 ${mode} 的待写草稿。`
  try {
    ({ app, page } = await launch(name))
    await importFixture(page, fixture())
    await holdWorkspaceLock(page)
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(draft)
    const child = app.process(), started = performance.now()
    if (mode === 'window') await page.evaluate(() => window.grok.window.close())
    else await app.evaluate(({ app }) => app.quit())
    await page.locator('.workspace-save-overlay').waitFor()
    await check(`${mode} close keeps the process alive and editing frozen until its queued transaction commits`, async () => {
      assert.equal(child.exitCode, null)
      assert.equal(await page.evaluate(() => window.__migrationLockActive), true)
      assert.equal(await page.locator('.workspace-ready-content').getAttribute('inert'), '')
    })
    await capture(app, page, `pending-close-${mode}-saving`)
    await exited(child); app = null
    details[`${mode}CloseWaitMs`] = Math.round(performance.now() - started)
    ;({ app, page } = await launch(name))
    await check(`${mode} close exits cleanly after saving and the next process restores its draft`, async () => {
      assert.ok(details[`${mode}CloseWaitMs`] >= 500)
      assert.equal((await readWorkspace(page)).state.drafts['migration-one'], draft)
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
    })
    await capture(app, page, `pending-close-${mode}-restored`)
  } finally { if (app) await close(app) }
}
async function failedClose() {
  let app, page, failing = false
  const draft = '保存失败后选择保留窗口，必须仍可导出的草稿。'
  try {
    ({ app, page } = await launch('failed-close'))
    await importFixture(page, fixture())
    const oldDigest = digest((await readWorkspace(page)).state)
    await app.evaluate(({ dialog }) => {
      globalThis.__migrationDialogs = []
      globalThis.__migrationOriginalDialog = dialog.showMessageBox
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        globalThis.__migrationDialogs.push({ title: options.title, message: options.message,
          buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId })
        return { response: 0, checkboxChecked: false }
      }
    })
    await failWorkspaceWrites(page); failing = true
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(draft)
    await page.getByRole('alert').filter({ hasText: /存储写入失败/ }).waitFor()
    await page.evaluate(() => window.grok.window.close())
    const deadline = Date.now() + 10000; let dialogs = []
    do {
      dialogs = await app.evaluate(() => globalThis.__migrationDialogs)
      if (dialogs.length) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    await page.waitForFunction(() => document.querySelector('.workspace-ready-content')?.inert === false && !document.querySelector('.workspace-save-overlay'))
    await check('failed close defaults to keeping the window and restores editing without discarding the draft', async () => {
      assert.equal(dialogs.length, 1)
      assert.equal(dialogs[0].title, '工作区尚未确认保存')
      assert.equal(dialogs[0].buttons[0], '保留窗口')
      assert.match(dialogs[0].buttons[1], /放弃未保存内容并退出/)
      assert.equal(dialogs[0].defaultId, 0); assert.equal(dialogs[0].cancelId, 0)
      assert.equal(app.process().exitCode, null)
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
      assert.equal(digest((await readWorkspace(page)).state), oldDigest)
      details.failedCloseDialog = dialogs[0]
    })
    await capture(app, page, 'failed-close-retained')
    await check('retained failed-close draft remains exportable before retry', async () => {
      assert.equal((await exportFixture(app, page, 'failed-close-memory-export')).drafts['migration-one'], draft)
    })
    await page.locator('.settings-close').click()
    await restoreWorkspaceWrites(page); failing = false
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await waitForWorkspace(page, (value) => value?.state.drafts['migration-one'] === draft)
    await page.getByRole('alert').filter({ hasText: /存储写入失败/ }).waitFor({ state: 'hidden' })
    const child = app.process()
    await page.evaluate(() => window.grok.window.close())
    await exited(child); app = null
    ;({ app, page } = await launch('failed-close'))
    await check('successful retry permits normal exit and reopening restores the formerly failed draft', async () => {
      assert.equal((await readWorkspace(page)).state.drafts['migration-one'], draft)
      assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
    })
    await capture(app, page, 'failed-close-retried')
  } finally {
    if (app && failing) await restoreWorkspaceWrites(page).catch(() => {})
    if (app) {
      await app.evaluate(({ dialog }) => { if (globalThis.__migrationOriginalDialog) dialog.showMessageBox = globalThis.__migrationOriginalDialog }).catch(() => {})
      await close(app)
    }
  }
}
try {
  if (options['only-reload'] !== 'true' && options['only-close'] !== 'true')
    for (const [name, scenario] of [['upgrade', upgrade], ['broken legacy', brokenLegacy], ['previous recovery', previousRecovery], ['aborted write', abortedWrite]])
      await check(`${name}: complete journey`, scenario)
  if (options['include-reload'] === 'true') for (const mode of ['keyboard', 'f5', 'navigation'])
    await check(`pending ${mode} reload: complete journey`, () => pendingReload(mode))
  if (options['include-close'] === 'true') {
    for (const mode of ['window', 'quit']) await check(`pending ${mode} close: complete journey`, () => pendingClose(mode))
    await check('failed close: complete journey', failedClose)
  }
} finally {
  await check('no uncaught renderer or harness errors', async () => assert.deepEqual(errors, []))
  const report = { ok: results.every((result) => result.ok), modelPromptsSent: 0, details, results, screenshots, errors,
    reloadPending: options['include-reload'] === 'true' ? 'Executed with a real competing readwrite transaction' : 'Not selected in this run',
    closePending: options['include-close'] === 'true' ? 'Executed window close, app quit and failed-write keep-window recovery' : 'Not selected in this run' }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: report.ok, passed: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, reportFile }, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
