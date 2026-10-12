import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/main/runtime/service'
import { providers } from '../src/main/runtime/providers'
import { execute } from '../src/main/runtime/adapters'
import { createRunJournal } from '../src/main/runtime/run-journal'
import { safeError } from '../src/main/runtime/cli'
import { grokHome } from '../src/main/paths'
import { isAccountAuthorized } from '../src/shared/provider-account'
import type { RuntimeModel, RuntimeProvider } from '../src/shared/runtime'
import type { ProviderId } from '../src/shared/types'

const live = process.argv.includes('--live')
if (!live && !process.argv.includes('--inspect-only')) throw new Error('Explicit --live or --inspect-only is required')
const id = randomUUID()
const startedAt = new Date().toISOString()
const outputRoot = path.resolve('.tmp', 'commercial-iteration')
fs.mkdirSync(outputRoot, { recursive: true })
const reportFile = path.join(outputRoot, `provider-live-${startedAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.json`)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-provider-live-'))
const marker = 'PROVIDER_ACCEPTANCE_OK'
const sanitize = (error: unknown) => safeError(error)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
  .split(os.homedir()).join('[home]')
  .split(root).join('[test workspace]')
  .split(process.cwd()).join('[project]')
const checks: Record<string, unknown>[] = []
const report: Record<string, unknown> = {
  schemaVersion: 1, startedAt, mode: live ? 'live' : 'inspect-only', marker,
  scope: 'One text-only runtime invocation per ready provider; no login or authentication fallback.',
  providers: checks, cleanupErrors: []
}
const persist = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
const sessionsRoot = path.resolve(grokHome(), 'sessions')
const ownSessions: string[] = []
let runtime: ReturnType<typeof createRuntime> | undefined
let failed = false
const calls = new Map<ProviderId, number>()
const permissionRequests = new Map<ProviderId, number>()

function lowestEffort(model: RuntimeModel) {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .find((effort) => model.efforts.includes(effort)) || model.defaultEffort || model.efforts[0]
}
function skipReason(provider: RuntimeProvider) {
  if (provider.cli.state !== 'installed') return 'client_not_available'
  if (!isAccountAuthorized(provider.auth, provider.usage)) return 'account_not_authorized'
  if (!provider.models.length) return 'model_catalog_empty'
  return null
}

try {
  // Do not log RuntimeProvider objects: they contain account identity and paths.
  const catalog = await providers(true)
  for (const provider of catalog) {
    const check: Record<string, unknown> = {
      id: provider.id, cli: provider.cli.state, signedIn: provider.auth.signedIn,
      modelCount: provider.models.length
    }
    checks.push(check)
    console.log(JSON.stringify(check))
  }
  persist()
  runtime = createRuntime({
    providers, directory: (_workspace, directory) => {
      assert.ok(directory && path.dirname(path.resolve(directory)) === path.resolve(root))
      return directory
    },
    journal: createRunJournal(path.join(root, 'journal')),
    executionMs: 90000,
    execute: async (input) => {
      const provider = input.employee.provider
      if ((calls.get(provider) || 0) >= 1)
        throw new Error('Live acceptance permits only one adapter invocation per provider; automatic retry blocked.')
      calls.set(provider, 1)
      if (!input.conversationOnly) throw new Error('Live acceptance requires text-only conversation mode.')
      await execute({ ...input, permission: async () => {
        permissionRequests.set(provider, (permissionRequests.get(provider) || 0) + 1)
        throw new Error('Unexpected permission request in text-only acceptance; no action authorized.')
      } })
    }
  })
  for (const provider of catalog) {
    const check = checks.find((entry) => entry.id === provider.id)!
    const reason = skipReason(provider)
    if (!live || reason) {
      Object.assign(check, { status: 'skipped', reason: reason || 'inspect_only', modelCalls: 0,
        ...(provider.error ? { diagnostic: sanitize(provider.error) } : {}) })
      console.log(JSON.stringify({ id: provider.id, status: 'skipped', reason: check.reason }))
      persist()
      continue
    }
    const model = provider.models.find((entry) => entry.isDefault) || provider.models[0]
    const effort = lowestEffort(model)
    const cwd = path.join(root, provider.id)
    fs.mkdirSync(cwd)
    if (provider.id === 'grok') {
      const sessionDirectory = path.resolve(sessionsRoot, encodeURIComponent(cwd))
      assert.equal(path.dirname(sessionDirectory), sessionsRoot)
      assert.ok(!fs.existsSync(sessionDirectory), 'Refusing to claim a pre-existing session directory')
      ownSessions.push(sessionDirectory)
    }
    const runId = `provider-live-${provider.id}-${id}`
    const started = performance.now()
    Object.assign(check, { status: 'running', model: model.id, effort: effort || null })
    persist()
    try {
      let snapshot = await runtime.api.start({
        id: runId, workspaceId: runId, directory: cwd, interaction: 'conversation', permissionMode: 'ask',
        goal: 'Verify a single text-only reply without any tool or file operation.',
        prompt: `This is a text-only connection acceptance check. Do not use tools, commands, files, web, skills, or subagents. Reply with exactly ${marker} and no other user-visible text. Follow any host response-envelope requirement.`,
        employees: [{ id: 'acceptance-assistant', name: 'Acceptance assistant', provider: provider.id,
          model: model.id, ...(effort ? { effort } : {}), role: 'Return the requested acceptance marker.',
          persona: 'Be concise. Do not perform any external action.' }],
        context: [], artifacts: []
      })
      const deadline = Date.now() + 120000
      while (['queued', 'running', 'needs_permission'].includes(snapshot.status)) {
        if (snapshot.permissions.length || Date.now() >= deadline) {
          await runtime.api.cancel(runId)
          throw new Error(snapshot.permissions.length ? 'Unexpected permission request; cancelled.' : 'Live acceptance timed out; cancelled.')
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
        snapshot = await runtime.api.run(runId)
      }
      const replies = snapshot.replies.map((reply) => reply.text.trim())
      const markerReceived = replies.some((reply) => reply === marker)
      const cleanWorkspace = fs.readdirSync(cwd).length === 0
      const passed = snapshot.status === 'completed' && markerReceived && cleanWorkspace &&
        (calls.get(provider.id) || 0) === 1 && !(permissionRequests.get(provider.id) || 0)
      Object.assign(check, {
        status: passed ? 'passed' : 'failed', runtimeStatus: snapshot.status, markerReceived,
        workspaceUnchanged: cleanWorkspace, replyCount: replies.length,
        responseCharacters: replies.reduce((sum, reply) => sum + reply.length, 0),
        modelCalls: calls.get(provider.id) || 0,
        permissionRequests: permissionRequests.get(provider.id) || 0,
        durationMs: Math.round(performance.now() - started),
        ...(snapshot.error ? { error: sanitize(snapshot.error) } : {}),
        ...(!passed && !snapshot.error ? { error: 'Acceptance marker, terminal status, call count or no-file-change requirement was not met.' } : {})
      })
      if (!passed) failed = true
    } catch (error) {
      failed = true
      Object.assign(check, { status: 'failed', error: sanitize(error), modelCalls: calls.get(provider.id) || 0,
        durationMs: Math.round(performance.now() - started) })
      await runtime.api.cancel(runId).catch(() => {})
    }
    console.log(JSON.stringify(check))
    persist()
  }
} catch (error) {
  failed = true
  report.error = sanitize(error)
  console.error(JSON.stringify({ error: report.error }))
} finally {
  try { await runtime?.close() }
  catch (error) { failed = true; (report.cleanupErrors as string[]).push(sanitize(error)) }
  for (const session of ownSessions) {
    try {
      assert.equal(path.dirname(session), sessionsRoot)
      assert.equal(path.basename(session), encodeURIComponent(path.join(root, 'grok')))
      fs.rmSync(session, { recursive: true, force: true })
    } catch (error) { failed = true; (report.cleanupErrors as string[]).push(sanitize(error)) }
  }
  try {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('grok-provider-live-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  } catch (error) { failed = true; (report.cleanupErrors as string[]).push(sanitize(error)) }
  report.finishedAt = new Date().toISOString()
  report.summary = {
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
    totalModelCalls: [...calls.values()].reduce((sum, count) => sum + count, 0)
  }
  persist()
  console.log(JSON.stringify({ summary: report.summary, report: path.relative(process.cwd(), reportFile) }))
  process.exitCode = failed ? 1 : 0
}
