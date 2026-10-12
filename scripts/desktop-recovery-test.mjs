import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Real Electron recovery journeys. Build separately before running this script.
// Each scenario has its own account-free profile and never submits a model prompt.
// node scripts/desktop-recovery-test.mjs [--exe PATH] [--project PATH] [--playwright PATH] [--output-dir PATH]
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--exe', '--project', '--playwright', '--output-dir'].includes(key) || !process.argv[i + 1])
    throw new Error(`Unsupported or incomplete option: ${key}`)
  options[key.slice(2)] = process.argv[i + 1]
}
const project = path.resolve(options.project || '.')
const require = createRequire(path.join(project, 'package.json'))
const output = path.resolve(options['output-dir'] || path.join(project, '.tmp', 'commercial-iteration'))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'desktop-recovery-'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const resultFile = path.join(output, `desktop-recovery-${runId}.json`)
const results = [], screenshots = [], rendererErrors = [], electronLog = [], scenarios = []
let playwright

function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail })
  process.stderr.write(`${detail.skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${detail.error ? `: ${detail.error}` : ''}\n`)
}
async function check(name, fn) {
  try { record(name, true, await fn() || {}); return true }
  catch (error) { record(name, false, { error: error.stack || String(error) }); return false }
}
async function deadline(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function isolatedEnvironment(home, grokHome) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/.test(key) ||
      /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  }
  return { ...env, GROK_HOME: grokHome, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }
}
function makeScenario(name) {
  const directory = path.join(root, name), home = path.join(directory, 'home')
  const userData = path.join(directory, 'user-data'), grokHome = path.join(home, '.grok')
  const projectDirectory = path.join(directory, 'preserved-project')
  const stateFile = path.join(grokHome, 'desktop', 'state.json'), backupFile = `${stateFile}.bak`
  for (const folder of [userData, projectDirectory, path.dirname(stateFile),
    path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')])
    fs.mkdirSync(folder, { recursive: true })
  const projectName = name === 'recovered' ? '备份中保留的项目'
    : name === 'partial' ? '部分字段损坏时保留的项目' : '健康配置中的项目'
  const state = {
    projects: [{ id: `recovery-${name}`, name: projectName, path: projectDirectory }], hiddenProjects: [],
    theme: 'dark', locale: 'zh-CN', permissionMode: 'ask', wallpaperFile: null, wallpaperName: null,
    wallpaperOpacity: 40, disabledSkills: [], petAwake: ['recovered', 'partial'].includes(name), petId: 'ragdoll', petX: null, petY: null
  }
  const validState = JSON.stringify(state, null, 2)
  const primary = name === 'healthy' ? validState
    : name === 'partial' ? JSON.stringify({ ...state, theme: 'invalid-theme' }, null, 2) : '{"projects":['
  const backup = name === 'damaged' ? '{"locale":' : validState
  fs.writeFileSync(stateFile, primary, 'utf8')
  fs.writeFileSync(backupFile, backup, 'utf8')
  const fixture = { name, home, userData, grokHome, stateFile, backupFile, projectDirectory, projectName,
    expectedHealth: name === 'healthy' ? 'ready' : name, primary, backup }
  scenarios.push({ name, userData, grokHome, stateFile, backupFile, projectDirectory, expectedHealth: fixture.expectedHealth })
  return fixture
}
function unchanged(fixture) {
  assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), fixture.primary, 'the original primary must remain byte-for-byte intact')
  assert.equal(fs.readFileSync(fixture.backupFile, 'utf8'), fixture.backup, 'the recovery backup must remain byte-for-byte intact')
}
async function closeApp(app) {
  const child = app.process()
  try { await deadline(app.close(), 15000, 'Electron shutdown') }
  catch (error) {
    // Only terminate the exact subprocess launched by this test if its normal close failed.
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    throw error
  }
}
async function runScenario(fixture) {
  let app, page
  const errorsBefore = rendererErrors.length
  const label = fixture.name
  const capture = async (suffix) => {
    const file = path.join(output, `desktop-recovery-${runId}-${label}-${suffix}.png`)
    let pixels
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      await page.screenshot({ path: file, fullPage: true })
      pixels = await app.evaluate(({ nativeImage }, file) => {
        const image = nativeImage.createFromPath(file)
        const bytes = image.getBitmap(), colors = new Set()
        let nonblack = 0, sampled = 0
        const stride = Math.max(4, Math.floor(bytes.length / (4096 * 4)) * 4)
        for (let offset = 0; offset + 3 < bytes.length; offset += stride) {
          colors.add(`${bytes[offset]},${bytes[offset + 1]},${bytes[offset + 2]}`)
          if (Math.max(bytes[offset], bytes[offset + 1], bytes[offset + 2]) > 20) nonblack++
          sampled++
        }
        return { ...image.getSize(), colors: colors.size, nonblackRatio: sampled ? nonblack / sampled : 0 }
      }, file)
      if (pixels.width > 0 && pixels.height > 0 && pixels.colors > 8 && pixels.nonblackRatio > 0.05) {
        screenshots.push(file)
        return { screenshot: file, screenshotPixels: pixels }
      }
    }
    throw new Error(`Screenshot remained blank after paint waits: ${JSON.stringify(pixels)}`)
  }
  try {
    if (!await check(`${label}: isolated desktop launch`, async () => {
      const executablePath = options.exe ? path.resolve(options.exe) : require('electron')
      assert.ok(fs.existsSync(executablePath), `Electron executable missing: ${executablePath}`)
      if (!options.exe) assert.ok(fs.existsSync(path.join(project, 'out', 'preload', 'index.cjs')), 'Build the application before running this test')
      app = await playwright._electron.launch({ executablePath,
        args: [`--user-data-dir=${fixture.userData}`, ...(options.exe ? [] : [project])], cwd: project,
        env: isolatedEnvironment(fixture.home, fixture.grokHome), timeout: 45000 })
      app.process().stderr?.on('data', (data) => {
        electronLog.push({ scenario: label, text: String(data) }); if (electronLog.length > 200) electronLog.shift()
      })
      page = await app.firstWindow({ timeout: 30000 })
      page.setDefaultTimeout(15000)
      page.on('pageerror', (error) => rendererErrors.push({ scenario: label, error: error.stack || error.message }))
      await page.locator('.sidebar').waitFor()
      await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
      await page.waitForFunction(() => typeof window.grok?.snapshot === 'function')
      const isolation = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'),
        home: process.getBuiltinModule('os').homedir(), grokHome: process.env.GROK_HOME, electron: process.versions.electron }))
      const key = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
      assert.equal(key(isolation.userData), key(fixture.userData))
      assert.equal(key(isolation.home), key(fixture.home))
      assert.equal(key(isolation.grokHome), key(fixture.grokHome))
      return isolation
    })) return

    await check(`${label}: real snapshot reports configuration health without an account`, async () => {
      const snapshot = await page.evaluate(() => window.grok.snapshot())
      assert.equal(snapshot.auth.signedIn, false)
      assert.equal(snapshot.connected, false)
      assert.equal(snapshot.desktopStateHealth?.status, fixture.expectedHealth)
      assert.equal(snapshot.desktopStateHealth.path, fixture.stateFile)
      assert.equal(snapshot.desktopStateHealth.backupPath, fixture.backupFile)
      if (label !== 'damaged') {
        assert.equal(snapshot.locale, 'zh-CN')
        assert.ok(snapshot.projects.some((item) => item.name === fixture.projectName && item.path === fixture.projectDirectory))
      }
      return { status: snapshot.desktopStateHealth.status, signedIn: false, projectCount: snapshot.projects.length }
    })

    if (['recovered', 'partial'].includes(label)) await check(`${label}: persisted pet preference does not open a pet renderer during recovery`, async () => {
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
        url: window.webContents.getURL(), visible: window.isVisible()
      })))
      assert.equal(windows.length, 1, 'recovery must open only the main window despite petAwake=true')
      assert.ok(windows.every((window) => !new URL(window.url).pathname.endsWith('/pet.html')))
      return { windows, fixturePetAwake: true }
    })

    await check(`${label}: configuration state is explained accurately in the visible UI`, async () => {
      if (label === 'healthy') {
        // Waiting for the fixture project proves hydration has completed before asserting no warning.
        await page.locator('.sidebar .project-head').filter({ hasText: fixture.projectName }).waitFor()
        assert.equal(await page.locator('.startup-error[role="alert"]').count(), 0)
      } else {
        const alert = page.locator('.startup-error[role="alert"]')
        await alert.waitFor()
        const message = await alert.innerText()
        assert.match(message, label === 'recovered' ? /当前使用上一份可用备份/
          : label === 'partial' ? /部分字段无效/ : /已停止保存以保留原文件/)
        await alert.getByRole('button', { name: '打开配置目录', exact: true }).waitFor()
        await alert.getByRole('button', { name: '重新载入', exact: true }).waitFor()
        assert.equal(await alert.getByRole('button', { name: '知道了', exact: true }).count(), label === 'damaged' ? 0 : 1)
        if (label === 'recovered' || label === 'partial')
          await page.locator('.sidebar .project-head').filter({ hasText: fixture.projectName }).waitFor()
      }
      return capture('screen')
    })

    if (['recovered', 'partial'].includes(label)) await check(`${label}: the conversation editor remains usable without saving configuration`, async () => {
      const composer = page.getByRole('textbox', { name: '对话消息', exact: true })
      const draft = '恢复场景只验证本地草稿，不发送模型请求。'
      await composer.fill(draft)
      assert.equal(await composer.inputValue(), draft)
      unchanged(fixture)
      return { draftEditable: true, modelPromptSubmitted: false }
    })

    if (label === 'damaged') await check('damaged: savePrefs rejects without overwriting either recovery candidate', async () => {
      await assert.rejects(page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN', theme: 'light' })), /已停止保存以保留原文件/)
      unchanged(fixture)
      assert.equal((await page.evaluate(() => window.grok.snapshot())).desktopStateHealth.status, 'damaged')
      return { writeRejected: true, originalFilesPreserved: true }
    })
    if (label === 'healthy') {
      if (process.platform === 'darwin') await check('healthy: macOS second launch reopens a closed main window', async () => {
        await app.evaluate(({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'))
          if (!main) throw new Error('Main window missing before reopen test')
          main.close()
        })
        assert.equal(app.process().exitCode, null, 'macOS must retain the primary application after closing its last window')
        const [reopened] = await Promise.all([
          app.waitForEvent('window', { timeout: 15000 }),
          promisify(execFile)(app.process().spawnfile,
            [...(options.exe ? [] : [project]), `--user-data-dir=${fixture.userData}`],
            { cwd: project, env: isolatedEnvironment(fixture.home, fixture.grokHome), timeout: 15000 })
        ])
        page = reopened
        page.setDefaultTimeout(15000)
        await page.locator('.sidebar .project-head').filter({ hasText: fixture.projectName }).waitFor()
        assert.equal(await page.locator('.startup-error[role="alert"]').count(), 0)
        return capture('mac-reopened')
      })
      else record('healthy: macOS second launch reopens a closed main window', true,
        { skipped: true, reason: 'Requires an actual macOS host; this run does not simulate platform behavior.' })
    }
    await check(`${label}: reading configuration leaves both source files unchanged`, async () => { unchanged(fixture) })
    await check(`${label}: no uncaught renderer errors`, async () => { assert.deepEqual(rendererErrors.slice(errorsBefore), []) })
  } catch (error) {
    record(`${label}: scenario harness`, false, { error: error.stack || String(error) })
  } finally {
    if (page && !page.isClosed() && results.some((item) => !item.ok && item.name.startsWith(`${label}:`)))
      await check(`${label}: capture failure screenshot`, () => capture('failure'))
    if (app) await check(`${label}: clean shutdown`, () => closeApp(app))
    await check(`${label}: shutdown preserves original configuration and backup`, async () => { unchanged(fixture) })
  }
}

process.on('unhandledRejection', (error) => record('unhandled harness rejection', false, { error: error?.stack || String(error) }))
try {
  let entry = options.playwright || process.env.PLAYWRIGHT_PATH
  if (!entry) {
    try { entry = require.resolve('playwright') }
    catch { entry = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs') }
  }
  if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
  playwright = await import(pathToFileURL(path.resolve(entry)).href)
  for (const name of ['recovered', 'partial', 'damaged', 'healthy']) await runScenario(makeScenario(name))
} catch (error) {
  record('recovery harness', false, { error: error.stack || String(error) })
} finally {
  const report = { ok: results.length > 0 && results.every((item) => item.ok), runId,
    mode: options.exe ? 'packaged' : 'development', project, isolationRoot: root,
    modelPromptsSent: 0, scenarios, screenshots, results, rendererErrors, electronLog, platform: process.platform, resultFile }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.ok ? 0 : 1
}
