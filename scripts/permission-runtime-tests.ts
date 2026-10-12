import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import type { Execution } from '../src/main/runtime/adapters'
import type { RunRecord } from '../src/main/runtime/run-journal'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'

const employee = (id: string) => ({ id, name: id, provider: 'codex' as const, role: 'test', persona: '' })
const catalog = [{ id: 'codex', auth: { signedIn: true }, models: [{ id: 'test', name: 'Test', efforts: [], isDefault: true }] }] as RuntimeProvider[]
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({
  id: 'permission-run', workspaceId: 'permission-space', prompt: 'test permissions', goal: '',
  employees: [employee('worker')], context: [], artifacts: [], ...patch
})
function fixture(t: TestContext, execute: (input: Execution) => Promise<void>, extra: Record<string, unknown> = {}) {
  const runtime = createRuntime({ directory: () => process.cwd(), providers: async () => catalog, skills: () => [], execute, ...extra })
  t.after(() => runtime.close())
  return runtime
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('permission test did not settle')
}
async function terminal(runtime: ReturnType<typeof createRuntime>, id = 'permission-run') {
  await until(async () => !['running', 'queued', 'needs_permission'].includes((await runtime.api.run(id)).status))
  return runtime.api.run(id)
}

test('permission validation accepts only the three modes and the legacy missing value', async (t) => {
  for (const permissionMode of [undefined, 'ask', 'review', 'auto'] as const)
    assert.doesNotThrow(() => validateRequest(request({ permissionMode })))
  let executions = 0
  const runtime = fixture(t, async () => { executions++ })
  for (const permissionMode of ['', 'full', 'never', null, 0, true, [], ['review'], { mode: 'auto' }]) {
    const invalid = request({ permissionMode: permissionMode as never })
    assert.throws(() => validateRequest(invalid), /权限模式/)
    await assert.rejects(runtime.api.start(invalid), /权限模式/)
  }
  assert.equal(executions, 0)
})

test('missing permission mode defaults to ask in execution and persisted snapshots', async (t) => {
  const records: RunRecord[] = [], inputs: Execution[] = []
  const journal = { load: async () => null, save: async (record: RunRecord) => { records.push(structuredClone(record)) } }
  const runtime = fixture(t, async (input) => { inputs.push(input); input.text('completed') }, { journal })
  const started = await runtime.api.start(request())
  const completed = await terminal(runtime)
  assert.equal(started.permissionMode, 'ask')
  assert.equal(completed.permissionMode, 'ask')
  assert.equal(completed.status, 'completed', completed.error)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].permissionMode, 'ask')
  assert.ok(records.length > 0)
  assert.ok(records.every((record) => record.snapshot.permissionMode === 'ask'))
})

test('queued requests retain their submitted mode when caller state and returned snapshots change', async (t) => {
  const inputs: { id: string; mode: Execution['permissionMode'] }[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.after(release)
  const runtime = fixture(t, async (input) => {
    inputs.push({ id: input.employee.id, mode: input.permissionMode })
    if (input.employee.id === 'first') await gate
    input.text('completed')
  })
  await runtime.api.start(request({ id: 'first-run', permissionMode: 'ask', employees: [employee('first')] }))
  await until(async () => inputs.length === 1)
  const queuedRequest = request({ id: 'queued-run', permissionMode: 'review', queue: true, employees: [employee('second')] })
  const queued = await runtime.api.start(queuedRequest)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.permissionMode, 'review')
  queuedRequest.permissionMode = 'auto'
  queued.permissionMode = 'auto'
  assert.equal((await runtime.api.run('queued-run')).permissionMode, 'review')
  assert.equal((await runtime.api.run('first-run')).permissionMode, 'ask')
  release()
  const completed = await terminal(runtime, 'queued-run')
  assert.equal(completed.status, 'completed', completed.error)
  assert.equal(completed.permissionMode, 'review')
  assert.deepEqual(inputs, [{ id: 'first', mode: 'ask' }, { id: 'second', mode: 'review' }])
})

test('lead decisions and delegated worker executions share the original permission mode', async (t) => {
  for (const permissionMode of ['ask', 'review', 'auto'] as const) {
    let rounds = 0
    const inputs: { id: string; mode: Execution['permissionMode'] }[] = []
    const runtime = fixture(t, async (input) => {
      inputs.push({ id: input.employee.id, mode: input.permissionMode })
      if (input.employee.id === 'worker') { input.text('Worker delivery'); return }
      rounds++
      if (rounds === 1) input.text(JSON.stringify({ action: 'delegate', employeeId: 'worker', title: 'Work',
        description: 'Do the work', acceptance: 'Return the delivery', dependsOn: [], message: 'Delegating' }))
      else if (rounds === 2) {
        const snapshot = await runtime.api.run('permission-run')
        input.text(JSON.stringify({ action: 'review', taskId: snapshot.coordination!.tasks[0].id,
          accepted: true, evidence: 'Checked worker delivery', message: 'Accepted' }))
      } else input.text(JSON.stringify({ action: 'finish', message: 'Completed' }))
    })
    await runtime.api.start(request({ permissionMode, employees: [employee('lead'), employee('worker')], coordination: { leadId: 'lead' } }))
    const completed = await terminal(runtime)
    assert.equal(completed.status, 'completed', completed.error)
    assert.equal(completed.permissionMode, permissionMode)
    assert.equal(completed.coordination?.tasks[0].status, 'completed')
    assert.deepEqual(inputs, ['lead', 'worker', 'lead', 'lead'].map((id) => ({ id, mode: permissionMode })))
  }
})

test('review mode still waits for a provider permission callback instead of granting it automatically', async (t) => {
  let choice: string | undefined
  const runtime = fixture(t, async (input) => {
    assert.equal(input.permissionMode, 'review')
    choice = await input.permission('Fallback approval', '', [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }])
    input.text('Permission answered')
  })
  await runtime.api.start(request({ permissionMode: 'review' }))
  await until(async () => (await runtime.api.run('permission-run')).permissions.length === 1)
  const waiting = await runtime.api.run('permission-run')
  assert.equal(waiting.status, 'needs_permission')
  assert.equal(waiting.permissionMode, 'review')
  assert.equal(choice, undefined)
  await runtime.api.permission(waiting.id, waiting.permissions[0].id, 'deny')
  assert.equal((await terminal(runtime)).status, 'completed')
  assert.equal(choice, 'deny')
})

test('conversation requests keep the tool-free flag even with full-access workspace preferences', async (t) => {
  let executed = false
  const runtime = fixture(t, async (input) => {
    executed = true
    assert.equal(input.permissionMode, 'auto')
    assert.equal(input.conversationOnly, true)
    assert.deepEqual(input.skills, [])
    input.text(JSON.stringify({ action: 'finish', message: 'Conversation completed' }))
  })
  await runtime.api.start(request({ permissionMode: 'auto', interaction: 'conversation' }))
  const completed = await terminal(runtime)
  assert.equal(completed.status, 'completed', completed.error)
  assert.equal(executed, true)
  assert.equal(completed.permissionMode, 'auto')
})
