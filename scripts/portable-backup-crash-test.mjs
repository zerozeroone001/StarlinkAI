import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { readWorkspace, seedWorkspace, waitForWorkspace, workspaceStorageNames } from './desktop-test-storage.mjs'

const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--exe', '--output-dir', '--playwright'].includes(process.argv[i]) && process.argv[i + 1])
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
const require = createRequire(import.meta.url), executablePath = path.resolve(options.exe || require('electron'))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.24/portable-crash')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'crash-')), archive = path.join(root, 'synthetic-backup.zip')
const projectDirectory = path.join(root, 'source-project'); fs.mkdirSync(projectDirectory)
fs.writeFileSync(path.join(projectDirectory, 'not-backed-up.ts'), 'private source code is not a referenced asset')
const pw = await import(pathToFileURL(options.playwright || process.env.PLAYWRIGHT_PATH ||
  path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)
const { _electron } = pw._electron ? pw : pw.default
const results = [], errors = [], screenshots = [], processes = [], checkpoints = []
let active
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const hash = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex')
const saved = (state) => Object.fromEntries(['teams', 'drafts', 'attachmentDrafts', 'activeTeamId', 'defaultProvider', 'modelDefaults', 'deletedGalleryKeys'].map((key) => [key, state[key]]))
const stateHash = (value) => hash(saved(value.state))
const pass = (name, detail = {}) => { results.push({ name, ok: true, ...detail }); console.log('PASS', name) }
const journalPath = (test) => path.join(test.home, '.grok/desktop/portable-backups/pending-restore.json')
const assistantFile = (test, id) => path.join(test.home, '.grok/desktop/assistants', `${hash(id)}.json`)
const journalResult = (test, id) => path.join(test.home, '.grok/desktop/portable-backups', `restore-${id}.json`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function fixturePng() {
  const chunk = (kind, bytes) => {
    const content = Buffer.concat([Buffer.from(kind), bytes]), header = Buffer.alloc(4), tail = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    let crc = 0xffffffff
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, content, tail])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(96); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc(64 * (1 + 96 * 4))
  for (let row = 0; row < 64; row++) for (let col = 0; col < 96; col++) {
    const offset = row * (1 + 96 * 4) + 1 + col * 4; pixels.set([30, 150, 210, 255], offset)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40) }
  throw Error(`Timed out: ${label}`)
}
function environment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/i.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
}
async function launch(name, gate = false) {
  const directory = path.join(root, name), home = path.join(directory, 'home'), profile = path.join(directory, 'user-data')
  for (const folder of [home, profile, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(folder, { recursive: true })
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, ...(!options.exe ? [process.cwd()] : [])], env: environment(home), timeout: 45000 })
  const page = await app.firstWindow(), child = app.process()
  const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData') }))
  assert.equal(path.resolve(metadata.profile), profile)
  const processRecord = { name, pid: child.pid, ...metadata, closed: false, intentionalCrash: false }
  processes.push(processRecord); child.once('exit', () => { processRecord.closed = true })
  active = { name, app, page, child, home, profile, processRecord }
  page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push({ name, error: String(error) }))
  page.on('dialog', (dialog) => void dialog.dismiss().catch((error) => { if (!/No dialog is showing/.test(error.message)) errors.push({ name, error: String(error) }) }))
  await app.evaluate(({ ipcMain, dialog }, fixture) => {
    globalThis.__crashCalls = { sends: 0, logins: 0 }
    for (const channel of ['workspace:start', 'workspace:login']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => { globalThis.__crashCalls[channel === 'workspace:start' ? 'sends' : 'logins']++; throw Error('Offline crash test forbids model and login requests') })
    }
    ipcMain.removeHandler('workspace:providers')
    ipcMain.handle('workspace:providers', (_event, _refresh, ids = ['claude', 'codex', 'grok', 'gemini']) => ids.map((id) => ({ id,
      cli: { state: 'not_found', version: null, path: null }, auth: null, models: [], checkedAt: new Date().toISOString(), usage: null, loginCommand: `${id} login` })))
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: fixture.archive })
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1).properties?.includes('openDirectory') ? fixture.projectDirectory : fixture.archive] })
  }, { archive, projectDirectory })
  await page.locator(gate ? '.workspace-startup-error[role="alert"]' : 'textarea[aria-label="对话消息"]').waitFor()
  assert.equal((await page.evaluate(() => window.grok.snapshot())).auth.signedIn, false)
  if (!gate) await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
  return active
}
async function terminate(test, intentional) {
  assert.deepEqual(await test.app.evaluate(() => globalThis.__crashCalls), { sends: 0, logins: 0 })
  test.processRecord.intentionalCrash = intentional
  if (intentional) {
    // Kill only this test's recorded process tree; no global process lookup.
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(test.child.pid), '/T', '/F'], { windowsHide: true })
    else test.child.kill('SIGKILL')
    await until(() => test.processRecord.closed, 'crashed test app exits')
  } else {
    let timer
    try { await Promise.race([test.app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Normal close timed out')), 15000) })]) }
    finally { clearTimeout(timer) }
    await until(() => test.processRecord.closed, 'normal test app exits')
  }
  if (active === test) active = undefined
}
function fixture(id, directory) {
  const lead = { id: `${id}-lead`, provider: 'grok', name: '主 agent', role: 'assistant', persona: '', isLead: true }
  const team = { id, kind: 'conversation', parentId: null, name: `崩溃验收 ${id}`, goal: '', defaultProvider: 'grok', ...(directory ? { directory } : {}),
    sample: false, paused: false, permissionMode: 'ask', members: [lead], tasks: [], artifacts: [],
    messages: [{ id: `${id}-message`, author: lead.id, to: 'all', text: `保留消息 ${id}`, time: '10:00', kind: 'message', status: 'completed', sample: false }] }
  return { version: 2, state: { teams: [team], activeTeamId: id, drafts: { [id]: `保留草稿 ${id}` }, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
}
async function settings(test) {
  await test.page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
  await test.page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
  return test.page.locator('.workspace-data-settings')
}
async function dbRows(test, replaceHead) {
  return test.page.evaluate(async ({ names, replaceHead }) => {
    const request = (op) => new Promise((resolve, reject) => { op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error) })
    const db = await request(indexedDB.open(names.database))
    try {
      const tx = db.transaction('records', replaceHead ? 'readwrite' : 'readonly', replaceHead ? { durability: 'strict' } : undefined), store = tx.objectStore('records')
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      if (replaceHead) store.put(replaceHead, [names.key, 'head'])
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]); await done
      return keys.map((key, i) => ({ key, value: values[i] })).filter((r) => r.key[0] === names.key)
    } finally { db.close() }
  }, { names: workspaceStorageNames, replaceHead })
}
const slot = (rows, key) => rows.find((row) => row.key[1] === key)?.value
async function capture(test, name) {
  await test.page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await sleep(150)
  const file = path.join(root, `${name}.png`); await test.page.screenshot({ path: file }); screenshots.push(file)
}
async function selectImport(test, hold) {
  await (await settings(test)).getByRole('button', { name: '选择便携备份并预览', exact: true }).click()
  const dialog = test.page.getByRole('dialog', { name: '预览并恢复便携备份', exact: true })
  await dialog.getByRole('checkbox', { name: '我确认用此备份替换工作区及助手资料', exact: true }).check()
  await test.app.evaluate(({ ipcMain }, hold) => {
    globalThis.__crashHeld = false; globalThis.__crashPrepared = undefined
    if (hold === 'prepared') {
      const prepare = ipcMain._invokeHandlers.get('backup:prepareRestore')
      ipcMain.removeHandler('backup:prepareRestore')
      ipcMain.handle('backup:prepareRestore', async (...args) => {
        const plan = await prepare(...args)
        globalThis.__crashPrepared = plan; globalThis.__crashHeld = true
        await new Promise(() => {})
        return plan
      })
    } else {
      const reconcile = ipcMain._invokeHandlers.get('backup:reconcile')
      ipcMain.removeHandler('backup:reconcile')
      ipcMain.handle('backup:reconcile', async (...args) => {
        if (args[1]) {
          globalThis.__crashPrepared = { operationId: args[1], scopes: args[2] }; globalThis.__crashHeld = true
          await new Promise(() => {})
        }
        return reconcile(...args)
      })
    }
  }, hold)
  await dialog.getByRole('button', { name: '确认替换并恢复便携备份', exact: true }).click()
  await until(() => test.app.evaluate(() => globalThis.__crashHeld), `${hold} crash checkpoint`)
  const prepared = await test.app.evaluate(() => globalThis.__crashPrepared)
  const journalBytes = fs.readFileSync(journalPath(test)), journal = JSON.parse(journalBytes)
  assert.equal(journal.operationId, prepared.operationId); assert.ok(journal.scopes.length)
  return { prepared, journal, journalBytes }
}
async function originalTarget(name) {
  const test = await launch(name), value = fixture(`${name}-original`)
  await seedWorkspace(test.page, value)
  const original = await waitForWorkspace(test.page, (v) => v?.state.teams[0].id === value.state.activeTeamId)
  const assistant = await test.page.evaluate(async (scope) => {
    await window.grok.workspace.updateAssistant(scope, { name: '崩溃前原助手', persona: '原资料不得丢失' })
    return window.grok.workspace.saveMemory(scope, { content: '崩溃前原记忆', kind: 'fact' })
  }, value.state.activeTeamId)
  return { test, original, assistant, assistantBytes: fs.readFileSync(assistantFile(test, value.state.activeTeamId)) }
}
async function assertInactive(test, scope) {
  const result = await test.page.evaluate(async (scope) => {
    const snapshot = await window.grok.workspace.assistant(scope)
    try { await window.grok.backup.setRemindersPaused(scope, true, snapshot.revision); return { allowed: true } }
    catch (error) { return { allowed: false, message: error.message } }
  }, scope)
  assert.equal(result.allowed, false); assert.match(result.message, /不在当前工作区|正在恢复/)
}
async function rollback(test) {
  await (await settings(test)).getByRole('button', { name: '回退到替换前的工作区', exact: true }).click()
  const dialog = test.page.getByRole('dialog', { name: '回退到替换前的工作区', exact: true })
  await dialog.getByRole('checkbox', { name: '我确认回退并替换当前工作区及助手资料', exact: true }).check()
  await dialog.getByRole('button', { name: '确认回退', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  await test.page.locator('.settings-close').click()
}
try {
  const source = await launch('source'), value = fixture('crash-source', projectDirectory)
  await seedWorkspace(source.page, value)
  const assets = await source.page.evaluate(async ({ scope, directory, png }) => {
    await window.grok.workspace.updateAssistant(scope, { name: '备份中的助手', persona: '随备份恢复' })
    await window.grok.workspace.saveMemory(scope, { content: '备份中的记忆', kind: 'fact' })
    const assistant = await window.grok.workspace.saveCommitment(scope, { title: '备份中的提醒', dueAt: '2099-01-01T00:00:00.000Z' })
    const attachment = await window.grok.workspace.upload(scope, { name: 'retained.txt', data: btoa('portable crash test attachment exact bytes') }, directory)
    const image = await window.grok.workspace.upload(scope, { name: 'retained.png', data: png }, directory)
    return { assistant, attachment, image }
  }, { scope: value.state.activeTeamId, directory: projectDirectory, png: fixturePng().toString('base64') })
  value.state.attachmentDrafts[value.state.activeTeamId] = [assets.attachment]
  value.state.teams[0].messages[0].images = [{ path: assets.image.path, alt: '可恢复图片' }]
  await seedWorkspace(source.page, value)
  await (await settings(source)).getByRole('button', { name: '导出便携 ZIP', exact: true }).click()
  const exportDialog = source.page.getByRole('dialog', { name: '导出便携备份', exact: true })
  await exportDialog.getByRole('button', { name: '选择位置并导出 ZIP', exact: true }).click(); await exportDialog.waitFor({ state: 'hidden' })
  assert.ok(fs.statSync(archive).size > 0)
  await terminate(source, false)
  pass('source archive contains synthetic assistant memory, reminders, attachment and PNG through the real UI')

  const a = await originalTarget('before-commit'), aBefore = await dbRows(a.test)
  const aCheckpoint = await selectImport(a.test, 'prepared')
  assert.equal(hash(await dbRows(a.test)), hash(aBefore)); assert.equal(slot(aBefore, 'importMarker'), undefined)
  assert.deepEqual(fs.readFileSync(assistantFile(a.test, a.original.state.activeTeamId)), a.assistantBytes)
  await capture(a.test, 'before-commit-held'); await terminate(a.test, true)
  pass('A: actual process tree is killed after durable journal publication and before the prepare IPC response or IDB commit')
  const aRestart = await launch('before-commit')
  assert.equal(stateHash(await readWorkspace(aRestart.page)), stateHash(a.original))
  assert.deepEqual(fs.readFileSync(assistantFile(aRestart, a.original.state.activeTeamId)), a.assistantBytes)
  assert.deepEqual(await aRestart.page.evaluate((id) => window.grok.workspace.assistant(id), a.original.state.activeTeamId), a.assistant)
  assert.equal(fs.existsSync(journalPath(aRestart)), false)
  assert.equal(JSON.parse(fs.readFileSync(journalResult(aRestart, aCheckpoint.journal.operationId))).outcome, 'not-committed')
  for (const scope of aCheckpoint.journal.scopes) await assertInactive(aRestart, scope)
  await capture(aRestart, 'before-commit-restarted-old-workspace'); await terminate(aRestart, false)
  checkpoints.push({ phase: 'before-commit', operationId: aCheckpoint.journal.operationId, originalHash: stateHash(a.original), outcome: 'not-committed' })
  pass('A: restart retains original workspace and assistant bytes, reconciles not-committed and rejects activation of orphan scopes')

  const b = await originalTarget('after-commit'), bCheckpoint = await selectImport(b.test, 'ack')
  const bImported = await readWorkspace(b.test.page), bRows = await dbRows(b.test)
  assert.notEqual(bImported.state.activeTeamId, b.original.state.activeTeamId)
  assert.equal(slot(bRows, 'importMarker').value, bCheckpoint.journal.operationId); assert.equal(slot(bRows, 'head').format, 4)
  assert.ok(slot(bRows, 'restorePoint'))
  await capture(b.test, 'after-commit-before-ack'); await terminate(b.test, true)
  pass('B: actual process tree is killed after strict IDB commit while the first reconcile ACK remains pending')
  const bRestart = await launch('after-commit'), restored = await readWorkspace(bRestart.page), scope = restored.state.activeTeamId
  assert.equal(stateHash(restored), stateHash(bImported))
  assert.equal(slot(await dbRows(bRestart), 'importMarker').value, bCheckpoint.journal.operationId)
  assert.equal(fs.existsSync(journalPath(bRestart)), false)
  assert.equal(JSON.parse(fs.readFileSync(journalResult(bRestart, bCheckpoint.journal.operationId))).outcome, 'committed')
  const newAssistant = await bRestart.page.evaluate((id) => window.grok.workspace.assistant(id), scope)
  assert.deepEqual(newAssistant.memories, assets.assistant.memories); assert.deepEqual(newAssistant.commitments, assets.assistant.commitments)
  assert.equal(newAssistant.remindersPaused, true)
  assert.deepEqual(await bRestart.page.evaluate(({ scope, revision }) => window.grok.backup.setRemindersPaused(scope, true, revision), { scope, revision: newAssistant.revision }), newAssistant)
  await assertInactive(bRestart, b.original.state.activeTeamId)
  const team = restored.state.teams[0], attachment = restored.state.attachmentDrafts[scope][0], image = team.messages[0].images[0]
  assert.deepEqual(fs.readFileSync(attachment.path), fs.readFileSync(assets.attachment.path))
  assert.deepEqual(fs.readFileSync(image.path), fs.readFileSync(assets.image.path))
  assert.ok(path.resolve(team.directory).startsWith(path.resolve(bRestart.home) + path.sep))
  assert.equal(fs.existsSync(path.join(team.directory, 'not-backed-up.ts')), false)
  const media = await bRestart.page.evaluate(({ scope, image, directory }) => window.grok.workspace.media(scope, image, directory), { scope, image: image.path, directory: team.directory })
  assert.match(media.dataUrl, /^data:image\/png;base64,/)
  assert.deepEqual(await bRestart.page.evaluate((url) => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => reject(Error('Restored PNG did not decode')); image.src = url
  }), media.dataUrl), [96, 64])
  await capture(bRestart, 'after-commit-restarted-new-workspace')
  pass('B: restart verifies matching marker, completes journal, retains assistant and media bytes, and activates only the imported scope')
  await rollback(bRestart)
  await waitForWorkspace(bRestart.page, (v) => stateHash(v) === stateHash(b.original))
  assert.deepEqual(fs.readFileSync(assistantFile(bRestart, b.original.state.activeTeamId)), b.assistantBytes)
  await capture(bRestart, 'after-commit-rollback'); await terminate(bRestart, false)
  checkpoints.push({ phase: 'after-commit', operationId: bCheckpoint.journal.operationId, importedHash: stateHash(bImported), originalHash: stateHash(b.original), attachmentHash: hash(fs.readFileSync(attachment.path)), imageHash: hash(fs.readFileSync(image.path)), outcome: 'committed' })
  pass('B: fixed rollback point remains usable after the real crash and restores the original assistant and workspace')

  const c = await originalTarget('unreadable-idb'), cHead = slot(await dbRows(c.test), 'head'), cCheckpoint = await selectImport(c.test, 'prepared')
  await dbRows(c.test, { ...cHead, format: 999 })
  await terminate(c.test, true)
  const cRestart = await launch('unreadable-idb', true)
  assert.deepEqual(fs.readFileSync(journalPath(cRestart)), cCheckpoint.journalBytes)
  assert.equal(fs.existsSync(journalResult(cRestart, cCheckpoint.journal.operationId)), false)
  assert.deepEqual(fs.readFileSync(assistantFile(cRestart, c.original.state.activeTeamId)), c.assistantBytes)
  assert.equal(await cRestart.page.getByRole('textbox', { name: '对话消息', exact: true }).count(), 0)
  await assertInactive(cRestart, c.original.state.activeTeamId)
  await cRestart.page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await cRestart.page.locator('.workspace-startup-error[role="alert"]').waitFor()
  assert.deepEqual(fs.readFileSync(journalPath(cRestart)), cCheckpoint.journalBytes)
  await capture(cRestart, 'unreadable-idb-preserves-pending-journal')
  pass('C: unreadable IDB gates startup and retry keeps pending journal and assistant bytes without activating any scope')
  await dbRows(cRestart, cHead)
  await cRestart.page.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await cRestart.page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  assert.equal(stateHash(await readWorkspace(cRestart.page)), stateHash(c.original))
  assert.equal(fs.existsSync(journalPath(cRestart)), false)
  assert.equal(JSON.parse(fs.readFileSync(journalResult(cRestart, cCheckpoint.journal.operationId))).outcome, 'not-committed')
  await terminate(cRestart, false)
  pass('C: after restoring the synthetic IDB header, explicit retry reconciles the journal against authoritative old state')
  assert.deepEqual(errors, []); assert.ok(processes.every((p) => p.closed))
  pass('every recorded process exits, all profiles are isolated, and model/login counters stay at zero')
} catch (error) {
  results.push({ name: 'portable crash journey', ok: false, error: error.stack || String(error) }); console.error(error)
  try { if (active && !active.page.isClosed()) await capture(active, 'failure') } catch { /* original failure retained */ }
} finally {
  if (active) {
    try { await terminate(active, false) }
    catch (error) { errors.push(String(error)); try { if (active) await terminate(active, true) } catch (failure) { errors.push(String(failure)) } }
  }
  const ok = results.every((r) => r.ok) && errors.length === 0 && processes.every((p) => p.closed), reportFile = path.join(root, 'results.json')
  fs.writeFileSync(reportFile, JSON.stringify({ ok, results, checkpoints, processes, errors, screenshots }, null, 2))
  console.log(JSON.stringify({ ok, passed: results.filter((r) => r.ok).length, reportFile })); process.exitCode = ok ? 0 : 1
}
