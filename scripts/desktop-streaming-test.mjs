import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readWorkspace, seedWorkspace, waitForWorkspace, WORKSPACE_DATABASE_NAME } from './desktop-test-storage.mjs'

// Real desktop streaming with controlled runtime IPC, never a model request.
// Native put is timed without serializing payloads inside the measured interval.
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--exe', '--app', '--output-dir', '--seconds', '--scenarios', '--playwright'].includes(args[i]) && args[i + 1], `Invalid option: ${args[i]}`)
  options[args[i].slice(2)] = args[i + 1]
}
const require = createRequire(import.meta.url)
const executablePath = path.resolve(options.exe || require('electron'))
const application = options.app || (options.exe ? null : '.')
const seconds = Number(options.seconds || 32)
assert.ok(seconds >= 30 && seconds <= 120)
const scenarios = (options.scenarios || 'single,multiple').split(',')
assert.ok(scenarios.every((s) => ['single', 'multiple'].includes(s)))
const output = path.resolve(options['output-dir'] || '.tmp/quality-0.1.23')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'streaming-'))
let entry = options.playwright || process.env.PLAYWRIGHT_PATH
if (!entry) {
  try { entry = require.resolve('playwright') }
  catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') }
}
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const playwright = await import(pathToFileURL(entry).href)
const { _electron } = playwright._electron ? playwright : playwright.default
const results = [], measurements = [], rendererErrors = []
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const round = (value) => Math.round(value * 100) / 100
const summarize = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  return { count: sorted.length, total: round(sorted.reduce((s, v) => s + v, 0)), median: round(sorted[Math.floor(sorted.length / 2)] || 0),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0), max: round(sorted.at(-1) || 0) }
}
const record = (name, ok, details = {}) => { results.push({ name, ok, ...details }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
function env(home) {
  const value = { ...process.env }
  for (const key of Object.keys(value)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/.test(key) ||
    /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete value[key]
  return { ...value, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
}
function fixture(count) {
  const teams = Array.from({ length: count }, (_, index) => ({ id: `stream-${index}`, kind: 'conversation', parentId: null,
    defaultProvider: 'grok', name: `流式验收 ${index + 1}`, goal: '', sample: false, paused: false, permissionMode: 'ask',
    members: [{ id: `lead-${index}`, name: '主 agent', provider: 'grok', role: 'assistant', persona: '', isLead: true }],
    messages: Array.from({ length: 240 }, (_, message) => ({ id: `history-${index}-${message}`, author: message % 2 ? `lead-${index}` : 'you', to: 'all',
      text: `Synthetic history ${index}/${message}. No model request.`, time: '10:00', kind: 'message', sample: false, status: 'completed' })), tasks: [], artifacts: [] }))
  const value = { version: 2, state: { teams, activeTeamId: teams[0].id, drafts: {}, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] } }
  const remaining = 12 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(value)), entries = count * 180
  teams.forEach((team, index) => team.messages.slice(0, 180).forEach((message, j) => { message.text += 'x'.repeat(Math.floor(remaining / entries) + (index * 180 + j < remaining % entries ? 1 : 0)) }))
  assert.equal(Buffer.byteLength(JSON.stringify(value)), 12 * 1024 * 1024)
  for (const team of teams) team.messages.push({ id: `source-${team.id}`, author: 'you', to: team.members[0].id,
    text: '离线持续回复验收', time: '10:01', kind: 'message', sample: false, status: 'running', runId: `run-${team.id}` })
  return value
}
async function launch(directory, label) {
  const home = path.join(directory, 'home'), profile = path.join(directory, 'profile')
  for (const folder of [home, profile, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(folder, { recursive: true })
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, ...(application ? [path.resolve(application)] : [])], env: env(home), timeout: 45000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => rendererErrors.push({ label, message: error.message }))
  await page.getByRole('textbox', { name: '对话消息', exact: true }).waitFor()
  const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, profile: app.getPath('userData') }))
  assert.equal(path.resolve(metadata.profile), profile)
  assert.equal((await page.evaluate(() => window.grok.snapshot())).auth.signedIn, false)
  return { app, page, metadata }
}
async function instrument(page) {
  await page.evaluate((database) => {
    const samples = window.__streamSamples = { active: true, transactions: [], puts: [], longTasks: [], inputPaint: [] }
    const transaction = IDBDatabase.prototype.transaction, tracked = new WeakMap()
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (samples.active && this.name === database && args[1] === 'readwrite') {
        const sample = { start: performance.now(), duration: null, aborted: false }
        samples.transactions.push(sample); tracked.set(tx, sample)
        tx.addEventListener('complete', () => { sample.duration = performance.now() - sample.start })
        tx.addEventListener('abort', () => { sample.duration = performance.now() - sample.start; sample.aborted = true })
      }
      return tx
    }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (!samples.active || !tracked.has(this.transaction)) return put.call(this, value, ...args)
      const started = performance.now()
      try { return put.call(this, value, ...args) }
      finally { samples.puts.push({ value, duration: performance.now() - started }) }
    }
    samples.observer = new PerformanceObserver((list) => { if (samples.active) samples.longTasks.push(...list.getEntries().map((entry) => entry.duration)) })
    samples.observer.observe({ type: 'longtask' })
    document.addEventListener('input', (event) => {
      if (!samples.active || !event.target.matches('textarea[aria-label="对话消息"]')) return
      const started = performance.now()
      requestAnimationFrame(() => { if (samples.active) samples.inputPaint.push(performance.now() - started) })
    }, true)
  }, WORKSPACE_DATABASE_NAME)
}
async function stopInstrumentation(page) {
  return page.evaluate(() => {
    const samples = window.__streamSamples
    samples.active = false; samples.observer.disconnect()
    // Payload encoding happens after the interval. These are logical JSON byte
    // counts, not physical disk bytes; structured-clone and compression differ.
    const encoder = new TextEncoder(), byKind = {}
    for (const put of samples.puts) {
      const kind = put.value?.kind || 'other'
      const totals = byKind[kind] ||= { records: 0, bytes: 0, nativePutMs: [] }
      totals.records++; totals.bytes += encoder.encode(JSON.stringify(put.value)).byteLength; totals.nativePutMs.push(put.duration)
    }
    return { transactions: samples.transactions.map(({ start, ...rest }) => rest), byKind, longTasks: samples.longTasks, inputPaint: samples.inputPaint }
  })
}
for (const scenario of scenarios) {
  let app, page
  const directory = path.join(root, scenario)
  try {
    const launched = await launch(directory, scenario)
    ;({ app, page } = launched)
    const value = fixture(scenario === 'single' ? 1 : 2)
    const historyHashes = value.state.teams.map((team) => sha(team.messages.filter((m) => m.id.startsWith('history-'))))
    const runs = value.state.teams.map((team) => ({ id: `run-${team.id}`, workspaceId: team.id, revision: 1, status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z', permissions: [], contextTrimmed: false,
      replies: [{ id: `reply-${team.id}`, employeeId: team.members[0].id, provider: 'grok', model: 'offline-fixture', text: '流式验收起点', status: 'running' }] }))
    await app.evaluate(({ ipcMain }, runs) => {
      globalThis.__streamRuns = new Map(runs.map((run) => [run.id, run]))
      globalThis.__streamCalls = 0
      ipcMain.removeHandler('workspace:run')
      ipcMain.handle('workspace:run', (_event, id) => {
        const run = globalThis.__streamRuns.get(id)
        if (!run) throw Error('Unexpected fixture runtime ID')
        globalThis.__streamCalls++; return run
      })
    }, runs)
    await seedWorkspace(page, value)
    await page.getByText('流式验收起点', { exact: true }).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await instrument(page)
    await app.evaluate(() => {
      globalThis.__streamStarted = Date.now(); globalThis.__streamTick = 0
      globalThis.__streamTimer = setInterval(() => {
        globalThis.__streamTick++
        for (const run of globalThis.__streamRuns.values()) {
          run.revision++; run.replies[0].text += `\nLocal chunk ${globalThis.__streamTick}: offline streaming verification.`
        }
      }, 100)
    })
    const started = performance.now(), typeDurations = [], switches = [], expectedDrafts = {}
    let step = 0
    while (performance.now() - started < seconds * 1000) {
      const team = value.state.teams[Math.floor(step / 3) % value.state.teams.length]
      if (step % 3 === 0) {
        const switched = performance.now()
        await page.locator('.sidebar-team-main').filter({ hasText: team.name }).click()
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        switches.push(performance.now() - switched)
      }
      const text = `[${step}] `
      await page.getByRole('textbox', { name: '对话消息', exact: true }).press('Control+End')
      const typed = performance.now()
      await page.getByRole('textbox', { name: '对话消息', exact: true }).pressSequentially(text)
      typeDurations.push(performance.now() - typed)
      expectedDrafts[team.id] = (expectedDrafts[team.id] || '') + text
      step++
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + step * 700 - performance.now())))
    }
    const runtime = await app.evaluate(() => {
      clearInterval(globalThis.__streamTimer)
      for (const run of globalThis.__streamRuns.values()) {
        run.revision++; run.status = 'completed'; run.replies[0].status = 'completed'
      }
      return { elapsedMs: Date.now() - globalThis.__streamStarted, ticks: globalThis.__streamTick, calls: globalThis.__streamCalls,
        finals: Array.from(globalThis.__streamRuns.values()).map((run) => ({ teamId: run.workspaceId, text: run.replies[0].text })) }
    })
    await waitForWorkspace(page, (saved) => saved?.state.teams.every((team) => team.messages.some((message) => message.runtimeReplyId === `reply-${team.id}` && message.status === 'completed')),
      { timeout: 20000, label: 'terminal streamed replies are strictly committed' })
    const raw = await stopInstrumentation(page)
    const saved = await readWorkspace(page)
    for (const [index, team] of saved.state.teams.entries()) {
      assert.equal(sha(team.messages.filter((m) => m.id.startsWith('history-'))), historyHashes[index])
      assert.equal(team.messages.find((m) => m.runtimeReplyId === `reply-${team.id}`).text, runtime.finals.find((r) => r.teamId === team.id).text)
      assert.equal(saved.state.drafts[team.id], expectedDrafts[team.id])
    }
    assert.ok(runtime.elapsedMs >= 30000 && runtime.ticks >= 250)
    assert.ok(raw.transactions.every((tx) => tx.duration !== null && !tx.aborted), 'all measured writes must commit')
    record(`${scenario}: streaming, concurrent typing and final snapshot preserve history and drafts`, true)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot({ path: path.join(directory, 'completed.png') })
    const before = sha(saved)
    const closeStarted = performance.now()
    await app.close(); app = undefined
    const closeMs = performance.now() - closeStarted
    const reopened = await launch(directory, `${scenario}-restart`)
    ;({ app, page } = reopened)
    assert.equal(sha(await readWorkspace(page)), before)
    record(`${scenario}: graceful close and restart preserve the complete persisted snapshot`, true)
    measurements.push({ scenario, version: launched.metadata.version, electron: launched.metadata.electron, packaged: launched.metadata.packaged,
      fixtureHistoryMiB: 12, activeRuns: runs.length, durationMs: runtime.elapsedMs, chunksPerRun: runtime.ticks, runtimeReads: runtime.calls,
      typeBatchMs: summarize(typeDurations), switchToPaintMs: summarize(switches), inputEventToAnimationFrameMs: summarize(raw.inputPaint),
      longTasksMs: summarize(raw.longTasks), transactionMs: summarize(raw.transactions.map((tx) => tx.duration)), closeMs: round(closeMs),
      writes: Object.fromEntries(Object.entries(raw.byKind).map(([kind, metrics]) => [kind, { records: metrics.records, logicalJsonBytes: metrics.bytes, nativePutMs: summarize(metrics.nativePutMs) }])),
      finalSnapshotSha256: before, historyHashes, draftHashes: Object.fromEntries(Object.entries(expectedDrafts).map(([id, text]) => [id, sha(text)])) })
    console.log(JSON.stringify(measurements.at(-1), null, 2))
  } catch (error) { record(`${scenario}: harness`, false, { error: error.stack }) }
  finally { if (app) await app.close().catch((error) => record(`${scenario}: close`, false, { error: error.message })) }
}
record('renderer has no uncaught errors', rendererErrors.length === 0, { count: rendererErrors.length })
const report = { ok: results.every((entry) => entry.ok), generatedAt: new Date().toISOString(), modelRequests: 0,
  executablePath, measurements, results, rendererErrors,
  byteMetric: 'UTF-8 JSON payload bytes submitted to native IDB put, encoded after the measured interval; not physical disk writes.' }
const reportFile = path.join(root, 'results.json')
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ok: report.ok, reportFile, passed: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length }, null, 2))
process.exitCode = report.ok ? 0 : 1
