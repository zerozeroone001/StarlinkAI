import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readWorkspace, seedWorkspace, waitForWorkspace, failWorkspaceWrites, restoreWorkspaceWrites } from './desktop-test-storage.mjs'

// Real portable export/restore and project relink through isolated profiles.
// --mode baseline proves the installed 0.1.24 limitation, not feature success.
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const mode = option('--mode', 'acceptance')
assert.ok(['baseline', 'acceptance'].includes(mode), 'Use --mode baseline or --mode acceptance')
const explicitExe = option('--exe', undefined)
const executablePath = path.resolve(explicitExe || require('electron'))
const output = path.resolve(option('--output-dir', `.tmp/quality-0.1.25/${mode === 'baseline' ? 'project-relink-baseline' : 'relink-interaction'}`))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'journey-'))
const sourceDirectory = path.join(root, 'original-source')
const replacementDirectory = path.join(root, 'new-source-copy')
const archive = path.join(root, 'project.zip')
for (const directory of [sourceDirectory, replacementDirectory]) {
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'project-source.ts'), 'export const restoredDeveloperProject = true\n')
}
let entry = process.env.PLAYWRIGHT_PATH
if (!entry) {
  try { entry = require.resolve('playwright') }
  catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') }
}
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const imported = await import(pathToFileURL(entry).href)
const { _electron } = imported._electron ? imported : imported.default
const applications = [], results = [], errors = [], observations = {}
let source, target, sourceState, originalAttachment, originalImage, restoredProject, restoredChild
const dataSection = page => page.getByRole('region', { name: '工作区数据', exact: true })
const openData = async page => {
  await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
}
async function launch(name) {
  const profile = path.join(root, name), home = path.join(profile, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env, GROK_HOME: path.join(home, '.grok'), HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${path.join(profile, 'user-data')}`, ...(!explicitExe ? [process.cwd()] : [])], env, timeout: 45000 })
  applications.push(app)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
  await app.evaluate(({ ipcMain, dialog, BrowserWindow }, fixture) => {
    globalThis.__relinkCalls = { sends: 0, logins: 0, directoryPicks: 0 }
    globalThis.__relinkDirectory = fixture.sourceDirectory
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: fixture.archive })
    dialog.showOpenDialog = async (...args) => {
      const directory = args.at(-1).properties?.includes('openDirectory')
      if (directory) {
        globalThis.__relinkCalls.directoryPicks++
        if (globalThis.__holdDirectory) {
          globalThis.__directoryWaiting = true
          return new Promise(resolve => { globalThis.__releaseDirectory = () => resolve({ canceled: true, filePaths: [] }) })
        }
        return globalThis.__relinkDirectory ? { canceled: false, filePaths: [globalThis.__relinkDirectory] } : { canceled: true, filePaths: [] }
      }
      return { canceled: false, filePaths: [fixture.archive] }
    }
    for (const channel of ['workspace:start', 'workspace:login']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        globalThis.__relinkCalls[channel === 'workspace:start' ? 'sends' : 'logins']++
        throw new Error('Offline project relink test forbids model and authorization requests')
      })
    }
    ipcMain.removeHandler('workspace:providers')
    ipcMain.handle('workspace:providers', (_event, _refresh, ids = ['claude', 'codex', 'grok', 'gemini']) => ids.map(id => ({
      id, cli: { state: 'not_found', version: null, path: null }, auth: null, models: [],
      checkedAt: new Date().toISOString(), usage: null, loginCommand: `${id} login`
    })))
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(...window.getMinimumSize())
  }, { sourceDirectory, archive })
  await page.reload()
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  return { app, page, profile }
}
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.error('PASS', name) }
  catch (error) {
    results.push({ name, ok: false, error: error.stack })
    const page = target?.page || source?.page
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(root, 'failure.png') }); fs.writeFileSync(path.join(root, 'failure-ui.txt'), await page.locator('body').innerText()) }
      catch (captureError) { errors.push(`Failure capture: ${captureError.message}`) }
    }
    throw error
  }
}
async function closeApp(app) {
  const calls = await app.evaluate(() => globalThis.__relinkCalls)
  assert.equal(calls.sends, 0); assert.equal(calls.logins, 0)
  await app.close()
  applications.splice(applications.indexOf(app), 1)
}
try {
  source = await launch('source')
  observations.applicationVersion = await source.app.evaluate(({ app }) => app.getVersion())
  await check('create source project with source code, child draft, assistant memory and real historical media', async () => {
    sourceState = await waitForWorkspace(source.page, value => value?.state.teams.length > 0)
    const template = structuredClone(sourceState.state.teams[0])
    const project = { ...template, id: 'relink-source-project', kind: 'project', name: '恢复后待关联的项目', parentId: null, directory: sourceDirectory, messages: [] }
    const child = { ...structuredClone(template), id: 'relink-source-child', kind: 'conversation', name: '保留历史的项目对话', parentId: project.id, directory: sourceDirectory }
    sourceState.state.teams = [project, child]
    sourceState.state.activeTeamId = project.id
    sourceState.state.drafts = { [child.id]: '继续开发前保留的草稿' }
    await seedWorkspace(source.page, sourceState)
    const fixture = await source.page.evaluate(async ({ projectId, directory }) => {
      const api = window.grok.workspace
      await api.updateAssistant(projectId, { name: '恢复项目助手', persona: '保留原项目上下文' })
      await api.saveMemory(projectId, { kind: 'fact', content: '项目历史记忆应跨目录保留' })
      return {
        attachment: await api.upload(projectId, { name: 'history-note.txt', data: btoa('historical attachment exact bytes') }, directory),
        image: await api.upload(projectId, { name: 'history-image.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8KgAAAABJRU5ErkJggg==' }, directory)
      }
    }, { projectId: project.id, directory: sourceDirectory })
    originalAttachment = fixture.attachment; originalImage = fixture.image
    sourceState.state.attachmentDrafts = { [child.id]: [originalAttachment] }
    child.messages = [{ id: 'relink-history-message', author: child.members[0].id, to: 'all', text: '已保存的项目历史图片', time: '10:00', kind: 'message', status: 'completed', sample: false, images: [{ path: originalImage.path, alt: '历史图片保留' }] }]
    await seedWorkspace(source.page, sourceState)
  })
  await check('export source and restore portable project into a second isolated profile', async () => {
    await openData(source.page)
    await dataSection(source.page).getByRole('button', { name: '导出便携 ZIP', exact: true }).click()
    const dialog = source.page.getByRole('dialog', { name: '导出便携备份', exact: true })
    await dialog.getByRole('button', { name: '选择位置并导出 ZIP', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await dataSection(source.page).getByRole('status').filter({ hasText: '便携备份已保存' }).waitFor()
    assert.equal(fs.readFileSync(archive).subarray(0, 2).toString(), 'PK')
    await closeApp(source.app)
    target = await launch('target')
    await openData(target.page)
    await dataSection(target.page).getByRole('button', { name: '选择便携备份并预览', exact: true }).click()
    const preview = target.page.getByRole('dialog', { name: '预览并恢复便携备份', exact: true })
    await preview.getByRole('checkbox', { name: '我确认用此备份替换工作区及助手资料', exact: true }).check()
    await preview.getByRole('button', { name: '确认替换并恢复便携备份', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    await dataSection(target.page).getByRole('status').filter({ hasText: '便携备份已恢复并保存' }).waitFor()
    await target.page.locator('.settings-close').click()
  })
  await check('restored managed directory preserves referenced bytes but excludes project source', async () => {
    const saved = await waitForWorkspace(target.page, value => value?.state.teams.some(team => team.name === '恢复后待关联的项目'))
    restoredProject = saved.state.teams.find(team => team.kind === 'project')
    restoredChild = saved.state.teams.find(team => team.parentId === restoredProject.id)
    assert.notEqual(restoredProject.id, 'relink-source-project')
    assert.ok(restoredProject.directory.startsWith(target.profile))
    assert.equal(restoredChild.directory, restoredProject.directory)
    assert.equal(fs.existsSync(path.join(restoredProject.directory, 'project-source.ts')), false)
    assert.equal(fs.existsSync(path.join(replacementDirectory, 'project-source.ts')), true)
    assert.deepEqual(fs.readFileSync(saved.state.attachmentDrafts[restoredChild.id][0].path), fs.readFileSync(originalAttachment.path))
    assert.deepEqual(fs.readFileSync(restoredChild.messages[0].images[0].path), fs.readFileSync(originalImage.path))
    const assistant = await target.page.evaluate(id => window.grok.workspace.assistant(id), restoredProject.id)
    assert.equal(assistant.profile.name, '恢复项目助手')
    assert.equal(assistant.memories[0].content, '项目历史记忆应跨目录保留')
    observations.restoredDirectory = restoredProject.directory
    observations.replacementDirectory = replacementDirectory
  })
  if (mode === 'baseline') await check('baseline: restored project empty state offers account connection but no source directory guidance', async () => {
    await target.page.locator('.sidebar-team-main').filter({ hasText: '恢复后待关联的项目' }).click()
    await target.page.getByRole('button', { name: '连接模型账号', exact: true }).first().waitFor()
    assert.equal(await target.page.getByRole('button', { name: /重关联|重新关联|连接源码|关联源码|更换项目目录/ }).count(), 0)
    observations.emptyState = await target.page.locator('body').innerText()
    await target.page.screenshot({ path: path.join(root, 'restored-project-empty-state.png') })
    const openDetails = target.page.getByRole('button', { name: '展开对话侧栏', exact: true })
    if (await openDetails.count()) await openDetails.click()
    await target.page.getByRole('button', { name: '编辑项目', exact: true }).waitFor()
    observations.directoryDisplay = await target.page.locator('.workspace-directory').evaluate(node => ({ tag: node.tagName, role: node.getAttribute('role'), text: node.textContent, focusable: node.tabIndex >= 0 }))
    assert.equal(observations.directoryDisplay.tag, 'DIV')
    assert.equal(observations.directoryDisplay.focusable, false)
    await target.page.screenshot({ path: path.join(root, 'restored-project-directory-details.png') })
  })
  if (mode === 'baseline') await check('baseline: project editor directory is read-only and exposes no native folder selection or relink action', async () => {
    const before = (await readWorkspace(target.page)).state
    const picksBefore = (await target.app.evaluate(() => globalThis.__relinkCalls)).directoryPicks
    await target.page.getByRole('button', { name: '编辑项目', exact: true }).click()
    const dialog = target.page.getByRole('dialog', { name: '编辑项目', exact: true })
    const directory = dialog.getByRole('textbox', { name: '项目目录', exact: true })
    assert.equal(await directory.inputValue(), restoredProject.directory)
    assert.equal(await directory.evaluate(input => input.readOnly), true)
    assert.equal(await dialog.getByRole('button', { name: /浏览|选择已有目录|更换|重新关联|重关联/ }).count(), 0)
    observations.editor = await dialog.innerText()
    await target.page.screenshot({ path: path.join(root, 'restored-project-editor-readonly.png') })
    await target.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual((await readWorkspace(target.page)).state, before)
    assert.equal((await target.app.evaluate(() => globalThis.__relinkCalls)).directoryPicks, picksBefore)
  })
  if (mode === 'acceptance') {
    const editor = () => target.page.getByRole('dialog', { name: '编辑项目', exact: true })
    const relink = () => target.page.getByRole('dialog', { name: '重新关联项目目录', exact: true })
    const openEditor = async () => {
      await target.page.locator('.sidebar-team-main').filter({ hasText: '恢复后待关联的项目' }).click()
      const details = target.page.getByRole('button', { name: '展开对话侧栏', exact: true })
      if (await details.count()) await details.click()
      await target.page.getByRole('button', { name: '编辑项目', exact: true }).click()
    }
    const chooseDirectory = async (directory = replacementDirectory) => target.app.evaluate((_electron, value) => { globalThis.__relinkDirectory = value }, directory)
    const startRelink = async () => editor().getByRole('button', { name: '重新关联目录…', exact: true }).click()
    const waitPreview = async () => relink().getByRole('checkbox', { name: '我确认将项目及其子对话关联到新目录', exact: true }).waitFor()
    const confirm = async () => relink().getByRole('checkbox', { name: '我确认将项目及其子对话关联到新目录', exact: true }).check()
    const waitMain = async predicate => {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (await target.app.evaluate(predicate)) return
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      throw new Error('Main-process relink checkpoint did not arrive')
    }
    await check('related executing messages disable directory changes without starting or interrupting a model run', async () => {
      const current = await readWorkspace(target.page)
      const blocked = structuredClone(current)
      const child = blocked.state.teams.find(team => team.id === restoredChild.id)
      child.messages[0].status = 'needs_permission'
      await seedWorkspace(target.page, blocked)
      await openEditor()
      assert.equal(await editor().getByRole('button', { name: '重新关联目录…', exact: true }).isEnabled(), false)
      await editor().getByRole('status').filter({ hasText: '请等待执行和助手资料读写结束' }).waitFor()
      await target.page.screenshot({ path: path.join(root, 'relink-execution-blocked.png') })
      await target.page.keyboard.press('Escape')
      // Completed execution metadata is seeded without a live request so relink
      // must disconnect it while retaining its message/task/artifact IDs.
      const history = current.state.teams.find(team => team.id === restoredChild.id)
      current.state.teams.find(team => team.id === restoredProject.id).permissionMode = 'auto'
      history.permissionMode = 'auto'
      Object.assign(history.messages[0], { runId: 'completed-before-relink', sessionId: 'provider-session-before-relink', taskId: 'relink-history-task', artifactId: 'relink-history-artifact' })
      history.tasks = [{ id: 'relink-history-task', title: '已验收的历史任务', description: '保留任务内容', owner: history.members[0].id,
        state: 'done', dependency: null, acceptance: '结果已确认', resultRunId: 'completed-before-relink', acceptedRunId: 'completed-before-relink',
        managedRunId: 'completed-before-relink', managedStatus: 'completed' }]
      history.artifacts = [{ id: 'relink-history-artifact', name: '历史成果', description: '保留成果内容', owner: history.members[0].id,
        version: 1, content: '历史交付物内容不变', format: 'md', sample: false }]
      await seedWorkspace(target.page, current)
    })
    await check('native directory cancellation preserves the project and unsaved name and goal fields', async () => {
      await openEditor()
      await editor().getByRole('textbox', { name: '项目名称', exact: true }).fill('尚未保存的项目名称')
      await editor().getByRole('textbox', { name: '项目目标', exact: true }).fill('尚未保存的项目目标')
      const before = (await readWorkspace(target.page)).state
      await chooseDirectory(null)
      await startRelink()
      await relink().waitFor({ state: 'hidden' })
      assert.equal(await editor().getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '尚未保存的项目名称')
      assert.deepEqual((await readWorkspace(target.page)).state, before)
      await chooseDirectory()
    })
    await check('preparing can be cancelled by Escape and waits for the native selection to unwind', async () => {
      const before = (await readWorkspace(target.page)).state
      await target.app.evaluate(() => { globalThis.__holdDirectory = true; globalThis.__directoryWaiting = false })
      await startRelink()
      await waitMain(() => globalThis.__directoryWaiting)
      await target.page.waitForFunction(() => document.querySelector('dialog[aria-label="重新关联项目目录"] button[aria-label="关闭弹窗"]')?.disabled === false)
      await target.page.keyboard.press('Escape')
      await relink().getByText('正在取消，请稍候…', { exact: true }).waitFor()
      await target.app.evaluate(() => { globalThis.__holdDirectory = false; globalThis.__releaseDirectory() })
      await relink().waitFor({ state: 'hidden' })
      assert.deepEqual((await readWorkspace(target.page)).state, before)
    })
    await check('invalid selected source directory gives an error without replacing existing project data', async () => {
      const before = (await readWorkspace(target.page)).state
      await chooseDirectory(path.join(replacementDirectory, 'not-a-directory'))
      await startRelink()
      await relink().getByRole('alert').waitFor()
      await target.page.screenshot({ path: path.join(root, 'relink-invalid-directory.png') })
      assert.deepEqual((await readWorkspace(target.page)).state, before)
      assert.equal(await relink().getByRole('button', { name: '确认关联并保存', exact: true }).count(), 0)
      await relink().getByRole('button', { name: '返回编辑', exact: true }).click()
      await chooseDirectory()
    })
    await check('preview communicates source scope and historical resources; Tab and Escape stay in the nested dialog', async () => {
      const before = (await readWorkspace(target.page)).state
      await startRelink(); await waitPreview()
      assert.equal(await relink().getByRole('button', { name: '确认关联并保存', exact: true }).isEnabled(), false)
      assert.match(await relink().innerText(), /1 个现有子对话/)
      assert.match(await relink().innerText(), /不会向新目录复制资料或覆盖源码/)
      assert.match(await relink().innerText(), /不保存编辑表单中尚未提交的名称和目标/)
      assert.match(await relink().innerText(), /新目录中的工具操作会重新逐次请求批准，不沿用原目录的自动许可/)
      await target.page.keyboard.press('Tab')
      assert.equal(await target.page.evaluate(() => document.activeElement?.closest('dialog')?.getAttribute('aria-label')), '重新关联项目目录')
      await target.page.screenshot({ path: path.join(root, 'relink-preview-minimum.png') })
      await target.page.keyboard.press('Escape')
      await relink().waitFor({ state: 'hidden' })
      assert.equal(await editor().isVisible(), true)
      assert.deepEqual((await readWorkspace(target.page)).state, before)
      assert.deepEqual(fs.readdirSync(replacementDirectory), ['project-source.ts'])
    })
    await check('a lost IPC response after publishing the relink plan preserves the old workspace and releases the host lease', async () => {
      const before = (await readWorkspace(target.page)).state
      const beforeHash = createHash('sha256').update(JSON.stringify(before)).digest('hex')
      await startRelink(); await waitPreview(); await confirm()
      await target.app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('projectRelink:commit')
        if (!original) throw new Error('Project relink commit IPC handler missing')
        globalThis.__originalRelinkCommit = original
        globalThis.__relinkDroppedResponse = false
        ipcMain.removeHandler('projectRelink:commit')
        ipcMain.handle('projectRelink:commit', async (...args) => {
          const plan = await original(...args)
          // The service is now committing; no plan reaches renderer/IndexedDB.
          if (!globalThis.__relinkDroppedResponse) {
            globalThis.__relinkDroppedResponse = true
            throw new Error('测试：关联计划已发布，但 IPC 响应丢失')
          }
          return plan
        })
      })
      try {
        await relink().getByRole('button', { name: '确认关联并保存', exact: true }).click()
        await relink().getByRole('alert').filter({ hasText: 'IPC 响应丢失' }).waitFor()
        assert.equal(await target.app.evaluate(() => globalThis.__relinkDroppedResponse), true)
        const after = (await readWorkspace(target.page)).state
        const afterHash = createHash('sha256').update(JSON.stringify(after)).digest('hex')
        assert.deepEqual(after, before)
        assert.equal(afterHash, beforeHash)
        assert.equal(await editor().getByRole('textbox', { name: '项目目录', exact: true }).inputValue(), restoredProject.directory)
        assert.equal(await editor().getByRole('status').filter({ hasText: '项目目录已重新关联并保存' }).count(), 0)
        await target.page.waitForFunction(async () => (await window.grok.projectRelink.status()).phase === 'idle')
        await target.page.screenshot({ path: path.join(root, 'relink-lost-ipc-response.png') })
        await relink().getByRole('button', { name: '返回编辑', exact: true }).click()
        await relink().waitFor({ state: 'hidden' })
        await startRelink(); await waitPreview()
        assert.equal((await target.page.evaluate(() => window.grok.projectRelink.status())).phase, 'preview')
        observations.lostIpcResponse = { beforeHash, afterHash, releasedPhase: 'idle', nextPreparationPhase: 'preview' }
        await target.page.keyboard.press('Escape')
        await relink().waitFor({ state: 'hidden' })
        assert.deepEqual((await readWorkspace(target.page)).state, before)
      } finally {
        await target.app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('projectRelink:commit')
          ipcMain.handle('projectRelink:commit', globalThis.__originalRelinkCommit)
          delete globalThis.__originalRelinkCommit
        })
      }
    })
    await check('an IndexedDB commit failure never claims success and retains the old durable and visible directory', async () => {
      const before = (await readWorkspace(target.page)).state
      await startRelink(); await waitPreview(); await confirm()
      await failWorkspaceWrites(target.page)
      await relink().getByRole('button', { name: '确认关联并保存', exact: true }).click()
      await relink().getByRole('alert').waitFor()
      assert.deepEqual((await readWorkspace(target.page)).state, before)
      assert.equal(await editor().getByRole('textbox', { name: '项目目录', exact: true }).inputValue(), restoredProject.directory)
      assert.equal(await editor().getByRole('status').filter({ hasText: '项目目录已重新关联并保存' }).count(), 0)
      await target.page.screenshot({ path: path.join(root, 'relink-write-failure.png') })
      await restoreWorkspaceWrites(target.page)
      await relink().getByRole('button', { name: '返回编辑', exact: true }).click()
    })
    await check('missing historical media requires a separate acknowledgement and cancellation retains its original reference', async () => {
      const before = (await readWorkspace(target.page)).state
      const imagePath = restoredChild.messages[0].images[0].path
      const relative = path.relative(target.profile, imagePath)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Only isolated fixture media may be moved')
      const unavailablePath = imagePath + '.relink-test-away'
      fs.renameSync(imagePath, unavailablePath)
      try {
        await startRelink(); await waitPreview(); await confirm()
        await relink().getByRole('region', { name: '未保留的历史资源', exact: true }).waitFor()
        assert.equal(await relink().getByRole('button', { name: '确认关联并保存', exact: true }).isEnabled(), false)
        await relink().getByRole('checkbox', { name: '我已了解缺失资源，仍继续关联', exact: true }).check()
        assert.equal(await relink().getByRole('button', { name: '确认关联并保存', exact: true }).isEnabled(), true)
        await target.page.screenshot({ path: path.join(root, 'relink-missing-resource.png') })
        await target.page.keyboard.press('Escape')
        await relink().waitFor({ state: 'hidden' })
        assert.deepEqual((await readWorkspace(target.page)).state, before)
      } finally { fs.renameSync(unavailablePath, imagePath) }
    })
    await check('double confirmation commits once, prevents close while saving and preserves unrelated form edits', async () => {
      await startRelink(); await waitPreview(); await confirm()
      await target.app.evaluate(({ ipcMain }) => {
        const entry = [...ipcMain._invokeHandlers].find(([name]) => /relink/i.test(name) && /:commit$/.test(name))
        if (!entry) throw new Error('Project relink commit IPC handler missing')
        const [channel, original] = entry
        globalThis.__relinkCommitCount = 0; globalThis.__relinkCommitWaiting = false
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (...args) => {
          globalThis.__relinkCommitCount++
          const plan = await original(...args)
          globalThis.__relinkCommitWaiting = true
          await new Promise(resolve => { globalThis.__releaseRelinkCommit = resolve })
          return plan
        })
      })
      await relink().getByRole('button', { name: '确认关联并保存', exact: true }).evaluate(button => { button.click(); button.click() })
      await waitMain(() => globalThis.__relinkCommitWaiting)
      assert.equal(await target.app.evaluate(() => globalThis.__relinkCommitCount), 1)
      assert.equal(await relink().getByRole('button', { name: '关闭弹窗', exact: true }).isEnabled(), false)
      assert.equal(await relink().getByRole('button', { name: '取消操作', exact: true }).isEnabled(), false)
      await target.page.keyboard.press('Escape')
      assert.equal(await relink().isVisible(), true)
      assert.equal(await editor().getByRole('status').filter({ hasText: '项目目录已重新关联并保存' }).count(), 0)
      await target.page.screenshot({ path: path.join(root, 'relink-awaits-commit.png') })
      await target.app.evaluate(() => globalThis.__releaseRelinkCommit())
      await relink().waitFor({ state: 'hidden' })
      await editor().getByRole('status').filter({ hasText: '项目目录已重新关联并保存' }).waitFor()
      assert.equal(await editor().getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '尚未保存的项目名称')
      assert.equal(await editor().getByRole('textbox', { name: '项目目标', exact: true }).inputValue(), '尚未保存的项目目标')
      assert.equal(await editor().getByRole('textbox', { name: '项目目录', exact: true }).inputValue(), fs.realpathSync(replacementDirectory))
      const saved = await waitForWorkspace(target.page, value => value?.state.teams.find(team => team.id === restoredProject.id)?.directory === fs.realpathSync(replacementDirectory))
      assert.equal(saved.state.teams.find(team => team.id === restoredProject.id).name, '恢复后待关联的项目')
      assert.equal(saved.state.teams.find(team => team.id === restoredChild.id).directory, fs.realpathSync(replacementDirectory))
      assert.equal(saved.state.drafts[restoredChild.id], '继续开发前保留的草稿')
      await target.page.screenshot({ path: path.join(root, 'relink-saved-parent-fields.png') })
      // Saving the previously open editor must use the new directory, not its old prop.
      await editor().getByRole('textbox', { name: '项目名称', exact: true }).fill('恢复后待关联的项目')
      await editor().getByRole('button', { name: '保存更改', exact: true }).click()
      await editor().waitFor({ state: 'hidden' })
      await waitForWorkspace(target.page, value => value?.state.teams.find(team => team.id === restoredProject.id)?.goal === '尚未保存的项目目标')
      assert.deepEqual(fs.readdirSync(replacementDirectory), ['project-source.ts'])
      assert.equal(fs.readFileSync(path.join(replacementDirectory, 'project-source.ts'), 'utf8'), 'export const restoredDeveloperProject = true\n')
    })
    await check('successful relink preserves IDs and assistant data and the new directory survives a restart', async () => {
      await closeApp(target.app); target = await launch('target')
      const saved = await waitForWorkspace(target.page, value => value?.state.teams.find(team => team.id === restoredProject.id)?.directory === fs.realpathSync(replacementDirectory))
      restoredProject = saved.state.teams.find(team => team.id === restoredProject.id)
      restoredChild = saved.state.teams.find(team => team.id === restoredChild.id)
      assert.equal(restoredChild.parentId, restoredProject.id)
      assert.equal(restoredChild.directory, restoredProject.directory)
      assert.equal(restoredProject.permissionMode, 'ask')
      assert.equal(restoredChild.permissionMode, 'ask')
      assert.equal(restoredChild.messages[0].sessionId, undefined)
      assert.equal(restoredChild.messages[0].runId, 'restored-history:completed-before-relink')
      assert.equal(restoredChild.messages[0].taskId, restoredChild.tasks[0].id)
      assert.equal(restoredChild.messages[0].artifactId, restoredChild.artifacts[0].id)
      assert.equal(restoredChild.tasks[0].managedRunId, undefined)
      assert.equal(restoredChild.tasks[0].managedStatus, undefined)
      assert.equal(restoredChild.tasks[0].resultRunId, restoredChild.messages[0].runId)
      assert.equal(restoredChild.tasks[0].acceptedRunId, restoredChild.messages[0].runId)
      assert.equal(restoredChild.artifacts[0].content, '历史交付物内容不变')
      assert.deepEqual(fs.readFileSync(saved.state.attachmentDrafts[restoredChild.id][0].path), fs.readFileSync(originalAttachment.path))
      assert.deepEqual(fs.readFileSync(restoredChild.messages[0].images[0].path), fs.readFileSync(originalImage.path))
      const assistant = await target.page.evaluate(id => window.grok.workspace.assistant(id), restoredProject.id)
      assert.equal(assistant.profile.name, '恢复项目助手')
      assert.equal(assistant.memories[0].content, '项目历史记忆应跨目录保留')
      const details = target.page.getByRole('button', { name: '展开对话侧栏', exact: true })
      if (await details.count()) await details.click()
    })
  }
  await check('existing child draft, historical image and assistant scope stay available throughout the relink journey', async () => {
    await target.page.locator('.project-conversation-list').getByRole('button', { name: '保留历史的项目对话', exact: true }).click()
    assert.equal(await target.page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), '继续开发前保留的草稿')
    await target.page.getByText('已保存的项目历史图片', { exact: true }).first().waitFor()
    const image = restoredChild.messages[0].images[0]
    const preview = await target.page.evaluate(({ id, source, directory }) => window.grok.workspace.media(id, source, directory), { id: restoredProject.id, source: image.path, directory: restoredChild.directory })
    assert.match(preview.dataUrl, /^data:image/)
    await target.page.waitForFunction(() => [...document.querySelectorAll('.chat-images img')].some(image => image.complete && image.naturalWidth > 0))
    await target.page.screenshot({ path: path.join(root, 'restored-child-history-and-draft.png') })
    if (mode === 'acceptance') {
      // Test the real gallery source helper without triggering image generation.
      // The bundle exists only in this isolated test page, never in production.
      const bundle = await require('esbuild').build({ stdin: { contents: "export { collectGalleryImages, galleryImageData } from './src/renderer/src/lib/gallery'", resolveDir: process.cwd(), loader: 'ts' },
        bundle: true, write: false, format: 'iife', globalName: '__relinkGalleryTest', platform: 'browser', alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
      await target.page.evaluate(bundle.outputFiles[0].text)
      const teams = (await readWorkspace(target.page)).state.teams
      const galleryBytes = await target.page.evaluate(async ({ teams, childId }) => {
        const item = globalThis.__relinkGalleryTest.collectGalleryImages(teams).find(item => item.workspaceId === childId)
        if (!item) throw new Error('Restored image missing from gallery')
        return globalThis.__relinkGalleryTest.galleryImageData(item)
      }, { teams, childId: restoredChild.id })
      assert.deepEqual(Buffer.from(galleryBytes.split(',')[1], 'base64'), fs.readFileSync(originalImage.path))
      await target.page.getByRole('button', { name: '画廊', exact: true }).click()
      await target.page.waitForFunction(() => [...document.querySelectorAll('.gallery-card img')].some(image => image.complete && image.naturalWidth > 0))
      await target.page.getByRole('button', { name: '编辑图片', exact: true }).first().click()
      await target.page.waitForFunction(() => [...document.querySelectorAll('.gallery-edit-references img')].some(image => image.complete && image.naturalWidth > 0))
      await target.page.screenshot({ path: path.join(root, 'relinked-gallery-reference.png') })
      await target.page.getByRole('button', { name: '取消编辑', exact: true }).click()
      await target.page.locator('.sidebar-team-main').filter({ hasText: '保留历史的项目对话' }).click()
      await target.page.getByLabel('选择对话附件', { exact: true }).setInputFiles({ name: 'relinked-child-note.txt', mimeType: 'text/plain', buffer: Buffer.from('new child attachment stays in project asset scope') })
      const saved = await waitForWorkspace(target.page, value => value?.state.attachmentDrafts[restoredChild.id]?.some(item => item.name === 'relinked-child-note.txt'))
      const attachment = saved.state.attachmentDrafts[restoredChild.id].find(item => item.name === 'relinked-child-note.txt')
      const relative = path.relative(observations.restoredDirectory, attachment.path)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'new child attachment stays in project asset scope')
      assert.deepEqual(fs.readdirSync(replacementDirectory), ['project-source.ts'])
    }
    assert.deepEqual(errors, [])
    const calls = await target.app.evaluate(() => globalThis.__relinkCalls)
    assert.equal(calls.sends, 0); assert.equal(calls.logins, 0)
    observations.calls = calls
  })
} catch (error) { results.push({ name: 'harness', ok: false, error: error.stack }) }
finally {
  for (const app of [...applications]) {
    try { await app.evaluate(() => { globalThis.__releaseDirectory?.(); globalThis.__releaseRelinkCommit?.() }); await closeApp(app); results.push({ name: 'isolated profile clean exit', ok: true }) }
    catch (error) { results.push({ name: 'isolated profile clean exit', ok: false, error: error.stack }) }
  }
  const report = { ok: results.length > 0 && results.every(item => item.ok), kind: mode === 'baseline' ? 'project-relink-gap-baseline' : 'project-relink-acceptance', mode, executablePath, root, results, observations, errors }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
