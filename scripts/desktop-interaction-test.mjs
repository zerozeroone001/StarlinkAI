import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readWorkspace, seedWorkspace, waitForWorkspace, failWorkspaceWrites, restoreWorkspaceWrites } from './desktop-test-storage.mjs'

// User journeys against a real, isolated desktop executable. All history is a
// local fixture; this script never sends prompts or uses an existing account.
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 2) {
  if (!['--exe', '--app', '--playwright', '--output-dir'].includes(args[index]) || !args[index + 1])
    throw new Error(`Unsupported or incomplete option: ${args[index]}`)
}
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const require = createRequire(import.meta.url)
const executablePath = path.resolve(option('--exe', undefined) || require('electron'))
const applicationPath = option('--app', args.includes('--exe') ? undefined : '.')
assert.ok(fs.existsSync(executablePath), `Electron executable does not exist: ${executablePath}`)
if (applicationPath) assert.ok(fs.existsSync(path.resolve(applicationPath, 'out/main/index.js')), 'Run npm run build before the interaction test')
const output = path.resolve(option('--output-dir', '.tmp/commercial-iteration'))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'interaction-'))
const home = path.join(root, 'home'), userData = path.join(root, 'user-data')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
let entry = option('--playwright', process.env.PLAYWRIGHT_PATH)
if (!entry) {
  try { entry = require.resolve('playwright') }
  catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') }
}
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const playwright = await import(pathToFileURL(entry).href)
const { _electron } = playwright._electron ? playwright : playwright.default
const env = { ...process.env, GROK_HOME: path.join(home, '.grok'), HOME: home, USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key) ||
  /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
const results = [], metrics = {}, rendererErrors = []
let app, page
const check = async (name, test) => {
  try { await test(); results.push({ name, ok: true }); console.error('PASS', name) }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error('FAIL', name, error.message) }
}
process.on('unhandledRejection', (error) => { results.push({ name: 'unhandled rejection', ok: false, error: String(error) }) })
const state = async () => (await readWorkspace(page))?.state
const waitState = (predicate, label) => waitForWorkspace(page, (value) => value && predicate(value.state), { label })
const palette = () => page.getByRole('dialog', { name: '搜索对话、项目或命令' })
const openConversation = async (query) => {
  await page.keyboard.press('Control+k')
  await palette().locator('input').fill(query)
  await page.keyboard.press('Enter')
  await palette().waitFor({ state: 'hidden' })
}
const downloadBackup = async (button) => {
  const file = path.join(root, `download-${Date.now()}.json`)
  await app.evaluate(({ session }, destination) => {
    globalThis.__backupDownload = { state: 'pending', file: destination }
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(destination)
      item.once('done', (_event, state) => { globalThis.__backupDownload.state = state })
    })
  }, file)
  await button.click()
  const deadline = Date.now() + 10000
  let status
  while (Date.now() < deadline) {
    status = await app.evaluate(() => globalThis.__backupDownload.state)
    if (status !== 'pending') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(status, 'completed', 'the backup download must complete')
  return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
}
try {
  app = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, ...(applicationPath ? [path.resolve(applicationPath)] : [])], env, timeout: 45000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  await page.getByRole('button', { name: '新建独立对话', exact: true }).click()
  await page.evaluate(() => window.grok.savePrefs({ locale: 'zh-CN' }))
  const saved = await waitState((state) => state.teams.some((team) => team.id === state.activeTeamId), 'new conversation persisted')
  {
    const team = saved.state.teams.find((item) => item.id === saved.state.activeTeamId)
    team.id = 'interaction-long'
    team.name = '验收会话 A'
    team.messages = Array.from({ length: 360 }, (_, index) => ({ id: `history-${index}`, author: index % 2 ? team.members[0].id : 'you',
      text: `${index === 0 ? '最早验收消息' : `验收消息 ${index}`}\n\n${('可重复验证的工程说明，包含接口约束、测试策略与交付检查。\n\n').repeat(8)}`,
      to: 'all', time: '10:00', kind: 'message', sample: false, status: 'completed' }))
    saved.state.teams = [team, { ...team, id: 'interaction-short', name: '验收会话 B', messages: [] }]
    saved.state.activeTeamId = team.id
    saved.state.drafts = {}
  }
  const started = performance.now()
  await seedWorkspace(page, saved)
  metrics.longConversationOpenMs = Math.round(performance.now() - started)
  metrics.initialRenderedMessages = await page.locator('.team-message').count()
  const typingStarted = performance.now()
  await page.getByRole('textbox', { name: '对话消息', exact: true }).pressSequentially('长对话内输入性能验收，不发送。')
  metrics.typeFifteenCharactersMs = Math.round(performance.now() - typingStarted)
  await page.screenshot({ path: path.join(root, 'long-conversation.png') })
  await check('long conversations mount a bounded recent window and open at the latest reply', async () => {
    assert.ok(metrics.initialRenderedMessages <= 60, `mounted ${metrics.initialRenderedMessages} messages`)
    const viewport = await page.locator('.activity-feed').evaluate((element) => ({ bottomGap: element.scrollHeight - element.scrollTop - element.clientHeight }))
    assert.ok(viewport.bottomGap < 80, `latest reply is ${viewport.bottomGap}px below the viewport`)
    assert.match(await page.locator('.team-message').last().innerText(), /验收消息 359/)
  })
  await check('loading earlier history keeps the current reading position', async () => {
    const feed = page.locator('.activity-feed')
    await feed.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
    await page.getByRole('button', { name: /加载更早的消息/ }).waitFor()
    const first = page.locator('.team-message').first()
    const text = (await first.innerText()).match(/验收消息 \d+/)[0]
    const originalTop = (await first.boundingBox()).y
    await page.getByRole('button', { name: /加载更早的消息/ }).click()
    const restored = page.locator('.team-message').filter({ hasText: text }).first()
    assert.ok(Math.abs((await restored.boundingBox()).y - originalTop) < 4, 'the previously visible message moved')
    assert.ok(await page.locator('.team-message').count() > metrics.initialRenderedMessages)
  })
  await check('search covers unloaded history and retains copy actions', async () => {
    await page.getByRole('textbox', { name: '搜索当前内容', exact: true }).fill('最早验收消息')
    const message = page.locator('.team-message').filter({ hasText: '最早验收消息' })
    await message.waitFor()
    assert.equal(await page.locator('.team-message').count(), 1)
    await message.getByRole('button', { name: '复制消息', exact: true }).click()
    assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /最早验收消息/)
    await page.getByRole('textbox', { name: '搜索当前内容', exact: true }).fill('')
  })
  const lead = (await state()).teams[0].members[0]
  const fixtureRun = { id: 'interaction-stream', workspaceId: 'interaction-long', revision: 1, status: 'running',
    createdAt: new Date().toISOString(), permissions: [], contextTrimmed: false,
    replies: [{ id: 'fixture-reply', employeeId: lead.id, provider: lead.provider, model: 'offline-fixture', text: '流式验收起点', status: 'running' }] }
  // Only the polling response for this synthetic run is replaced. The renderer,
  // preload, real IPC, persistence, Markdown and scrolling remain production code.
  await app.evaluate(({ ipcMain }, snapshot) => {
    globalThis.__interactionRun = snapshot
    ipcMain.removeHandler('workspace:run')
    ipcMain.handle('workspace:run', (_event, id) => {
      if (id !== snapshot.id) throw new Error('Unexpected run in isolated offline fixture')
      return globalThis.__interactionRun
    })
  }, fixtureRun)
  const streaming = await readWorkspace(page)
    streaming.state.activeTeamId = 'interaction-long'
    streaming.state.teams[0].messages.push({ id: 'stream-source', author: 'you', to: lead.id, text: '离线流式验收',
      time: '10:01', kind: 'message', sample: false, status: 'running', runId: 'interaction-stream' })
  await seedWorkspace(page, streaming)
  await page.getByText('流式验收起点', { exact: true }).waitFor()
  await check('incoming replies preserve reading position and the active history search', async () => {
    const feed = page.locator('.activity-feed')
    await feed.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
    await page.getByRole('button', { name: '回到最新消息', exact: true }).waitFor()
    const previous = await feed.evaluate((element) => element.scrollTop)
    await app.evaluate(() => {
      const snapshot = globalThis.__interactionRun
      snapshot.revision++
      snapshot.replies.push({ ...snapshot.replies[0], id: 'fixture-added', text: '新增验收回复' })
    })
    await page.getByText('新增验收回复', { exact: true }).waitFor()
    assert.ok(Math.abs(await feed.evaluate((element) => element.scrollTop) - previous) < 4, 'incoming output stole the reading position')
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
    await page.waitForFunction(() => { const feed = document.querySelector('.activity-feed'); return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80 })
    await page.getByRole('textbox', { name: '搜索当前内容', exact: true }).fill('最早验收消息')
    await app.evaluate(() => {
      const snapshot = globalThis.__interactionRun
      snapshot.revision++
      snapshot.replies.push({ ...snapshot.replies[0], id: 'fixture-search', text: '搜索期间的新回复' })
    })
    await waitState((state) => state.teams[0].messages.some((message) => message.text === '搜索期间的新回复'), 'streaming reply persisted')
    assert.equal(await page.getByRole('textbox', { name: '搜索当前内容', exact: true }).inputValue(), '最早验收消息')
    assert.equal(await page.locator('.team-message').count(), 1)
    await page.getByRole('textbox', { name: '搜索当前内容', exact: true }).fill('')
  })
  await app.evaluate(() => {
    globalThis.__interactionRun.revision++
    globalThis.__interactionRun.status = 'completed'
    for (const reply of globalThis.__interactionRun.replies) reply.status = 'completed'
  })
  await waitState((state) => state.teams[0].messages
    .filter((message) => message.runId === 'interaction-stream').every((message) => message.status === 'completed'), 'completed replies persisted')
  await check('command search ArrowDown and Enter choose the second result', async () => {
    await page.keyboard.press('Control+k')
    await palette().locator('input').fill('验收会话')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await palette().waitFor({ state: 'hidden' })
    await waitState((state) => state.activeTeamId === 'interaction-short', 'selected conversation persisted')
  })
  // Restore a short conversation through the same user-facing command search.
  await openConversation('验收会话 B')
  await check('storage failure clears after a successful later edit', async () => {
    await failWorkspaceWrites(page)
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('保存失败时仍保留在输入框')
    await page.getByRole('alert').filter({ hasText: /存储/ }).waitFor()
    const exported = await downloadBackup(page.getByRole('button', { name: '导出工作区备份', exact: true }))
    assert.equal(exported.value.state.drafts['interaction-short'], '保存失败时仍保留在输入框', 'backup must use memory even while storage fails')
    await restoreWorkspaceWrites(page)
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('恢复后保存的草稿')
    await waitState((state) => state.drafts['interaction-short'] === '恢复后保存的草稿', 'draft persisted after write failure')
    await page.getByRole('alert').filter({ hasText: /存储/ }).waitFor({ state: 'hidden', timeout: 1500 })
  })
  await check('storage retry saves the latest draft without another edit', async () => {
    await failWorkspaceWrites(page)
    await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('等待重试的草稿')
    await page.getByRole('alert').filter({ hasText: /存储/ }).waitFor()
    await restoreWorkspaceWrites(page)
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: /存储/ }).waitFor({ state: 'hidden' })
    await waitState((state) => state.drafts['interaction-short'] === '等待重试的草稿', 'retried draft persisted')
    await page.reload()
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), '等待重试的草稿')
  })
  await check('workspace backup can be inspected, explicitly restored, and rolled back from its prior snapshot', async () => {
    await page.locator('.sidebar-foot').getByRole('button', { name: /Settings|设置/ }).click()
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /General|通用设置/ }).click()
    const section = page.getByRole('region', { name: '工作区数据' })
    const exported = await downloadBackup(section.getByRole('button', { name: '导出工作区备份', exact: true }))
    assert.equal(exported.value.state.drafts['interaction-short'], '等待重试的草稿')
    const fileInput = page.getByLabel('导入工作区备份文件', { exact: true })
    await fileInput.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"__proto__":{"polluted":true}}') })
    await section.getByRole('alert').filter({ hasText: '不安全' }).waitFor()
    assert.equal((await state()).drafts['interaction-short'], '等待重试的草稿')
    const unsafeId = structuredClone(exported.value)
    unsafeId.state.teams[1].id = unsafeId.state.activeTeamId = 'toString'
    await fileInput.setInputFiles({ name: 'reserved-id.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsafeId)) })
    await section.getByRole('alert').filter({ hasText: '标识' }).waitFor()
    const unsafePermission = structuredClone(exported.value)
    unsafePermission.state.teams[1].messages.push({ id: 'bad-approval', author: unsafePermission.state.teams[1].members[0].id,
      text: 'Invalid approval', to: 'all', time: '', kind: 'decision', sample: false, status: 'completed', toolPermission: {
        id: 'approval', employeeId: unsafePermission.state.teams[1].members[0].id, title: 'Write', detail: '{}', createdAt: '',
        status: 'answered', options: [], optionId: 'custom', optionLabel: { bad: 'object' } } })
    await fileInput.setInputFiles({ name: 'invalid-approval.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsafePermission)) })
    await section.getByRole('alert').filter({ hasText: '审批记录' }).waitFor()
    assert.equal((await state()).drafts['interaction-short'], '等待重试的草稿')
    exported.value.state.drafts['interaction-short'] = '从备份恢复的草稿'
    await fileInput.setInputFiles({ name: 'portable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported.value)) })
    const restore = section.getByRole('button', { name: '确认替换并恢复', exact: true })
    await restore.waitFor()
    assert.equal(await restore.isEnabled(), false, 'choosing a file cannot approve replacement')
    await page.screenshot({ path: path.join(root, 'workspace-backup-confirm.png') })
    await section.getByRole('checkbox', { name: '我确认用此备份替换本地工作区' }).check()
    await restore.click()
    await waitState((state) => state.drafts['interaction-short'] === '从备份恢复的草稿', 'restored backup persisted')
    const previous = await downloadBackup(section.getByRole('button', { name: '下载替换前的备份', exact: true }))
    assert.equal(previous.value.state.drafts['interaction-short'], '等待重试的草稿')
    await page.screenshot({ path: path.join(root, 'workspace-backup.png') })
    await fileInput.setInputFiles(previous.file)
    await section.getByRole('checkbox', { name: '我确认用此备份替换本地工作区' }).check()
    await restore.click()
    await waitState((state) => state.drafts['interaction-short'] === '等待重试的草稿', 'rollback persisted')
    await page.locator('.settings-close').click()
    await page.reload()
    await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '对话消息', exact: true }).inputValue(), '等待重试的草稿')
  })
  await check('no uncaught renderer errors', async () => assert.deepEqual(rendererErrors, []))
  await page.screenshot({ path: path.join(root, 'final.png') })
} catch (error) { results.push({ name: 'harness', ok: false, error: error.stack }) }
finally {
  if (app) await check('clean exit', () => app.close())
  const report = { ok: results.length > 0 && results.every((result) => result.ok), executablePath, root, metrics, results, rendererErrors }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
