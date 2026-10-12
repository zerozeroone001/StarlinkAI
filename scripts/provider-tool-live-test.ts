import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createRuntime } from '../src/main/runtime/service'
import { providers, rpcFor } from '../src/main/runtime/providers'
import { execute } from '../src/main/runtime/adapters'
import { createRunJournal } from '../src/main/runtime/run-journal'
import { safeError, cliOutput, claudeEntry, geminiAccount } from '../src/main/runtime/cli'
import { readSubscriptionAuth } from '../src/main/auth'
import { isAccountAuthorized } from '../src/shared/provider-account'
import type { ProviderId } from '../src/shared/types'
import type { RunPermission, RunRequest, RunSnapshot } from '../src/shared/runtime'
import { fixtureFiles, validTarget, verifyFixtureFiles, isNodeTestCommand, classifyPermission, oneTimeApproval } from './provider-tool-live-policy'
import { createToolEvidence } from './provider-tool-live-evidence'

const live = process.argv.includes('--live')
const selfTest = process.argv.includes('--self-test')
if (!live && !selfTest) throw new Error('Explicit --live or --self-test is required')
const selected = process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] || 'all'
if (!['all', 'codex', 'gemini'].includes(selected)) throw new Error('Supported selections: codex, gemini, all')
const ids: ProviderId[] = selected === 'all' ? ['codex', 'gemini'] : [selected as ProviderId]
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-provider-tools-live-'))
const runSalt = randomUUID()
const startedAt = new Date().toISOString()
const outputRoot = path.resolve('.tmp', 'commercial-iteration')
fs.mkdirSync(outputRoot, { recursive: true })
const reportFile = path.join(outputRoot, `provider-tools-live-${startedAt.replace(/[:.]/g, '-')}-${runSalt.slice(0, 8)}.json`)
const sanitize = (error: unknown) => {
  let value = safeError(error)
  for (const [original, replacement] of [[root, '[test workspace]'], [os.homedir(), '[home]'], [process.cwd(), '[project]']]) {
    let escaped = original
    for (let level = 0; level < 4; level++) {
      value = value.split(escaped).join(replacement)
      escaped = JSON.stringify(escaped).slice(1, -1)
    }
  }
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
    .replace(/[A-Z]:\\+Users\\+[^\\/"'\s]+/gi, '[home]')
}
const safeDetail = (value: string) => {
  try { return JSON.stringify(JSON.parse(value), (_key, item) => typeof item === 'string' ? sanitize(item) : item).slice(0, 1800) }
  catch { return sanitize(value) }
}
const results: any[] = []
const report: any = { schemaVersion: 1, startedAt, providers: results, cleanupErrors: [],
  cancellationCoverage: 'Only terminal-run cancel idempotency; active cancellation would interrupt the single allowed task and is not claimed.' }
const persist = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
const calls = new Map<ProviderId, number>()
const receipts = new Map<ProviderId, any[]>()
const toolEvidence = new Map<ProviderId, ReturnType<typeof createToolEvidence>>()
let runtime: ReturnType<typeof createRuntime> | undefined
let failed = false

function boundedDirectory(_id: string, directory?: string) {
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(root)) throw new Error('Invalid acceptance directory')
  return directory
}
function captureEvidence(id: ProviderId, cwd: string, result: any) {
  const trace = receipts.get(id) || []
  const commands = trace.flatMap((receipt) => receipt.commands || [])
  const events = toolEvidence.get(id)?.snapshot() || []
  const nodeCommandReceipt = commands.some((entry) => isNodeTestCommand(entry.command) && (entry.exitCode === undefined || entry.exitCode === 0))
  Object.assign(result, {
    runtimeCommandReceiptPresent: nodeCommandReceipt,
    providerNodeToolCompleted: nodeCommandReceipt || events.some((entry) => entry.status === 'completed' && entry.kind === 'execute' && isNodeTestCommand(entry.title) && entry.nodeOutputMarker),
    officialToolEvents: events,
    modifiedFiles: [...new Set(trace.flatMap((receipt) => receipt.filesModified || []).map((file) => sanitize(path.relative(cwd, file).replace(/\\/g, '/'))))],
    commands: commands.map((entry) => ({ command: sanitize(entry.command), exitCode: entry.exitCode ?? null })),
    files: Object.keys(fixtureFiles).map((name) => {
      const file = path.join(cwd, name)
      try {
        if (!validTarget(cwd, file)) return { name, state: 'unsafe' }
        if (!fs.existsSync(file)) return { name, state: 'absent' }
        const size = fs.statSync(file).size
        if (size > 16384) return { name, state: 'oversize', size }
        return { name, state: 'present', size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
      } catch (error) { return { name, state: 'unreadable', error: sanitize(error) } }
    })
  })
  persist()
}
function makeRuntime(recovery = false) {
  return createRuntime({ providers, directory: boundedDirectory, skills: () => [],
    journal: createRunJournal(path.join(root, 'journal')), executionMs: 150000, permissionMs: 30000,
    execute: async (input) => {
      const id = input.employee.provider
      if (recovery || (calls.get(id) || 0) >= 1) throw new Error('A second provider task is not authorized for this acceptance run')
      calls.set(id, 1)
      const result = results.find((entry) => entry.id === id)
      const observer = createToolEvidence(sanitize)
      toolEvidence.set(id, observer)
      await execute({ ...input, receipt: (receipt) => {
        receipts.set(id, [...(receipts.get(id) || []), structuredClone(receipt)])
        input.receipt?.(receipt)
        captureEvidence(id, input.cwd, result)
      } }, { query, cliOutput, claudeEntry, geminiAccount, readSubscriptionAuth,
        rpcFor: async (...args) => {
          const connection = await rpcFor(...args)
          connection.rpc.on('request', (message: any) => {
            if (message.method === 'session/request_permission' && observer.observe(message.params?.toolCall, true))
              captureEvidence(id, input.cwd, result)
          })
          connection.rpc.on('notification', (message: any) => {
            const update = message.method === 'session/update' ? message.params?.update : undefined
            if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && observer.observe(update))
              captureEvidence(id, input.cwd, result)
          })
          return connection
        }
      })
    }
  })
}
function runPolicyChecks() {
  const cwd = path.join(root, 'policy')
  fs.mkdirSync(cwd)
  const permission = (detail: unknown, title = 'write_file'): RunPermission => ({ id: 'probe', employeeId: 'probe', title,
    detail: JSON.stringify(detail), options: [{ id: 'accept', label: '允许本次' }] })
  assert.equal(validTarget(cwd, '../sum.mjs'), false)
  assert.equal(validTarget(cwd, path.join(root, 'other', 'sum.mjs')), false)
  assert.equal(classifyPermission(permission({ file_path: path.join(cwd, 'sum.mjs') }), cwd).allowed, true)
  const acpDiff = { kind: 'edit', toolCallId: 'write_file_fixture', content: [{ type: 'diff', path: path.join(cwd, 'sum.mjs'), oldText: '', newText: fixtureFiles['sum.mjs'] }], locations: [{ path: path.join(cwd, 'sum.mjs') }] }
  assert.equal(classifyPermission(permission(acpDiff, 'Writing to sum.mjs'), cwd).allowed, true)
  assert.equal(classifyPermission(permission({ ...acpDiff, locations: [{ path: path.join(root, 'outside') }] }), cwd).allowed, false)
  assert.equal(classifyPermission(permission({ command: 'node sum.test.mjs', cwd }), cwd).allowed, false)
  for (const [name, content] of Object.entries(fixtureFiles)) fs.writeFileSync(path.join(cwd, name), content)
  assert.equal(classifyPermission(permission({ command: 'node sum.test.mjs', cwd }), cwd).allowed, true)
  const acpCommand = { kind: 'execute', title: 'node sum.test.mjs', content: [{ type: 'content', content: { type: 'text', text: `[current working directory ${cwd}] (Run local fixture)` } }], locations: [] }
  assert.equal(classifyPermission(permission(acpCommand, 'node sum.test.mjs'), cwd).allowed, true)
  assert.equal(classifyPermission(permission({ ...acpCommand, title: 'node sum.test.mjs; whoami' }), cwd).allowed, false)
  assert.equal(classifyPermission(permission({ ...acpCommand, content: [{ type: 'content', content: { type: 'text', text: `[in ${root}]` } }] }), cwd).allowed, false)
  assert.equal(classifyPermission(permission({ command: 'node sum.test.mjs', cwd: root }), cwd).allowed, false)
  for (const command of ['node sum.test.mjs; whoami', 'node -e "process.exit()"', 'npm install', 'node ../sum.test.mjs', 'node sum.test.mjs > ../outside.txt'])
    assert.equal(isNodeTestCommand(command), false)
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (process.platform === 'win32' && fs.existsSync(shell)) {
    assert.equal(isNodeTestCommand(`"${shell}" -Command 'node sum.test.mjs'`), true)
    assert.equal(isNodeTestCommand(`"${shell}" -Command 'node sum.test.mjs; whoami'`), false)
    assert.equal(isNodeTestCommand(`"${shell}" -EncodedCommand 'bm9kZQ=='`), false)
  }
  assert.equal(isNodeTestCommand(`"${path.join(cwd, 'pwsh.exe')}" -Command 'node sum.test.mjs'`), false)
  fs.appendFileSync(path.join(cwd, 'sum.test.mjs'), '\nprocess.exit(0)\n')
  assert.equal(classifyPermission(permission({ command: 'node sum.test.mjs', cwd }), cwd).allowed, false)
  assert.equal(oneTimeApproval({ ...permission({}), options: [{ id: 'allow_always', label: 'Always allow' }] }), undefined)
  assert.equal(oneTimeApproval({ ...permission({}), options: [{ id: 'proceed_once', label: 'Allow' }, { id: 'cancel', label: 'Reject' }] })?.id, 'proceed_once')
  fs.writeFileSync(path.join(cwd, 'sum.test.mjs'), fixtureFiles['sum.test.mjs'])
  verifyFixtureFiles(cwd)
  const observer = createToolEvidence(sanitize)
  observer.observe({ toolCallId: 'delta', title: 'node sum.test.mjs', kind: 'execute', rawInput: { command: 'node sum.test.mjs' }, status: 'pending' }, true)
  observer.observe({ toolCallId: 'delta', status: 'completed', rawInput: null, content: [{ type: 'content', content: { type: 'text', text: 'LOCAL_NODE_OK' } }] })
  assert.deepEqual(observer.snapshot().map(({ title, kind, status, hasRawInput, nodeOutputMarker, permissionObserved }) =>
    ({ title, kind, status, hasRawInput, nodeOutputMarker, permissionObserved })), [{ title: 'node sum.test.mjs', kind: 'execute', status: 'completed', hasRawInput: true, nodeOutputMarker: true, permissionObserved: true }])
  const evidence: any = { id: 'gemini', status: 'running' }
  results.push(evidence)
  toolEvidence.set('gemini', observer)
  captureEvidence('gemini', cwd, evidence)
  try { assert.fail('synthetic failure after evidence capture') } catch {}
  const persistedEvidence = JSON.parse(fs.readFileSync(reportFile, 'utf8')).providers[0]
  assert.equal(persistedEvidence.officialToolEvents[0].nodeOutputMarker, true)
  assert.equal(persistedEvidence.files.length, 2)
  assert.ok(persistedEvidence.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256)))
  results.pop()
  toolEvidence.clear()
  console.log('PASS isolated approval policy: exact files, safe generated code, one Node command, no persistent grants')
  console.log('PASS incremental tool evidence and file hashes persist before assertion failures')
}

try {
  if (selfTest) {
    runPolicyChecks()
  } else {
    const catalog = await providers(true, ids)
    runtime = makeRuntime()
    const saved: { request: RunRequest; snapshot: RunSnapshot; result: any }[] = []
    for (const provider of catalog) {
      const result: any = { id: provider.id, cli: provider.cli.state, signedIn: provider.auth.signedIn,
        modelCount: provider.models.length, permissions: [] }
      results.push(result)
      if (provider.cli.state !== 'installed' || !isAccountAuthorized(provider.auth, provider.usage) || !provider.models.length) {
        Object.assign(result, { status: 'skipped', reason: provider.cli.state !== 'installed' ? 'client_not_available' :
          !isAccountAuthorized(provider.auth, provider.usage) ? 'account_not_authorized' : 'model_catalog_empty', adapterInvocations: 0,
          ...(provider.error ? { diagnostic: sanitize(provider.error) } : {}) })
        console.log(JSON.stringify(result)); persist(); continue
      }
      const model = provider.models.find((entry) => entry.isDefault) || provider.models[0]
      const effort = ['none', 'minimal', 'low', 'medium'].find((entry) => model.efforts.includes(entry)) || model.defaultEffort
      const cwd = path.join(root, provider.id)
      fs.mkdirSync(cwd)
      const id = `provider-tools-${provider.id}-${runSalt}`
      const prompt = `Perform this small coding acceptance task inside the current working directory only. Do not read any other directory, configuration or account file. Do not install packages, use the network, send messages, or invoke skills/subagents.\nUse native file-edit tools (apply_patch/write_file), not shell commands, to create exactly these two files. Preserve their code exactly; harmless formatting is fine.\n${Object.entries(fixtureFiles).map(([name, content]) => `${name}:\n\`\`\`js\n${content}\`\`\``).join('\n\n')}\nThen use the shell tool to execute exactly: node sum.test.mjs\nUse the current working directory; do not wrap the command in cd, scripts, pipes, redirection, installers or extra shell commands. This is the only shell command authorized for this task. Do not retry the task after a failure. When the actual command prints LOCAL_NODE_OK, reply TOOL_ACCEPTANCE_OK. Never claim success without actually writing both files and running the command.`
      const request: RunRequest = { id, workspaceId: id, directory: cwd, permissionMode: 'ask',
        goal: 'Verify scoped native file tools and Node execution with manual permission handling.', prompt,
        employees: [{ id: 'tool-checker', name: 'Tool checker', provider: provider.id, model: model.id,
          ...(effort ? { effort } : {}), role: 'Implement and validate only the exact small local task.',
          persona: 'Follow the bounded file and command scope. Use native tools without unrelated operations.' }],
        context: [], artifacts: [] }
      Object.assign(result, { status: 'running', model: model.id, effort: effort || null })
      console.log(JSON.stringify({ id: provider.id, status: 'running', model: model.id })); persist()
      const started = performance.now()
      try {
        let snapshot = await runtime.api.start(request)
        const deadline = Date.now() + 210000
        const handled = new Set<string>()
        while (['queued', 'running', 'needs_permission'].includes(snapshot.status)) {
          if (Date.now() > deadline) throw new Error('Online tool acceptance timed out')
          for (const permission of snapshot.permissions) {
            if (handled.has(permission.id)) continue
            handled.add(permission.id)
            const decision = classifyPermission(permission, cwd)
            const allow = oneTimeApproval(permission)
            const approved = decision.allowed && !!allow
            result.permissions.push({ category: decision.category, approved, title: sanitize(permission.title),
              ...(approved ? { option: allow!.id } : { detail: safeDetail(permission.detail) }) })
            console.log(JSON.stringify({ id: provider.id, permission: decision.category, approved }))
            persist()
            if (!approved) throw new Error(`Cancelled unexpected or unbounded permission request: ${decision.category}`)
            await runtime.api.permission(id, permission.id, allow!.id)
          }
          await new Promise((resolve) => setTimeout(resolve, 200))
          snapshot = await runtime.api.run(id)
        }
        const history = snapshot.permissionHistory || []
        Object.assign(result, { runtimeStatus: snapshot.status, finalMarkerPresent: snapshot.replies.some((reply) => reply.text.includes('TOOL_ACCEPTANCE_OK')),
          permissionReceiptCount: history.length, answeredPermissionReceiptCount: history.filter((entry) => entry.status === 'answered' && !!entry.resolvedAt).length })
        captureEvidence(provider.id, cwd, result)
        if (snapshot.status !== 'completed') throw new Error(snapshot.error || `Runtime ended ${snapshot.status}`)
        verifyFixtureFiles(cwd)
        result.fixtureVerified = true
        persist()
        const local = execFileSync(process.execPath, ['sum.test.mjs'], { cwd, windowsHide: true, encoding: 'utf8', timeout: 10000 })
        result.independentNodeCheck = local.includes('LOCAL_NODE_OK')
        persist()
        assert.match(local, /LOCAL_NODE_OK/)
        assert.ok(result.providerNodeToolCompleted, 'The provider did not emit a completed Node test tool receipt')
        assert.ok(result.finalMarkerPresent, 'The actual completion marker is absent')
        assert.equal(history.length, result.permissions.length, 'Permission receipt count differs from approvals')
        assert.ok(history.every((entry) => entry.status === 'answered' && !!entry.resolvedAt))
        Object.assign(result, { status: 'passed', runtimeStatus: snapshot.status,
          adapterInvocations: calls.get(provider.id) || 0, durationMs: Math.round(performance.now() - started),
          permissionReceiptsVerified: true })
        saved.push({ request, snapshot, result })
      } catch (error) {
        failed = true
        await runtime.api.cancel(id).catch(() => {})
        Object.assign(result, { status: 'failed', error: sanitize(error), adapterInvocations: calls.get(provider.id) || 0,
          durationMs: Math.round(performance.now() - started) })
      } finally {
        captureEvidence(provider.id, cwd, result)
      }
      console.log(JSON.stringify(result)); persist()
    }
    await runtime.close()
    runtime = makeRuntime(true)
    for (const { request, snapshot, result } of saved) {
      try {
        const restored = await runtime.api.run(request.id)
        const duplicate = await runtime.api.start(request)
        const cancelled = await runtime.api.cancel(request.id)
        // The journal is JSON: absent optional fields and explicit undefined
        // are semantically identical (Gemini has no configured effort value).
        assert.deepEqual(restored.replies, JSON.parse(JSON.stringify(snapshot.replies)))
        assert.deepEqual(restored.permissionHistory, JSON.parse(JSON.stringify(snapshot.permissionHistory)))
        assert.equal(duplicate.status, 'completed')
        assert.equal(cancelled.status, 'completed')
        assert.equal(calls.get(result.id), 1)
        result.recovery = { completedRecordRestored: true, replyAndPermissionReceiptsPreserved: true,
          duplicateStartDidNotExecute: true, cancelCompletedRunWasIdempotent: true }
        console.log(JSON.stringify({ id: result.id, recovery: result.recovery }))
      } catch (error) { failed = true; result.status = 'failed'; result.recoveryError = sanitize(error) }
      persist()
    }
  }
} catch (error) {
  failed = true; report.error = sanitize(error); console.error(JSON.stringify({ error: report.error }))
} finally {
  try { await runtime?.close() } catch (error) { failed = true; report.cleanupErrors.push(sanitize(error)) }
  try {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('grok-provider-tools-live-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  } catch (error) { failed = true; report.cleanupErrors.push(sanitize(error)) }
  report.finishedAt = new Date().toISOString()
  report.summary = { passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    adapterInvocations: [...calls.values()].reduce((sum, count) => sum + count, 0), selfTest }
  persist()
  console.log(JSON.stringify({ summary: report.summary, report: path.relative(process.cwd(), reportFile) }))
  process.exitCode = failed ? 1 : 0
}
