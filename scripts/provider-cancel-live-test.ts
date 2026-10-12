import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createRuntime } from '../src/main/runtime/service'
import { createRunJournal } from '../src/main/runtime/run-journal'
import { execute } from '../src/main/runtime/adapters'
import { providers, rpcFor } from '../src/main/runtime/providers'
import { safeError, cliOutput, claudeEntry, geminiAccount } from '../src/main/runtime/cli'
import { readSubscriptionAuth } from '../src/main/auth'
import { isAccountAuthorized } from '../src/shared/provider-account'
import type { ProviderId } from '../src/shared/types'
import type { RunPermission, RunRequest, RunSnapshot } from '../src/shared/runtime'
import { createToolEvidence } from './provider-tool-live-evidence'
import { fixtureName, fixtureLifetime, fixtureSource, verifyFixture, isCancelCommand, classifyCancelPermission, oneTimeApproval } from './provider-cancel-live-policy'

const selfTest = process.argv.includes('--self-test')
if (!selfTest && !process.argv.includes('--live')) throw new Error('Explicit --live or --self-test is required')
const selected = process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] || 'all'
if (!['all', 'codex', 'gemini'].includes(selected)) throw new Error('Select codex, gemini or all')
const ids: ProviderId[] = selected === 'all' ? ['codex', 'gemini'] : [selected as ProviderId]
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-provider-cancel-live-'))
const salt = randomUUID()
const startedAt = new Date().toISOString()
const output = path.resolve('.tmp', 'commercial-iteration')
fs.mkdirSync(output, { recursive: true })
const reportFile = path.join(output, `provider-cancel-live-${startedAt.replace(/[:.]/g, '-')}-${salt.slice(0, 8)}.json`)
const report: any = { schemaVersion: 1, startedAt, selfTest, providers: [], cleanupErrors: [],
  scope: 'One known foreground Node command per provider. Cancellation only after started marker and three actual heartbeat records.' }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const normalize = (value: any) => JSON.parse(JSON.stringify(value))
const sanitize = (value: unknown) => {
  let text = safeError(value)
  for (const [original, replacement] of [[root, '[test workspace]'], [os.homedir(), '[home]'], [process.cwd(), '[project]']]) {
    let escaped = original
    for (let level = 0; level < 4; level++) { text = text.split(escaped).join(replacement); escaped = JSON.stringify(escaped).slice(1, -1) }
  }
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
    .replace(/[A-Z]:\\+Users\\+[^\\/"'\s]+/gi, '[home]')
}
const persist = () => fs.writeFileSync(reportFile, JSON.stringify(report, (_key, value) => typeof value === 'string' ? sanitize(value) : value, 2), { mode: 0o600 })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
function alive(pid: unknown) {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false
  try { process.kill(pid as number, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
function fixtureEvidence(cwd: string, nonce: string) {
  const read = (name: string) => {
    const file = path.join(cwd, name)
    if (!fs.existsSync(file)) return undefined
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Unsafe or oversized fixture evidence')
    return fs.readFileSync(file, 'utf8')
  }
  const started = read('started.json')
  const marker = started ? JSON.parse(started) : undefined
  const heartbeat = read('heartbeat.log') || ''
  // Ignore an incomplete final append while the known process is active.
  const beats = heartbeat.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line))
  if (marker && (marker.nonce !== nonce || !Number.isInteger(marker.pid) || !Number.isFinite(marker.startedAt)))
    throw new Error('Unexpected fixture start marker')
  assert.ok(beats.every((beat, index) => beat.nonce === nonce && beat.sequence === index + 1 && Number.isFinite(beat.at)))
  const completed = read('completed.json')
  if (completed) assert.equal(JSON.parse(completed).nonce, nonce)
  return { marker, beats, completed: !!completed, heartbeatSha256: sha(heartbeat),
    files: [fixtureName, 'started.json', 'heartbeat.log', 'completed.json'].map((name) => {
      const value = read(name)
      return { name, present: value !== undefined, ...(value !== undefined ? { bytes: Buffer.byteLength(value), sha256: sha(value) } : {}) }
    }) }
}
function snapshotEvidence(snapshot: RunSnapshot) {
  return { status: snapshot.status, revision: snapshot.revision, pendingPermissions: snapshot.permissions.length,
    replies: snapshot.replies.map((reply) => ({ status: reply.status, characters: reply.text.length, textSha256: sha(reply.text) })),
    permissionHistory: (snapshot.permissionHistory || []).map((entry) => ({ status: entry.status, optionId: entry.optionId,
      resolved: !!entry.resolvedAt, detailSha256: sha(entry.detail) })) }
}

async function selfChecks() {
  const cwd = path.join(root, 'policy'); fs.mkdirSync(cwd)
  const source = fixtureSource('selftest', 1200); fs.writeFileSync(path.join(cwd, fixtureName), source)
  const permission = (data: any): RunPermission => ({ id: 'test', employeeId: 'test', title: 'node cancel-fixture.mjs',
    detail: JSON.stringify(data), options: [{ id: 'proceed_once', label: 'Allow' }, { id: 'cancel', label: 'Reject' }] })
  assert.equal(classifyCancelPermission(permission({ command: `node ${fixtureName}`, cwd }), cwd, source).allowed, true)
  assert.equal(oneTimeApproval(permission({}))?.id, 'proceed_once')
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (process.platform === 'win32' && fs.existsSync(shell))
    assert.equal(classifyCancelPermission(permission({ command: `"${shell}" -Command 'node ${fixtureName}'`, cwd }), cwd, source).allowed, true)
  const acp = { kind: 'execute', title: `node ${fixtureName}`, locations: [], content: [{ type: 'content', content: { type: 'text', text: `[current working directory ${cwd}] (Cancellation fixture)` } }] }
  assert.equal(classifyCancelPermission(permission(acp), cwd, source).allowed, true)
  assert.equal(classifyCancelPermission(permission({ ...acp, content: [{ type: 'content', content: { type: 'text', text: `[in ${root}]` } }] }), cwd, source).allowed, false)
  assert.equal(classifyCancelPermission(permission({ command: `node ${fixtureName}`, cwd: root }), cwd, source).allowed, false)
  for (const command of [`node ${fixtureName}; whoami`, `node ../${fixtureName}`, `node -e 'process.exit()'`, `npm install`, `node ${fixtureName} > x`, `node sum.test.mjs`])
    assert.equal(isCancelCommand(command), false)
  assert.equal(classifyCancelPermission(permission({ kind: 'edit', path: path.join(cwd, fixtureName) }), cwd, source).allowed, false)
  fs.appendFileSync(path.join(cwd, fixtureName), '\nprocess.exit(0)')
  assert.equal(classifyCancelPermission(permission({ command: `node ${fixtureName}`, cwd }), cwd, source).allowed, false)
  fs.writeFileSync(path.join(cwd, fixtureName), source)
  const child = spawn(process.execPath, [fixtureName], { cwd, windowsHide: true, stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await deadline((async () => { while (fixtureEvidence(cwd, 'selftest').beats.length < 2) await sleep(25) })(), 3000, 'Self-test heartbeat')
  assert.equal(alive(child.pid), true)
  child.kill(); await deadline(exited, 3000, 'Self-test Node stop')
  const stopped = fixtureEvidence(cwd, 'selftest')
  await sleep(1250)
  assert.equal(fixtureEvidence(cwd, 'selftest').heartbeatSha256, stopped.heartbeatSha256)
  assert.equal(fixtureEvidence(cwd, 'selftest').completed, false)
  assert.equal(alive(child.pid), false)
  const control = path.join(root, 'control'); fs.mkdirSync(control)
  fs.writeFileSync(path.join(control, fixtureName), fixtureSource('control', 1000))
  const natural = spawn(process.execPath, [fixtureName], { cwd: control, windowsHide: true, stdio: 'ignore' })
  await deadline(new Promise<void>((resolve) => natural.once('exit', () => resolve())), 3000, 'Positive control')
  assert.equal(fixtureEvidence(control, 'control').completed, true)
  assert.deepEqual(normalize({ effort: undefined, messages: [{ value: undefined, text: 'retained' }] }), { messages: [{ text: 'retained' }] })
  report.selfChecks = { exactCommandPolicy: true, officialWindowsAndAcpShapes: true, realHeartbeatStop: true,
    positiveNaturalCompletionControl: true, jsonNormalization: true }
  persist()
  assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')).selfChecks, report.selfChecks)
  console.log('PASS offline cancellation policy, real Node heartbeat/stop and natural completion controls, JSON normalization and evidence persistence')
}

const invocations = new Map<ProviderId, number>()
let failed = false
async function runProvider(provider: Awaited<ReturnType<typeof providers>>[number]) {
  const result: any = { id: provider.id, signedIn: provider.auth.signedIn, modelCount: provider.models.length, permissions: [], samples: [], toolEvents: [], cli: { state: provider.cli.state } }
  report.providers.push(result)
  if (provider.cli.state !== 'installed' || !isAccountAuthorized(provider.auth, provider.usage) || !provider.models.length) {
    Object.assign(result, { status: 'skipped', reason: provider.cli.state !== 'installed' ? 'client_not_available' : !isAccountAuthorized(provider.auth, provider.usage) ? 'account_not_authorized' : 'model_catalog_empty' })
    persist(); console.log(JSON.stringify({ id: provider.id, status: result.status, reason: result.reason })); return
  }
  const cwd = path.join(root, provider.id); fs.mkdirSync(cwd)
  const nonce = randomUUID(), source = fixtureSource(nonce)
  fs.writeFileSync(path.join(cwd, fixtureName), source, { flag: 'wx', mode: 0o600 })
  result.fixtureSha256 = sha(source)
  const model = provider.models.find((entry) => entry.isDefault) || provider.models[0]
  const effort = ['none', 'minimal', 'low', 'medium'].find((entry) => model.efforts.includes(entry)) || model.defaultEffort
  Object.assign(result, { model: model.id, effort: effort || null, status: 'running' })
  const id = `cancel-${provider.id}-${salt}`
  const request: RunRequest = { id, workspaceId: id, directory: cwd, permissionMode: 'ask',
    goal: 'Verify cancellation of one known local foreground command.',
    prompt: `Run exactly one shell command, once, in the current working directory: node ${fixtureName}\nThe test harness already placed this fully known Node fixture there. It writes only started.json, heartbeat.log and completed.json in this same isolated directory and exits after 10 seconds. Do not inspect, read, edit, create or delete any files yourself, do not install anything, use network, send messages, invoke skills or subagents. Do not use cd, wrappers, additional commands, pipes, redirection or background execution. Request permission normally. Briefly acknowledge CANCEL_TEST_STARTING before the command. The harness will cancel you while the command is running; do not retry after any interruption. If it finishes naturally, reply CANCEL_TEST_FINISHED.`,
    employees: [{ id: 'cancel-checker', name: 'Cancellation checker', provider: provider.id, model: model.id,
      ...(effort ? { effort } : {}), role: 'Execute the one specified foreground command.', persona: 'Follow the exact bounded scope; no extra operations.' }], context: [], artifacts: [] }
  const observer = createToolEvidence(sanitize)
  const connections: any[] = []
  let runtime: ReturnType<typeof createRuntime> | undefined
  let snapshot: RunSnapshot | undefined
  let beforeCancel: RunSnapshot | undefined
  let finalSnapshot: RunSnapshot | undefined
  const began = Date.now()
  const evidence = () => {
    const value = fixtureEvidence(cwd, nonce)
    result.files = value.files
    result.toolEvents = observer.snapshot()
    result.adapterInvocations = invocations.get(provider.id) || 0
    if (snapshot) result.snapshot = snapshotEvidence(snapshot)
    persist()
    return value
  }
  const makeRuntime = (recovery = false) => createRuntime({ providers, skills: () => [],
    directory: (_workspaceId, directory) => {
      if (!directory || path.resolve(directory) !== cwd) throw new Error('Outside isolated cancellation directory')
      return cwd
    }, journal: createRunJournal(path.join(root, `journal-${provider.id}`)), executionMs: 150000, permissionMs: 30000,
    execute: async (input) => {
      if (recovery || invocations.get(provider.id)) throw new Error('A repeated provider task is not authorized')
      invocations.set(provider.id, 1)
      try { await execute(input, { query, cliOutput, claudeEntry, geminiAccount, readSubscriptionAuth,
        rpcFor: async (...args) => {
          const connection = await rpcFor(...args)
          connections.push(connection)
          // Observe only the exact child owned by this RPC instance; no process
          // inventory, account files, account replies or stderr are collected.
          const child: ChildProcess = (connection.rpc as any).child
          if (!child?.pid) throw new Error('The provider child process cannot be observed')
          Object.assign(result.cli, { pid: child.pid, spawnedAt: Date.now() })
          child.once('exit', (code, signal) => { Object.assign(result.cli, { exitedAt: Date.now(), exitCode: code, signal }); persist() })
          connection.rpc.on('request', (message: any) => {
            if (message.method === 'session/request_permission' && observer.observe(message.params?.toolCall, true)) evidence()
          })
          connection.rpc.on('notification', (message: any) => {
            const update = message.method === 'session/update' ? message.params?.update : undefined
            if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && observer.observe(update)) evidence()
            const item = message.params?.item
            if (['item/started', 'item/completed'].includes(message.method) && item?.type === 'commandExecution') {
              result.nativeCommands ||= []
              result.nativeCommands.push({ event: message.method, command: sanitize(item.command || ''), status: item.status, exitCode: item.exitCode ?? null })
              persist()
            }
          })
          return connection
        }
      }) } finally { result.adapterSettledAt = Date.now(); persist() }
    }
  })
  try {
    runtime = makeRuntime(); snapshot = await runtime.api.start(request)
    console.log(JSON.stringify({ id: provider.id, status: 'running', model: model.id })); persist()
    const seenPermissions = new Set<string>()
    const startDeadline = Date.now() + 150000
    while (true) {
      if (Date.now() > startDeadline) throw new Error('The known command did not start before the acceptance deadline')
      for (const permission of snapshot.permissions) {
        if (seenPermissions.has(permission.id)) continue
        seenPermissions.add(permission.id)
        const decision = classifyCancelPermission(permission, cwd, source)
        const option = oneTimeApproval(permission)
        const approved = seenPermissions.size === 1 && decision.allowed && !!option
        result.permissions.push({ approved, reason: decision.reason, title: sanitize(permission.title), option: approved ? option!.id : null,
          detail: sanitize(permission.detail) })
        persist(); console.log(JSON.stringify({ id: provider.id, permissionApproved: approved, reason: decision.reason }))
        if (!approved) throw new Error(`Unexpected permission: ${decision.reason}; only one exact command is authorized`)
        await runtime.api.permission(id, permission.id, option!.id)
      }
      const value = evidence()
      if (value.marker && value.beats.length >= 3) {
        snapshot = await runtime.api.run(id)
        assert.equal(snapshot.status, 'running', 'Must cancel a running execution')
        assert.equal(snapshot.permissions.length, 0, 'Must not cancel a pending approval')
        assert.equal(value.completed, false, 'Must not cancel an already completed command')
        assert.ok(alive(value.marker.pid), 'The real fixture child must be alive')
        assert.ok(value.beats.at(-1)!.at - value.beats[0].at >= 350, 'The heartbeat must genuinely advance')
        beforeCancel = snapshot
        result.beforeCancel = { ...snapshotEvidence(snapshot), fixturePid: value.marker.pid, fixtureStartedAt: value.marker.startedAt,
          heartbeatCount: value.beats.length, cliAlive: alive(result.cli.pid), nodeAlive: true }
        result.cancelRequestedAt = Date.now(); persist()
        snapshot = await runtime.api.cancel(id)
        result.cancelReturnedAt = Date.now(); evidence()
        const observationEnd = value.marker.startedAt + fixtureLifetime + 1100
        let steadyHash: string | undefined
        while (Date.now() < observationEnd) {
          await sleep(200)
          snapshot = await runtime.api.run(id)
          const current = evidence()
          const sample = { afterCancelMs: Date.now() - result.cancelRequestedAt, heartbeatCount: current.beats.length,
            heartbeatSha256: current.heartbeatSha256, completed: current.completed, nodeAlive: alive(value.marker.pid), cliAlive: alive(result.cli.pid), runtimeStatus: snapshot.status }
          result.samples.push(sample)
          if (sample.afterCancelMs >= 2000) {
            steadyHash ||= sample.heartbeatSha256
            if (sample.heartbeatSha256 !== steadyHash || sample.completed || sample.nodeAlive || sample.cliAlive)
              result.cancellationViolation ||= 'A provider or tool process remained alive, or emitted activity after the cancellation grace period'
          }
          persist()
        }
        evidence()
        assert.equal(result.cancellationViolation, undefined)
        assert.equal(fixtureEvidence(cwd, nonce).completed, false, 'No late natural completion marker may appear')
        assert.equal(alive(value.marker.pid), false)
        assert.equal(alive(result.cli.pid), false)
        assert.ok(result.cli.exitedAt, 'Provider CLI exit event must be observed')
        assert.ok(result.adapterSettledAt, 'Provider adapter must settle after cancellation')
        assert.equal(snapshot.status, 'cancelled')
        assert.ok(beforeCancel.replies.every((reply, index) => snapshot!.replies[index]?.text.startsWith(reply.text)), 'Pre-cancel reply text must survive')
        assert.deepEqual(normalize(snapshot.permissionHistory), normalize(beforeCancel.permissionHistory))
        assert.equal((snapshot.permissionHistory || []).filter((entry) => entry.status === 'answered').length, result.permissions.length)
        verifyFixture(cwd, source)
        finalSnapshot = snapshot
        Object.assign(result, { activeCancellationVerified: true, preCancelTextCharacters: beforeCancel.replies.reduce((sum, reply) => sum + reply.text.length, 0),
          priorReplyTextPreserved: true, approvalReceiptsPreserved: true, noLateCompletion: true,
          observationAfterCancelMs: Date.now() - result.cancelRequestedAt })
        persist()
        break
      }
      if (!['queued', 'running', 'needs_permission'].includes(snapshot.status)) throw new Error(`Execution ended ${snapshot.status} before active cancellation`)
      await sleep(100); snapshot = await runtime.api.run(id)
    }
    await deadline(runtime.close(), 10000, 'Runtime journal close')
    runtime = makeRuntime(true)
    const restored = await runtime.api.run(id)
    const duplicate = await runtime.api.start(request)
    const cancelledAgain = await runtime.api.cancel(id)
    result.recoveryObserved = { restored: snapshotEvidence(restored), duplicateStatus: duplicate.status, cancelAgainStatus: cancelledAgain.status }
    persist()
    assert.equal(restored.status, 'cancelled')
    assert.deepEqual(restored.replies, normalize(finalSnapshot!.replies))
    assert.deepEqual(restored.permissionHistory, normalize(finalSnapshot!.permissionHistory))
    assert.equal(duplicate.status, 'cancelled')
    assert.equal(cancelledAgain.status, 'cancelled')
    assert.equal(invocations.get(provider.id), 1)
    Object.assign(result, { status: 'passed', recovery: { terminalRestored: true, repliesAndApprovalsPreserved: true, duplicateStartDidNotExecute: true, repeatedCancelIdempotent: true } })
  } catch (error) {
    failed = true; Object.assign(result, { status: 'failed', error: sanitize(error) })
    try { snapshot = await runtime?.api.cancel(id) } catch (cancelError) { result.cancelError = sanitize(cancelError) }
  } finally {
    try { evidence() } catch (error) { result.evidenceError = sanitize(error); failed = true }
    result.durationMs = Date.now() - began; persist()
    try { await deadline(runtime?.close() || Promise.resolve(), 10000, 'Runtime cleanup') }
    catch (error) { failed = true; result.cleanupError = sanitize(error); for (const connection of connections) connection.rpc.close() }
    // A failed assertion must still retain any surviving fixture's full natural
    // lifetime. Never remove its directory while it may still be writing.
    try {
      const current = fixtureEvidence(cwd, nonce)
      if (current.marker && alive(current.marker.pid)) {
        while (Date.now() < current.marker.startedAt + fixtureLifetime + 1100) {
          await sleep(200)
          const observed = evidence()
          result.cleanupObservation = { completed: observed.completed, heartbeatCount: observed.beats.length,
            nodeAlive: alive(current.marker.pid), cliAlive: alive(result.cli.pid) }
          persist()
        }
        if (alive(current.marker.pid)) { result.orphanStillAlive = true; failed = true }
      }
    } catch (error) { result.cleanupEvidenceError = sanitize(error); failed = true }
    try { evidence() } catch (error) { result.evidenceError = sanitize(error) }
    persist(); console.log(JSON.stringify({ id: provider.id, status: result.status, durationMs: result.durationMs, error: result.error }))
  }
}

try {
  if (selfTest) await selfChecks()
  else for (const provider of await providers(true, ids)) await runProvider(provider)
} catch (error) { failed = true; report.error = sanitize(error); console.error(JSON.stringify({ error: report.error })) }
finally {
  persist()
  try {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('grok-provider-cancel-live-'))
    if (report.providers.some((result: any) => result.orphanStillAlive)) {
      report.temporaryDirectoryRemoved = false
      report.cleanupErrors.push('A fixture process remains alive; its isolated directory was retained without killing an unverified PID.')
    } else {
      fs.rmSync(resolved, { recursive: true, force: true })
      report.temporaryDirectoryRemoved = true
    }
  } catch (error) { failed = true; report.cleanupErrors.push(sanitize(error)) }
  report.finishedAt = new Date().toISOString()
  report.summary = { passed: report.providers.filter((item: any) => item.status === 'passed').length,
    failed: report.providers.filter((item: any) => item.status === 'failed').length,
    skipped: report.providers.filter((item: any) => item.status === 'skipped').length,
    adapterInvocations: [...invocations.values()].reduce((sum, value) => sum + value, 0), selfTest }
  persist(); console.log(JSON.stringify({ summary: report.summary, report: path.relative(process.cwd(), reportFile) }))
  process.exitCode = failed ? 1 : 0
}
