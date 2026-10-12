import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantSnapshot } from '../src/shared/assistant'
import { useAssistant } from '../src/renderer/src/stores/assistant'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import { createWorkspace, recoverTaskGraph } from '../src/renderer/src/lib/collaboration-data'
import { selectScheduledTask } from '../src/renderer/src/lib/task-scheduler'

function snapshot(scopeId: string, revision = 1): AssistantSnapshot {
  return { profile: { scopeId, name: scopeId, persona: '', addressing: '', style: 'balanced', updatedAt: '2026-01-01T00:00:00Z' },
    memories: [], commitments: [], revision }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny })
  return { promise, resolve, reject }
}

test('assistant requests stay scoped when project responses arrive in reverse order', async (t) => {
  const first = deferred<AssistantSnapshot>(), second = deferred<AssistantSnapshot>()
  t.mock.method(runtimeClient, 'assistant', (scopeId: string) => scopeId === 'project-first' ? first.promise : second.promise)
  const readFirst = useAssistant.getState().refresh('project-first')
  const readSecond = useAssistant.getState().refresh('project-second')
  second.resolve(snapshot('project-second'))
  await readSecond
  assert.equal(useAssistant.getState().snapshots['project-second'].profile.name, 'project-second')
  assert.equal(useAssistant.getState().loading['project-first'], true)
  first.resolve(snapshot('project-first'))
  await readFirst
  assert.equal(useAssistant.getState().snapshots['project-first'].profile.name, 'project-first')
  assert.equal(useAssistant.getState().snapshots['project-second'].profile.name, 'project-second')
})

test('an older refresh cannot overwrite a profile mutation that has already completed', async (t) => {
  const scopeId = 'project-revision', read = deferred<AssistantSnapshot>()
  t.mock.method(runtimeClient, 'assistant', () => read.promise)
  t.mock.method(runtimeClient, 'updateAssistant', async () => ({ ...snapshot(scopeId, 2), profile: { ...snapshot(scopeId).profile, name: 'New name' } }))
  const refreshing = useAssistant.getState().refresh(scopeId)
  await Promise.resolve()
  await useAssistant.getState().updateProfile(scopeId, { name: 'New name' })
  read.resolve(snapshot(scopeId, 1))
  await refreshing
  assert.equal(useAssistant.getState().snapshots[scopeId].profile.name, 'New name')
  assert.equal(useAssistant.getState().snapshots[scopeId].revision, 2)
})

test('project mutations execute in order and a failed delete retains the last saved memory', async (t) => {
  const scopeId = 'project-mutations', first = deferred<AssistantSnapshot>()
  const calls: string[] = []
  const memory = { id: 'memory', content: 'Keep this fact', kind: 'fact' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  t.mock.method(runtimeClient, 'saveMemory', () => { calls.push('save'); return first.promise })
  t.mock.method(runtimeClient, 'forgetMemory', async () => { calls.push('forget'); throw new Error('Disk unavailable') })
  const save = useAssistant.getState().saveMemory(scopeId, { content: memory.content, kind: 'fact' })
  const remove = useAssistant.getState().forgetMemory(scopeId, memory.id)
  await Promise.resolve()
  assert.deepEqual(calls, ['save'])
  assert.equal(useAssistant.getState().saving[scopeId], 2)
  first.resolve({ ...snapshot(scopeId), memories: [memory] })
  await Promise.all([save, remove])
  assert.deepEqual(calls, ['save', 'forget'])
  assert.equal(useAssistant.getState().saving[scopeId], 0)
  assert.match(useAssistant.getState().errors[scopeId]!, /Disk unavailable/)
  assert.deepEqual(useAssistant.getState().snapshots[scopeId].memories, [memory])
})

test('a response for the wrong project is rejected without populating either project cache', async (t) => {
  const scopeId = 'project-requested', foreignId = 'project-foreign'
  t.mock.method(runtimeClient, 'assistant', async () => snapshot(foreignId))
  assert.equal(await useAssistant.getState().refresh(scopeId), undefined)
  assert.equal(useAssistant.getState().snapshots[scopeId], undefined)
  assert.equal(useAssistant.getState().snapshots[foreignId], undefined)
  assert.match(useAssistant.getState().errors[scopeId]!, /项目不匹配/)
})

test('clearing an assistant waits for pending edits and cannot resurrect their memories', async (t) => {
  const scopeId = 'project-cleared', pendingSave = deferred<AssistantSnapshot>()
  const calls: string[] = []
  t.mock.method(runtimeClient, 'saveMemory', () => { calls.push('save'); return pendingSave.promise })
  t.mock.method(runtimeClient, 'clearAssistant', async () => { calls.push('clear'); return snapshot(scopeId, 2) })
  const save = useAssistant.getState().saveMemory(scopeId, { content: 'Temporary preference', kind: 'preference' })
  const clear = useAssistant.getState().clearScope(scopeId)
  await Promise.resolve()
  assert.deepEqual(calls, ['save'])
  pendingSave.resolve({ ...snapshot(scopeId), memories: [{ id: 'temporary', content: 'Temporary preference', kind: 'preference',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] })
  await Promise.all([save, clear])
  assert.deepEqual(calls, ['save', 'clear'])
  assert.equal(useAssistant.getState().snapshots[scopeId].revision, 2)
  assert.deepEqual(useAssistant.getState().snapshots[scopeId].memories, [])
})

test('scheduler reports full dependency graph errors rather than waiting for impossible acceptance', () => {
  const team = createWorkspace('conversation', 'grok')
  const task = (id: string, dependency: string | null) => ({ id, title: id, description: '', acceptance: '', dependency, owner: team.members[0].id, state: 'ready' as const })
  team.tasks = [{ ...task('A', 'B'), managedDependencies: ['B', 'C'] }, { ...task('B', null), state: 'done' }, task('C', 'A')]
  assert.match(selectScheduledTask(team, ['A', 'C']).error!, /循环/)
  const recovered = recoverTaskGraph(team)
  assert.match(selectScheduledTask(recovered, ['A', 'C']).error!, /编辑确认/)
  team.tasks[2].dependency = null
  const selection = selectScheduledTask(team, ['A', 'C'])
  assert.equal(selection.error, undefined)
  assert.equal(selection.task?.id, 'C')
})
