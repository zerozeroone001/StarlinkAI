import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readWorkspace, readWorkspaceInRenderer, workspaceStorageNames, waitForWorkspace } from './desktop-test-storage.mjs'

// Offline smoke test of the real Electron app. Build first; no model requests or login.
// node scripts/desktop-smoke.mjs [--exe "release/.../StarlinkAI.exe"] [--playwright PATH]
// PLAYWRIGHT_PATH may name the Playwright package directory or its index.mjs.
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--exe', '--project', '--playwright', '--output-dir'].includes(key) || !process.argv[i + 1])
    throw new Error(`Unsupported or incomplete option: ${key}`)
  options[key.slice(2)] = process.argv[i + 1]
}
const project = path.resolve(options.project || '.')
const require = createRequire(path.join(project, 'package.json'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const temporaryDirectory = path.join(project, '.tmp')
fs.mkdirSync(temporaryDirectory, { recursive: true })
const root = fs.mkdtempSync(path.join(temporaryDirectory, 'desktop-smoke-'))
const output = path.resolve(options['output-dir'] || path.join(temporaryDirectory, 'desktop-smoke-results'))
fs.mkdirSync(output, { recursive: true })
const userData = path.join(root, 'user-data')
const home = path.join(root, 'home')
const grokHome = path.join(home, '.grok')
const fixtureParent = path.join(root, 'projects')
for (const directory of [userData, home, grokHome, fixtureParent, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')])
  fs.mkdirSync(directory, { recursive: true })
const results = []
const errors = []
const screenshots = []
const log = []
let electronApp, page, playwright, projectId, projectDirectory, draftId
const draft = '离线桌面验收草稿：关闭应用后仍然保留。'
const memory = '离线验收记忆：优先给出可执行的步骤。'
const resultFile = path.join(output, `desktop-smoke-${runId}.json`)
process.on('unhandledRejection', (error) => record('unhandled harness rejection', false, { error: error?.stack || String(error) }))

function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail })
  process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail.error ? `: ${detail.error}` : ''}\n`)
}
async function check(name, fn) {
  try { const detail = await fn(); record(name, true, detail || {}); return true }
  catch (error) { record(name, false, { error: error.stack || String(error) }); return false }
}
async function screenshot(name) {
  const file = path.join(output, `desktop-smoke-${runId}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  screenshots.push(file)
}
async function attachmentThumbnail() {
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')
  await page.getByLabel('选择对话附件', { exact: true }).setInputFiles({ name: '验收图片.png', mimeType: 'image/png', buffer })
  const attachments = page.getByLabel('待发送附件', { exact: true })
  await attachments.getByText('验收图片.png', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const image = document.querySelector('[aria-label="待发送附件"] img')
    return image?.complete && image.naturalWidth > 0
  })
  await attachments.getByRole('button', { name: '移除附件 验收图片.png', exact: true }).click()
  await attachments.waitFor({ state: 'hidden' })
}
async function deadline(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function closeApp() {
  if (!electronApp) return
  const app = electronApp
  electronApp = undefined
  const child = app.process()
  try { await deadline(app.close(), 15000, 'Electron shutdown') }
  catch (error) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  }
}
function isolatedEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key) ||
      /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  }
  return { ...env, GROK_HOME: grokHome, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
}
async function launch() {
  const args = [`--user-data-dir=${userData}`]
  let executablePath
  if (options.exe) executablePath = path.resolve(options.exe)
  else {
    executablePath = require('electron')
    const main = path.join(project, 'out', 'main', 'index.js')
    assert.ok(fs.existsSync(main), 'Run npm run build before the desktop smoke test')
    args.push(project)
  }
  assert.ok(fs.existsSync(executablePath), `Electron executable does not exist: ${executablePath}`)
  electronApp = await playwright._electron.launch({ executablePath, args, cwd: project, env: isolatedEnvironment(), timeout: 45000 })
  const child = electronApp.process()
  child.stderr?.on('data', (data) => { log.push(String(data)); if (log.length > 200) log.shift() })
  page = await electronApp.firstWindow({ timeout: 30000 })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.stack || error.message))
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  await page.waitForFunction(() => typeof window.grok?.workspace?.assistant === 'function')
  const isolation = await electronApp.evaluate(({ app }) => ({ userData: app.getPath('userData'),
    home: process.getBuiltinModule('os').homedir(), grokHome: process.env.GROK_HOME }))
  assert.equal(path.resolve(isolation.userData).toLowerCase(), userData.toLowerCase(), 'Electron user data must be isolated')
  assert.equal(path.resolve(isolation.home).toLowerCase(), home.toLowerCase(), 'Electron home must be isolated')
  return { executablePath, pid: child.pid, ...isolation }
}
async function savedState() {
  return (await readWorkspace(page))?.state
}

try {
  let entry = options.playwright || process.env.PLAYWRIGHT_PATH
  if (!entry) {
    try { entry = require.resolve('playwright') }
    catch { entry = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs') }
  }
  if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
  playwright = await import(pathToFileURL(path.resolve(entry)).href)
  if (!await check('launch and isolated first screen', launch)) throw new Error('Cannot continue without the desktop window')
  await check('first screen and preload IPC', async () => {
    const snapshot = await page.evaluate(() => window.grok.snapshot())
    assert.equal(snapshot.auth.signedIn, false)
    assert.deepEqual(snapshot.projects, [])
    await page.locator('.sidebar').waitFor()
    await screenshot('first-screen')
    return { signedIn: false, projectCount: snapshot.projects.length }
  })
  await check('renderer sandbox and unauthorized window IPC rejection', async () => {
    const observed = await electronApp.evaluate(async ({ BrowserWindow, app }) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'))
      const preferences = main.webContents.getLastWebPreferences()
      const path = process.getBuiltinModule('path')
      const untrusted = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(app.getAppPath(), 'out/preload/index.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false
      } })
      try {
        await untrusted.loadURL('data:text/html,<title>untrusted test window</title>')
        const denied = await untrusted.webContents.executeJavaScript(`window.grok.snapshot().then(() => false, () => true)`)
        return { sandbox: preferences.sandbox, isolated: preferences.contextIsolation, node: preferences.nodeIntegration, denied }
      } finally { untrusted.destroy() }
    })
    assert.deepEqual(observed, { sandbox: true, isolated: true, node: false, denied: true })
    return observed
  })
  await check('opening the same profile twice reuses the running desktop', async () => {
    // Playwright may launch via cmd.exe on Windows; obtain the actual app binary.
    const executablePath = await electronApp.evaluate(() => process.execPath)
    await promisify(execFile)(executablePath, [
      ...(options.exe ? [] : [project]), `--user-data-dir=${userData}`
    ], { cwd: project, env: isolatedEnvironment(), windowsHide: true, timeout: 15000 })
    assert.equal(electronApp.process().exitCode, null)
    const count = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    assert.equal(count, 1)
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  })
  await check('create a project through the UI and real directory IPC', async () => {
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
    await dialog.getByLabel('项目名称', { exact: true }).fill('桌面离线验收')
    await dialog.getByRole('button', { name: '创建新目录', exact: true }).click()
    await dialog.getByLabel('保存位置', { exact: true }).fill(fixtureParent)
    await dialog.getByLabel('文件夹名称', { exact: true }).fill('桌面项目')
    await dialog.getByLabel('项目目标', { exact: true }).fill('仅验证本地功能，不发送模型请求。')
    await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const { state } = await waitForWorkspace(page, (value) => value?.state.teams.some((team) => team.name === '桌面离线验收'), { label: 'created project persisted' })
    const created = state.teams.find((team) => team.name === '桌面离线验收')
    assert.ok(created)
    projectId = created.id
    projectDirectory = created.directory
    assert.equal(projectDirectory, path.join(fixtureParent, '桌面项目'))
    assert.ok(fs.statSync(projectDirectory).isDirectory())
    await screenshot('project-created')
    return { projectId, projectDirectory }
  })
  await check('real IPC lists and previews local files and rejects duplicate directories', async () => {
    assert.ok(projectDirectory, 'UI project creation must succeed first')
    const file = path.join(projectDirectory, '离线说明.txt')
    fs.writeFileSync(file, '真实 IPC 文件预览\nSmoke test fixture.\n', 'utf8')
    const observed = await page.evaluate(async ({ directory, file }) => ({
      tree: await window.grok.tree(directory), preview: await window.grok.previewFile(file), text: await window.grok.readFile(file)
    }), { directory: projectDirectory, file })
    assert.ok(observed.tree.some((node) => node.path === file && !node.dir))
    assert.match(observed.preview.text, /真实 IPC 文件预览/)
    assert.match(observed.text, /Smoke test fixture/)
    await assert.rejects(page.evaluate((file) => window.grok.previewFile(file, {}), file), /无法预览/)
    await assert.rejects(page.evaluate(({ file, cwd }) => window.grok.previewFile(file, { cwd }), { file, cwd: home }), /无法预览/)
    await assert.rejects(page.evaluate((parent) => window.grok.workspace.prepareDirectory({ mode: 'new', parent, name: '桌面项目' }), fixtureParent), /已存在/)
    assert.equal(fs.readFileSync(file, 'utf8'), observed.text)
    return { files: observed.tree.length, previewKind: observed.preview.kind }
  })
  await check('project attachment upload has a real decoded thumbnail', attachmentThumbnail)
  await check('settings tabs and durable appearance preferences', async () => {
    await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
    const tabs = page.getByRole('navigation', { name: '设置分类' })
    await tabs.getByRole('button', { name: /General|通用设置/ }).click()
    await page.getByRole('combobox', { name: /Language|语言/ }).selectOption('zh-CN')
    await page.getByRole('button', { name: '浅色', exact: true }).click()
    await page.waitForFunction(async () => { const snapshot = await window.grok.snapshot(); return snapshot.locale === 'zh-CN' && snapshot.theme === 'light' })
    for (const label of ['技能', '宠物', '模型与账号', '通用设置']) {
      const button = tabs.getByRole('button', { name: label, exact: true })
      await button.click()
      assert.equal(await button.getAttribute('aria-current'), 'page')
    }
    await screenshot('settings')
    await page.locator('.settings-close').click()
    return { locale: 'zh-CN', theme: 'light' }
  })
  await check('assistant memory is written through the UI and read through IPC', async () => {
    assert.ok(projectId, 'UI project creation must succeed first')
    await page.getByRole('button', { name: '主 agent 档案与记忆', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '项目主 agent', exact: true })
    await dialog.getByRole('tab', { name: '记忆', exact: true }).click()
    await dialog.getByRole('button', { name: '添加记忆', exact: true }).click()
    await dialog.getByRole('textbox', { name: '记忆内容', exact: true }).fill(memory)
    await dialog.getByRole('button', { name: '保存记忆', exact: true }).click()
    await dialog.getByText(memory, { exact: true }).waitFor()
    const snapshot = await page.evaluate((id) => window.grok.workspace.assistant(id), projectId)
    assert.ok(snapshot.memories.some((item) => item.content === memory))
    await screenshot('assistant-memory')
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    return { memoryCount: snapshot.memories.length }
  })
  await check('conversation draft survives reload', async () => {
    await page.getByRole('button', { name: '新建独立对话', exact: true }).click()
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill(draft)
    const { state } = await waitForWorkspace(page, (value) => value?.state.drafts[value.state.activeTeamId] === draft, { label: 'conversation draft persisted' })
    draftId = state.activeTeamId
    assert.equal(state.drafts[draftId], draft)
    await page.reload()
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
    return { conversationId: draftId }
  })
  await check('independent conversation attachment preview uses its own workspace', attachmentThumbnail)
  if (!await check('clean desktop shutdown', closeApp)) throw new Error('Desktop failed to shut down cleanly')
  if (!await check('relaunch with the same isolated data', launch)) throw new Error('Desktop relaunch failed')
  await check('project, draft, preferences and memory survive a full restart', async () => {
    assert.ok(projectId && draftId, 'Creation and draft checks must succeed first')
    const state = await savedState()
    assert.equal(state.activeTeamId, draftId)
    assert.equal(state.drafts[draftId], draft)
    assert.ok(state.teams.some((team) => team.id === projectId && team.directory === projectDirectory))
    assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), draft)
    const persisted = await page.evaluate(async (id) => ({ prefs: await window.grok.snapshot(), assistant: await window.grok.workspace.assistant(id) }), projectId)
    assert.equal(persisted.prefs.locale, 'zh-CN')
    assert.equal(persisted.prefs.theme, 'light')
    assert.ok(persisted.assistant.memories.some((item) => item.content === memory))
    await screenshot('restarted')
  })
  await check('renderer crash can reload saved workspace without restarting the app', async () => {
    // The only stub selects the recovery dialog's reload button; crash and reload are real.
    await electronApp.evaluate(async ({ BrowserWindow, dialog }) => {
      const original = dialog.showMessageBox
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'))
      const contents = window.webContents
      await new Promise((resolve, reject) => {
        let confirmed = false
        const timer = setTimeout(() => finish(new Error('Renderer did not reload after crash')), 20000)
        const loaded = () => finish(confirmed ? undefined : new Error('Recovery confirmation was not shown'))
        const finish = (error) => {
          clearTimeout(timer)
          contents.removeListener('did-finish-load', loaded)
          dialog.showMessageBox = original
          error ? reject(error) : resolve()
        }
        dialog.showMessageBox = async (...args) => {
          if (args[1]?.message !== '重新载入工作区？') { finish(new Error('Unexpected recovery dialog')); return { response: 1 } }
          confirmed = true
          return { response: 0, checkboxChecked: false }
        }
        contents.once('did-finish-load', loaded)
        contents.forcefullyCrashRenderer()
      })
    })
    // Playwright retains a crashed Page marker even after this Electron target
    // has reloaded. Inspect the recovered, real renderer through WebContents.
    const file = path.join(output, `desktop-smoke-${runId}-crash-recovered.png`)
    const recovered = await electronApp.evaluate(async ({ BrowserWindow }, { file, reader, names }) => {
      const contents = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html')).webContents
      const deadline = Date.now() + 15000
      let result
      do {
        result = await contents.executeJavaScript(`({
          draft: document.querySelector('textarea[aria-label="对话消息"]')?.value,
          bridge: typeof window.grok?.snapshot === 'function'
        })`)
        if (result.draft !== undefined && result.bridge) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      result.state = (await contents.executeJavaScript(`(${reader})(${JSON.stringify(names)})`))?.state
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await new Promise((resolve) => setTimeout(resolve, 200))
      process.getBuiltinModule('fs').writeFileSync(file, (await contents.capturePage()).toPNG())
      return result
    }, { file, reader: readWorkspaceInRenderer.toString(), names: workspaceStorageNames })
    assert.equal(recovered.draft, draft)
    assert.equal(recovered.bridge, true)
    assert.equal(recovered.state.activeTeamId, draftId)
    assert.ok(recovered.state.teams.some((team) => team.id === projectId))
    screenshots.push(file)
  })
  await check('no uncaught renderer errors', async () => { assert.deepEqual(errors, []) })
} catch (error) {
  record('smoke harness', false, { error: error.stack || String(error) })
} finally {
  if (page && !page.isClosed() && results.some((result) => !result.ok))
    await check('capture failure screenshot', () => screenshot('failure'))
  if (electronApp) await check('final desktop shutdown', closeApp)
  const report = { ok: results.length > 0 && results.every((result) => result.ok), mode: options.exe ? 'packaged' : 'development',
    runId, project, isolationRoot: root, output, screenshots, results, rendererErrors: errors, electronLog: log.join('').slice(-16000), resultFile }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.ok ? 0 : 1
}
