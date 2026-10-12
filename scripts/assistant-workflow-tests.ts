import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { useAssistant } from '../src/renderer/src/stores/assistant'
import { createWorkspace, isValidTeam, type Team } from '../src/renderer/src/lib/collaboration-data'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import { assistantScopeId, isStopWorkMessage } from '../src/renderer/src/lib/assistant-context'
import type { RunRequest, RunSnapshot } from '../src/shared/runtime'
import type { AssistantSnapshot } from '../src/shared/assistant'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })

function reset(teams: Team[]) {
  useCollaboration.setState({ teams, activeTeamId: teams[0].id, runs: {}, drafts: {}, attachmentDrafts: {},
    taskSchedules: {}, runtimeError: null, stoppingRuns: {}, connectionErrors: {} })
  useAssistant.setState({ snapshots: {}, errors: {}, saving: {}, loading: {} })
}

function reply(request: RunRequest, text = 'answer'): RunSnapshot {
  return { id: request.id, workspaceId: request.workspaceId, interaction: request.interaction,
    permissionMode: request.permissionMode,
    status: 'completed', revision: 1, createdAt: new Date().toISOString(), permissions: [], contextTrimmed: false,
    ...(request.coordination ? { coordination: { leadId: request.coordination.leadId, phase: 'completed', tasks: [] } } : {}),
    replies: [{ id: `${request.id}-reply-1`, employeeId: request.employees[0].id,
      provider: request.employees[0].provider, model: 'mock', text, status: 'completed' }] }
}

function mockRuns(t: TestContext, requests: RunRequest[]) {
  const oldStart = runtimeClient.start, oldRun = runtimeClient.run
  const snapshots = new Map<string, RunSnapshot>()
  runtimeClient.start = async (request) => { requests.push(request); const result = reply(request); snapshots.set(request.id, result); return result }
  runtimeClient.run = async (id) => snapshots.get(id)!
  t.after(() => { runtimeClient.start = oldStart; runtimeClient.run = oldRun })
}

test('workspace permissions persist independently and project children copy them only when created', () => {
  const project = createWorkspace('project', 'codex'), independent = createWorkspace('conversation', 'grok')
  reset([project, independent])
  assert.equal(project.permissionMode, 'ask')
  assert.equal(independent.permissionMode, 'ask')
  useCollaboration.getState().setPermissionMode(project.id, 'review')
  const childId = useCollaboration.getState().createWorkspace('conversation', 'Child', '', project.id)
  assert.equal(useCollaboration.getState().teams.find((team) => team.id === childId)?.permissionMode, 'review')
  useCollaboration.getState().setPermissionMode(project.id, 'auto')
  const current = useCollaboration.getState()
  assert.equal(current.teams.find((team) => team.id === childId)?.permissionMode, 'review')
  assert.equal(current.teams.find((team) => team.id === independent.id)?.permissionMode, 'ask')
  const options = useCollaboration.persist.getOptions()
  const saved = JSON.parse(JSON.stringify(options.partialize!(current)))
  const restored = options.merge!(saved, current) as typeof current
  assert.deepEqual(restored.teams.map((team) => team.permissionMode), ['auto', 'ask', 'review'])
  delete saved.teams[0].permissionMode
  const legacy = options.merge!(saved, current) as typeof current
  assert.equal(legacy.teams[0].permissionMode, 'ask')
  assert.equal(legacy.teams[0].id, project.id)
  for (const value of ['invalid', '', null, 1, ['review']])
    assert.equal(isValidTeam({ ...project, permissionMode: value }), false)
  useCollaboration.getState().setPermissionMode(independent.id, 'invalid' as never)
  assert.equal(useCollaboration.getState().teams.find((team) => team.id === independent.id)?.permissionMode, 'ask')
})

test('every workspace execution route sends its selected permission mode', async (t) => {
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  for (const mode of ['ask', 'review', 'auto'] as const) {
    for (const route of ['employee', 'lead', 'all', 'task', 'conversation'] as const) {
      const team = createWorkspace('conversation', 'codex')
      team.members.push({ ...team.members[0], id: 'worker', isLead: false })
      team.tasks.push({ id: 'task', title: 'Task', description: 'Execute task', acceptance: '', owner: 'worker', state: 'ready', dependency: null })
      reset([team])
      useCollaboration.getState().setPermissionMode(team.id, mode)
      if (route === 'task') await useCollaboration.getState().executeTask(team.id, 'task')
      else await useCollaboration.getState().send(team.id,
        route === 'employee' ? 'worker' : route === 'all' ? 'all' : team.members[0].id,
        undefined, undefined, 'Run this request', route === 'conversation' ? 'conversation' : undefined)
      const sent = requests.at(-1)!
      assert.equal(sent.workspaceId, team.id)
      assert.equal(sent.permissionMode, mode, `${route} must preserve ${mode}`)
      assert.equal(sent.interaction, route === 'conversation' ? 'conversation' : undefined)
      assert.equal(!!sent.coordination, route === 'lead')
    }
  }
  const legacy = createWorkspace('conversation', 'codex')
  delete legacy.permissionMode
  reset([legacy])
  await useCollaboration.getState().send(legacy.id, legacy.members[0].id, undefined, undefined, 'Legacy workspace')
  assert.equal(requests.at(-1)?.permissionMode, 'ask')
  assert.equal(requests.length, 16)
})

test('changing permissions during a run affects only later requests and retries', async (t) => {
  const team = createWorkspace('conversation', 'codex')
  team.members.push({ ...team.members[0], id: 'worker', isLead: false })
  reset([team])
  const requests: RunRequest[] = []
  let complete!: (snapshot: RunSnapshot) => void
  t.mock.method(runtimeClient, 'start', (request: RunRequest) => {
    requests.push(request)
    return new Promise<RunSnapshot>((resolve) => { complete = resolve })
  })
  const sending = useCollaboration.getState().send(team.id, 'worker', undefined, undefined, 'First request')
  assert.equal(requests[0].permissionMode, 'ask')
  useCollaboration.getState().setPermissionMode(team.id, 'review')
  assert.equal(requests[0].permissionMode, 'ask')
  assert.equal(useCollaboration.getState().runs[requests[0].id].permissionMode, 'ask')
  complete(reply(requests[0]))
  await sending
  t.mock.method(runtimeClient, 'start', async (request: RunRequest) => { requests.push(request); return reply(request) })
  await useCollaboration.getState().send(team.id, 'worker', undefined, undefined, 'Second request')
  assert.equal(requests[1].permissionMode, 'review')
  useCollaboration.getState().setPermissionMode(team.id, 'auto')
  await useCollaboration.getState().retryMessage(team.id, `${requests[1].id}-reply-1`)
  assert.equal(requests[2].permissionMode, 'auto')
  assert.equal(requests[1].permissionMode, 'review')
  assert.equal(useCollaboration.getState().runs[requests[0].id].permissionMode, 'ask')
})

test('project children use a stable assistant identity and never mix other project private context', async (t) => {
  const project = createWorkspace('project', 'grok', 'A')
  const child = createWorkspace('conversation', 'grok', 'A chat', '', project)
  const other = createWorkspace('project', 'grok', 'B')
  child.messages.push({ id: 'private-a', author: 'you', to: child.members[0].id, private: true,
    text: 'A private preference', time: '10:00', kind: 'message', sample: false })
  other.messages.push({ id: 'private-b', author: 'you', to: other.members[0].id, private: true,
    text: 'B confidential detail', time: '10:00', kind: 'message', sample: false })
  reset([project, child, other])
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  assert.equal(assistantScopeId(child), project.id)
  await useCollaboration.getState().send(child.id, child.members[0].id, undefined, undefined, 'hello')
  assert.equal(requests[0].assistantScopeId, project.id)
  assert.match(JSON.stringify(requests[0].privateContext), /A private preference/)
  assert.doesNotMatch(JSON.stringify(requests[0].context), /A private preference/)
  assert.doesNotMatch(JSON.stringify(requests[0]), /B confidential detail/)
})

test('background work permits one independent private conversation without replacing its run', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  reset([team])
  const work = { ...reply({ id: 'background', workspaceId: team.id, employees: team.members } as RunRequest), status: 'running' as const }
  useCollaboration.setState({ runs: { background: work } })
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  await useCollaboration.getState().send(team.id, team.members[0].id, undefined, undefined, '今天想聊聊', 'conversation')
  assert.equal(requests[0].interaction, 'conversation')
  assert.equal(requests[0].coordination, undefined)
  assert.equal(useCollaboration.getState().runs.background.status, 'running')
  const messages = useCollaboration.getState().teams[0].messages
  assert.ok(messages.every((message) => message.private && message.interaction === 'conversation'))
})

test('private conversation history is excluded from direct employee requests', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  team.members.push({ ...team.members[0], id: 'worker', name: 'Worker', isLead: false })
  team.messages.push({ id: 'private', author: 'you', to: team.members[0].id, text: 'private story',
    private: true, time: '10:00', kind: 'message', sample: false })
  reset([team])
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  await useCollaboration.getState().send(team.id, 'worker', undefined, undefined, 'inspect this code')
  assert.equal(requests[0].privateContext, undefined)
  assert.equal(requests[0].assistantScopeId, undefined)
  assert.doesNotMatch(JSON.stringify(requests[0]), /private story/)
})

test('regenerating a managed lead response replaces its queued placeholder using actual reply IDs', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  team.messages = [
    { id: 'source', author: 'you', to: team.members[0].id, text: 'hello', time: '10:00', kind: 'message', sample: false, runId: 'old', status: 'completed' },
    { id: 'old-reply', author: team.members[0].id, to: 'all', text: 'old answer', time: '10:01', kind: 'message', sample: false, runId: 'old', status: 'completed', sourceMessageId: 'source' }
  ]
  reset([team])
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  await useCollaboration.getState().retryMessage(team.id, 'old-reply')
  const messages = useCollaboration.getState().teams[0].messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].id, 'old-reply')
  assert.equal(messages[1].text, 'answer')
  assert.equal(messages[1].status, 'completed')
})

test('regenerated replies retain identity across streaming, reload, permission cards and deletion', () => {
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.messages = [{ id: 'stable-ui-id', author: lead.id, to: 'all', text: '', time: '', kind: 'message', sample: false,
    status: 'queued', sourceMessageId: 'source', runId: 'stream', private: true, interaction: 'conversation' }]
  reset([team])
  const snapshot: RunSnapshot = { id: 'stream', workspaceId: team.id, status: 'running', revision: 1,
    createdAt: new Date().toISOString(), permissions: [], contextTrimmed: false,
    replies: [{ id: 'real-reply-id', employeeId: lead.id, provider: lead.provider, text: 'first', model: 'mock', status: 'running' }] }
  useCollaboration.getState().applyRun(snapshot)
  useCollaboration.getState().applyRun({ ...snapshot, revision: 2, replies: [{ ...snapshot.replies[0], text: 'second' }] })
  const persisted = JSON.parse(JSON.stringify(useCollaboration.getState().teams[0])) as Team
  assert.equal(isValidTeam(persisted), true)
  assert.equal(persisted.messages.length, 1)
  assert.equal(persisted.messages[0].runtimeReplyId, 'real-reply-id')
  reset([persisted])
  useCollaboration.getState().applyRun({ ...snapshot, revision: 3, status: 'completed',
    replies: [{ ...snapshot.replies[0], text: 'final', status: 'completed' }], permissionHistory: [{
      id: 'approval', replyId: 'real-reply-id', employeeId: lead.id, title: 'Write', detail: '', options: [],
      createdAt: snapshot.createdAt, status: 'cancelled'
    }] })
  const messages = useCollaboration.getState().teams[0].messages
  assert.equal(messages.length, 2)
  assert.equal(messages[0].id, 'stable-ui-id')
  assert.equal(messages[0].text, 'final')
  assert.equal(messages[0].private, true)
  assert.equal(messages[0].interaction, 'conversation')
  assert.equal(messages[1].toolPermission?.replyId, 'real-reply-id')
  useCollaboration.getState().deleteMessage(team.id, 'stable-ui-id')
  useCollaboration.getState().applyRun({ ...snapshot, revision: 4, status: 'completed', replies: [{ ...snapshot.replies[0], status: 'completed' }] })
  assert.equal(useCollaboration.getState().teams[0].messages.filter((message) => !message.toolPermission).length, 0)
})

test('legacy direct lead exchanges stay private while explicitly shared messages remain available', async (t) => {
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.members.push({ ...lead, id: 'worker', isLead: false })
  team.messages = [
    { id: 'legacy-user', author: 'you', to: lead.id, text: 'legacy secret', time: '', kind: 'message', sample: false },
    { id: 'legacy-lead', author: lead.id, to: 'all', text: 'legacy private answer', time: '', kind: 'message', sample: false },
    { id: 'public', author: lead.id, to: 'all', text: 'shared outcome', private: false, time: '', kind: 'message', sample: false }
  ]
  reset([team])
  const requests: RunRequest[] = []
  mockRuns(t, requests)
  await useCollaboration.getState().send(team.id, 'worker', undefined, undefined, 'continue')
  assert.doesNotMatch(JSON.stringify(requests[0]), /legacy secret|legacy private answer/)
  assert.match(JSON.stringify(requests[0].context), /shared outcome/)
})

test('deleting an independent conversation clears reminders first and preserves the conversation on failure', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  reset([team])
  t.mock.method(runtimeClient, 'clearAssistant', async () => { throw new Error('disk unavailable') })
  assert.equal(await useCollaboration.getState().deleteConversation(team.id), false)
  assert.equal(useCollaboration.getState().teams[0].id, team.id)
  t.mock.method(runtimeClient, 'clearAssistant', async (scopeId: string): Promise<AssistantSnapshot> => ({
    profile: { scopeId, name: 'assistant', persona: '', addressing: '', style: 'balanced', updatedAt: new Date().toISOString() },
    memories: [], commitments: [], revision: 20
  }))
  assert.equal(await useCollaboration.getState().deleteConversation(team.id), true)
  assert.notEqual(useCollaboration.getState().teams[0].id, team.id)
})

test('deleting a project child does not clear the project assistant', async (t) => {
  const project = createWorkspace('project', 'grok'), child = createWorkspace('conversation', 'grok', '', '', project)
  reset([project, child])
  t.mock.method(runtimeClient, 'clearAssistant', async () => assert.fail('project assistant must survive child deletion'))
  assert.equal(await useCollaboration.getState().deleteConversation(child.id), true)
  assert.equal(useCollaboration.getState().teams[0].id, project.id)
})

test('a paused project refuses regeneration before invalidating accepted deliveries', async () => {
  const team = createWorkspace('conversation', 'grok')
  const employee = team.members[0]
  team.paused = true
  team.tasks = [{ id: 'task', title: 'task', description: 'task', acceptance: 'ok', owner: employee.id, dependency: null,
    state: 'done', resultRunId: 'old', acceptedRunId: 'old', managedRunId: 'old', managedStatus: 'completed' }]
  team.messages = [
    { id: 'source', author: 'you', to: employee.id, text: 'work', time: '10:00', kind: 'message', sample: false, runId: 'old' },
    { id: 'answer', author: employee.id, to: 'all', text: 'done', time: '10:01', kind: 'handoff', sample: false, runId: 'old', taskId: 'task', sourceMessageId: 'source' }
  ]
  reset([team])
  await useCollaboration.getState().retryMessage(team.id, 'answer')
  assert.equal(useCollaboration.getState().teams[0].tasks[0].state, 'done')
  assert.equal(useCollaboration.getState().teams[0].tasks[0].acceptedRunId, 'old')
})

test('explicit stop text cancels the identified work run and never starts a new model', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  reset([team])
  const work = { ...reply({ id: 'work', workspaceId: team.id, employees: team.members } as RunRequest), status: 'running' as const }
  useCollaboration.setState({ runs: { work } })
  const previous = runtimeClient.cancel
  let cancelled = ''
  runtimeClient.cancel = async (id) => { cancelled = id; return { ...work, status: 'cancelled', revision: 2 } }
  t.after(() => { runtimeClient.cancel = previous })
  await useCollaboration.getState().send(team.id, team.members[0].id, undefined, undefined, '暂停刚才的任务')
  assert.equal(cancelled, 'work')
  assert.equal(useCollaboration.getState().teams[0].messages.at(-1)?.text, '已停止当前任务，已有结果保留。')
  assert.equal(isStopWorkMessage('不要停止当前任务'), false)
  assert.equal(isStopWorkMessage('讨论如何停止任务'), false)
})
