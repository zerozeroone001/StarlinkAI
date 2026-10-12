import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunMetricsPanel, formatDuration } from '../src/renderer/src/components/RunMetricsPanel'
import { CollaborationWorkspace } from '../src/renderer/src/components/CollaborationWorkspace'
import { useApp } from '../src/renderer/src/stores/app'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import { getProviderReadiness, inspectionForProvider } from '../src/renderer/src/lib/provider-account'
import { providerErrorSummary } from '../src/renderer/src/lib/provider-error-summary'
import { availableOnboardingChoice, currentConversationBlockReason, onboardingContextError, onboardingMember } from '../src/renderer/src/lib/provider-onboarding'
import { useProviders } from '../src/renderer/src/stores/providers'
import type { RunRequest, RunSnapshot, RuntimeProvider } from '../src/shared/runtime'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })

const authorizedProvider: RuntimeProvider = { id: 'grok', cli: { state: 'installed', version: null, path: 'test-cli' },
  auth: { signedIn: true, email: null, name: null, userId: null }, checkedAt: new Date().toISOString(),
  models: [{ id: 'test-model', name: 'Test', efforts: [], isDefault: true }], usage: null, loginCommand: 'test-login' }

test('provider inspection publishes fast accounts immediately and coalesces batch, per-provider and usage refreshes', async (t) => {
  const initial = useProviders.getState()
  t.after(() => useProviders.setState(initial))
  useProviders.setState({ diagnostics: [], providerChecks: {}, checked: false, checking: false, error: null, usage: null })
  const calls: string[] = []
  const pending = new Map<string, { resolve: (providers: RuntimeProvider[]) => void; reject: (error: Error) => void }>()
  t.mock.method(runtimeClient, 'providers', async (refresh, ids) => {
    assert.equal(refresh, true)
    assert.equal(ids?.length, 1)
    const id = ids![0]
    calls.push(id)
    return new Promise<RuntimeProvider[]>((resolve, reject) => pending.set(id, { resolve, reject }))
  })
  const all = useProviders.getState().inspect()
  assert.equal(useProviders.getState().inspect(), all, 'newly mounted consumers must join the same batch')
  const grok = useProviders.getState().inspect(['grok'])
  const usage = useProviders.getState().loadUsage()
  await Promise.resolve()
  assert.deepEqual(calls.sort(), ['claude', 'codex', 'gemini', 'grok'])
  pending.get('grok')!.resolve([authorizedProvider])
  await Promise.all([grok, usage])
  let state = useProviders.getState()
  assert.equal(state.checking, true)
  assert.equal(state.checked, false)
  assert.equal(state.usageLoading, false, 'Grok usage does not wait for Codex')
  assert.equal(getProviderReadiness(state.diagnostics[0], state).canRun, true)
  assert.equal(inspectionForProvider(state, 'codex').checking, true)
  assert.equal(useProviders.getState().inspect(), all)
  await Promise.resolve()
  assert.equal(calls.length, 4, 'finished accounts must not be redundantly refreshed while the initial batch continues')
  pending.get('gemini')!.reject(new Error('Gemini timed out'))
  pending.get('claude')!.resolve([{ ...authorizedProvider, id: 'claude' }])
  pending.get('codex')!.resolve([{ ...authorizedProvider, id: 'codex' }])
  await all
  state = useProviders.getState()
  assert.equal(state.checking, false)
  assert.equal(state.checked, true)
  assert.match(state.providerChecks.gemini!.error!, /timed out/)
  assert.equal(getProviderReadiness(state.diagnostics.find((provider) => provider.id === 'grok'), state).canRun, true)
  const retry = state.inspect(['gemini'])
  const duplicate = state.inspect(['gemini', 'gemini'])
  await Promise.resolve()
  assert.equal(calls.length, 5)
  pending.get('gemini')!.resolve([{ ...authorizedProvider, id: 'gemini' }])
  await Promise.all([retry, duplicate])
  assert.equal(useProviders.getState().providerChecks.gemini!.error, null)
  assert.equal(useProviders.getState().error, null)
  assert.equal(useProviders.getState().diagnostics.length, 4)
})

test('a failed refresh blocks only its stale account and a successful retry replaces stale authorization', async (t) => {
  const initial = useProviders.getState()
  t.after(() => useProviders.setState(initial))
  useProviders.setState({ diagnostics: [authorizedProvider, { ...authorizedProvider, id: 'codex' }],
    providerChecks: { grok: { checked: true, checking: false, error: null }, codex: { checked: true, checking: false, error: null } },
    checked: true, checking: false, error: null })
  let fail = true
  t.mock.method(runtimeClient, 'providers', async () => {
    if (fail) throw new Error('Grok probe failed')
    return [{ ...authorizedProvider, auth: { ...authorizedProvider.auth!, signedIn: false } }]
  })
  await useProviders.getState().inspect(['grok'])
  let state = useProviders.getState()
  assert.equal(getProviderReadiness(state.diagnostics.find((provider) => provider.id === 'grok'), state).state, 'error')
  assert.equal(getProviderReadiness(state.diagnostics.find((provider) => provider.id === 'codex'), state).canRun, true)
  fail = false
  await state.inspect(['grok'])
  state = useProviders.getState()
  assert.equal(getProviderReadiness(state.diagnostics.find((provider) => provider.id === 'grok'), state).state, 'unauthorized')
  assert.equal(state.providerChecks.grok!.error, null)
})

test('provider API keeps the existing all-provider call and forwards an optional provider filter', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const calls: unknown[][] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { grok: { workspace: {
    providers: async (...args: unknown[]) => { calls.push(args); return [authorizedProvider] }
  } } } })
  await runtimeClient.providers(true)
  await runtimeClient.providers(false, ['grok'])
  assert.deepEqual(calls, [[true, undefined], [false, ['grok']]])
})

test('workspace marks retained sample replies and blocks an unauthorized lead without discarding its draft', (t) => {
  // Render the current fixture, not Zustand's module-initial hydration snapshot.
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const providers = useProviders.getState(), collaboration = useCollaboration.getState(), app = useApp.getState()
  const team = createWorkspace('conversation', 'claude'), lead = team.members[0]
  // The workspace may have real turns while retaining individual historical samples.
  team.sample = false
  team.messages = [{ id: 'sample', author: lead.id, to: 'all', time: '10:00', kind: 'message', sample: true, text: 'historical fixture' }]
  useApp.setState({ rightOpen: true })
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: { [team.id]: 'unsent draft' },
    attachmentDrafts: {}, taskSchedules: {}, runtimeError: null })
  useProviders.setState({ checked: true, checking: false, error: null,
    diagnostics: [{ ...authorizedProvider, id: 'claude', auth: { ...authorizedProvider.auth!, signedIn: false } }] })
  try {
    const html = renderToStaticMarkup(createElement(CollaborationWorkspace))
    assert.match(html, /历史示例内容，非真实模型执行记录/)
    assert.match(html, /示例回复/)
    assert.match(html, /Claude · 未授权/)
    assert.match(html, /aria-label="发送消息"[^>]*disabled/)
    assert.match(html, /unsent draft/)
    assert.match(html, /class="inspector-member-details"/)
    assert.match(html, /class="composer-mode"/)
  } finally { useProviders.setState(providers); useCollaboration.setState(collaboration); useApp.setState(app) }
})

test('authorized workspace has an enabled composer and real replies are never labelled as samples', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const providers = useProviders.getState(), collaboration = useCollaboration.getState()
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.messages = [{ id: 'real', author: lead.id, to: 'all', time: '10:00', kind: 'message', sample: false, text: 'real reply' }]
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: { [team.id]: 'next question' },
    attachmentDrafts: {}, taskSchedules: {}, runtimeError: null })
  useProviders.setState({ checked: true, checking: false, error: null, diagnostics: [authorizedProvider] })
  try {
    const html = renderToStaticMarkup(createElement(CollaborationWorkspace))
    assert.doesNotMatch(html, /历史示例内容|示例回复|composer-account-notice/)
    assert.doesNotMatch(html, /aria-label="发送消息"[^>]*disabled/)
  } finally { useProviders.setState(providers); useCollaboration.setState(collaboration) }
})

test('provider readiness distinguishes installed clients and model catalogs from account authorization', () => {
  assert.equal(getProviderReadiness(undefined).state, 'unknown')
  assert.equal(getProviderReadiness(undefined, { checking: true }).state, 'checking')
  assert.equal(getProviderReadiness(authorizedProvider, { error: 'offline' }).state, 'error')
  assert.equal(getProviderReadiness(undefined, { checked: true }).state, 'unavailable')
  assert.equal(getProviderReadiness({ ...authorizedProvider, cli: { ...authorizedProvider.cli, state: 'not_found' } }).canRun, false)
  assert.equal(getProviderReadiness({ ...authorizedProvider, id: 'claude', auth: { ...authorizedProvider.auth!, signedIn: false } }).state, 'unauthorized')
  assert.equal(getProviderReadiness({ ...authorizedProvider, models: [] }).state, 'unavailable')
  for (const error of ['auth', 'signed_out']) assert.equal(getProviderReadiness({ ...authorizedProvider,
    usage: { plan: null, fetchedAt: '', windows: [], error } }).state, 'unauthorized')
  assert.equal(getProviderReadiness({ ...authorizedProvider, usage: { plan: null, fetchedAt: '', windows: [], error: 'network' } }).state, 'ready')
  assert.equal(getProviderReadiness(authorizedProvider).canRun, true)
})

test('provider failures show actionable categories without leaking raw client output', () => {
  const sensitive = 'Bearer secret-credential sk-1234567890abcdef C:\\Users\\private\\token.json\n    at privateFunction (private.ts:42)'
  for (const [error, expected] of [
    ['Error invoking remote method: ETIMEDOUT timeout', /超时/],
    ['401 Unauthorized', /授权失效/], ['spawn ENOENT', /未找到本机客户端/],
    ['EACCES permission denied', /权限/], ['fetch failed ECONNRESET', /网络或代理/],
    ['HTTP 429 rate limit', /频繁/], ['503 Service Unavailable', /暂时不可用/], ['Unexpected output', /检测失败/]
  ] as const) {
    const result = providerErrorSummary(`${error}: ${sensitive}`)
    assert.match(result, expected)
    assert.ok(result.length < 60)
    assert.doesNotMatch(result, /secret|123456|private|Bearer|at /)
  }
  assert.equal(providerErrorSummary({ message: sensitive }), providerErrorSummary(undefined))
})

test('a disconnected running reply shows an uncertain state without losing partial output or stopping controls', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const providers = useProviders.getState(), collaboration = useCollaboration.getState()
  t.after(() => { useProviders.setState(providers); useCollaboration.setState(collaboration) })
  const team = createWorkspace('conversation', 'grok')
  team.messages = [{ id: 'partial', author: team.members[0].id, to: 'all', time: '10:00', kind: 'message',
    text: 'preserved partial reply', sample: false, status: 'running', runId: 'offline-run' }]
  const run: RunSnapshot = { id: 'offline-run', workspaceId: team.id, interaction: 'conversation', status: 'running',
    createdAt: '', permissions: [], replies: [], contextTrimmed: false }
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: { [run.id]: run }, drafts: { [team.id]: 'unsent draft' },
    connectionErrors: { [run.id]: '连接中断，正在重连；执行状态待确认，请勿重复发送。' }, attachmentDrafts: {}, taskSchedules: {}, runtimeError: null })
  useProviders.setState({ checked: true, checking: false, error: null, providerChecks: {}, diagnostics: [authorizedProvider] })
  const disconnected = renderToStaticMarkup(createElement(CollaborationWorkspace))
  assert.match(disconnected, /连接中断 · 执行状态待确认/)
  assert.doesNotMatch(disconnected, /class="runtime-pulse"|回复中/)
  assert.match(disconnected, /停止生成/)
  assert.equal(useCollaboration.getState().teams[0].messages[0].text, 'preserved partial reply')
  assert.match(disconnected, /复制回复/)
  assert.match(disconnected, /unsent draft/)
  useCollaboration.setState({ connectionErrors: {} })
  const connected = renderToStaticMarkup(createElement(CollaborationWorkspace))
  assert.match(connected, /回复中/)
  assert.match(connected, /class="runtime-pulse"/)
  assert.doesNotMatch(connected, /连接中断 · 执行状态待确认/)
  assert.equal(useCollaboration.getState().runs[run.id], run)
})

test('composer shows a concise failed-provider reason and both recovery actions while another provider is checking', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const providers = useProviders.getState(), collaboration = useCollaboration.getState()
  t.after(() => { useProviders.setState(providers); useCollaboration.setState(collaboration) })
  const team = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: { [team.id]: 'keep draft' },
    attachmentDrafts: {}, taskSchedules: {}, runtimeError: null, connectionErrors: {} })
  useProviders.setState({ diagnostics: [authorizedProvider], checking: true, checked: false, error: 'timeout secret',
    providerChecks: { grok: { checked: true, checking: false, error: 'IPC timeout Bearer secret-token\n at private.ts:10' }, codex: { checking: true } } })
  const html = renderToStaticMarkup(createElement(CollaborationWorkspace))
  assert.match(html, /检测失败：检测超时，请重试。/)
  const notice = html.match(/class="composer-account-notice"[\s\S]*?<\/div>/)![0]
  assert.match(notice, /重新检测/)
  assert.match(notice, /模型与账号/)
  assert.doesNotMatch(notice, /disabled|secret-token|private.ts|Bearer/)
  assert.match(html, /keep draft/)
})

test('known unauthorized employees cannot consume drafts, create messages, broadcast, or start tasks', async (t) => {
  const initialProviders = useProviders.getState()
  const team = createWorkspace('conversation', 'claude'), lead = team.members[0]
  team.tasks = [{ id: 'task', title: 'test', description: '', acceptance: 'checked', owner: lead.id, dependency: null, state: 'ready' }]
  useCollaboration.setState({ teams: [team], runs: {}, drafts: { [team.id]: 'keep this draft' }, attachmentDrafts: {}, taskSchedules: {} })
  useProviders.setState({ checked: true, checking: false, error: null,
    diagnostics: [{ ...authorizedProvider, id: 'claude', auth: { ...authorizedProvider.auth!, signedIn: false } }] })
  const start = t.mock.method(runtimeClient, 'start', async () => { throw Error('must not call runtime') })
  try {
    await useCollaboration.getState().send(team.id, lead.id)
    await useCollaboration.getState().send(team.id, lead.id, undefined, undefined, undefined, 'conversation')
    await useCollaboration.getState().send(team.id, 'all')
    await useCollaboration.getState().executeTask(team.id, 'task')
    assert.equal(start.mock.callCount(), 0)
    assert.equal(useCollaboration.getState().teams[0].messages.length, 0)
    assert.equal(useCollaboration.getState().teams[0].tasks[0].state, 'ready')
    assert.equal(useCollaboration.getState().drafts[team.id], 'keep this draft')
    assert.deepEqual(useCollaboration.getState().runs, {})
    assert.match(useCollaboration.getState().runtimeError || '', /登录/)
  } finally { useProviders.setState(initialProviders) }
})

test('connecting a provider preserves a single empty conversation identity and personal configuration', () => {
  const team = createWorkspace('conversation', 'grok')
  team.members[0] = { ...team.members[0], persona: 'Keep my preferred working style', role: 'developer', model: 'old-model', effort: 'old-effort' }
  const before = structuredClone(team)
  const provider = { ...authorizedProvider, id: 'claude' as const }
  const member = onboardingMember(team, {}, provider, { model: 'test-model' })
  assert.equal(currentConversationBlockReason(team, {}), null)
  assert.equal(member.id, before.members[0].id)
  assert.equal(member.persona, before.members[0].persona)
  assert.equal(member.role, 'developer')
  assert.equal(member.provider, 'claude')
  assert.equal(member.model, 'test-model')
  assert.equal(member.effort, undefined)
  assert.deepEqual(team, before, 'preparing an explicit choice must not mutate the original workspace')
})

test('onboarding refuses to replace history, multiple employees, projects and every active execution status', () => {
  const base = createWorkspace('conversation', 'grok')
  const altered = [
    { ...base, messages: [{ id: 'm', author: 'you', to: 'all', time: '', text: 'history', kind: 'message' as const, sample: false }] },
    { ...base, deletedMessageIds: ['deleted-history'] },
    { ...base, members: [...base.members, { ...base.members[0], id: 'second', isLead: false }] },
    { ...base, kind: 'project' as const },
    { ...base, gallery: { prompt: '', ratio: 'auto', count: 1, createdAt: '' } },
    { ...base, tasks: [{ id: 'task', owner: base.members[0].id, title: 'work', description: '', acceptance: '', dependency: null, state: 'ready' as const }] },
    { ...base, artifacts: [{ id: 'artifact', owner: base.members[0].id, name: 'result', description: '', version: 1, content: 'work', format: 'txt' as const, sample: false }] }
  ]
  for (const team of altered) assert.throws(() => onboardingMember(team, {}, authorizedProvider, {}))
  assert.throws(() => onboardingMember(undefined, {}, authorizedProvider, {}))
  for (const status of ['queued', 'running', 'needs_permission'] as const) {
    const run: RunSnapshot = { id: 'active', workspaceId: base.id, status, createdAt: '', replies: [], permissions: [], contextTrimmed: false }
    assert.throws(() => onboardingMember(base, { active: run }, authorizedProvider, {}), /仍有执行/)
  }
})

test('onboarding only uses the current provider catalog and refuses invalidated model choices', () => {
  const provider = { ...authorizedProvider, models: [{ id: 'current', name: 'Current', efforts: ['low'], isDefault: true }] }
  assert.deepEqual(availableOnboardingChoice(provider, { model: 'stale', effort: 'high' }), { model: 'current', effort: undefined })
  const team = createWorkspace('conversation', 'grok')
  assert.throws(() => onboardingMember(team, {}, provider, { model: 'stale' }), /不可用/)
  assert.throws(() => onboardingMember(team, {}, provider, { model: 'current', effort: 'high' }), /不可用/)
})

test('a delayed account inspection cannot continue after switching, deleting or restoring its source workspace', async () => {
  const original = createWorkspace('conversation', 'grok')
  for (const change of ['switch', 'delete', 'restore'] as const) {
    let current = { activeTeamId: original.id, teams: [structuredClone(original)], generation: 1 }
    let release!: () => void
    const inspection = new Promise<void>((resolve) => { release = resolve })
    const finished = inspection.then(() => onboardingContextError(original.id, 1, current, current.generation))
    if (change === 'switch') current = { ...current, activeTeamId: 'a-different-conversation' }
    if (change === 'delete') current = { ...current, teams: [] }
    if (change === 'restore') current = { ...current, generation: 2 }
    const before = structuredClone(current)
    release()
    assert.match((await finished)!, change === 'switch' ? /已切换/ : change === 'delete' ? /已被删除/ : /已被替换/)
    assert.deepEqual(current, before)
  }
  assert.equal(onboardingContextError(original.id, 1, { activeTeamId: original.id, teams: [original] }, 1), null)
})

test('the new workspace default applies to independent conversations and projects while project children preserve project employees', (t) => {
  const initial = useCollaboration.getState()
  t.after(() => useCollaboration.setState(initial))
  const project = createWorkspace('project', 'grok', 'existing project', '', undefined, 'C:\\onboarding-fixture')
  project.members[0].model = 'existing-model'
  project.members[0].persona = 'project-specific lead'
  project.members.push({ ...project.members[0], id: 'existing-worker', name: 'worker', provider: 'gemini', isLead: false })
  useCollaboration.setState({ teams: [project], activeTeamId: project.id, defaultProvider: 'grok', modelDefaults: {} })
  useCollaboration.getState().setModelDefault('claude', { model: 'chosen-model', effort: 'high' })
  useCollaboration.getState().setDefaultProvider('claude')
  const conversationId = useCollaboration.getState().createWorkspace('conversation')
  const projectId = useCollaboration.getState().createWorkspace('project', 'new project', '', undefined, 'C:\\new-onboarding-fixture')
  const childId = useCollaboration.getState().createWorkspace('conversation', '', '', project.id)
  const state = useCollaboration.getState()
  for (const id of [conversationId, projectId]) {
    const created = state.teams.find((team) => team.id === id)!
    assert.equal(created.members[0].provider, 'claude')
    assert.equal(created.members[0].model, 'chosen-model')
    assert.equal(created.members[0].effort, 'high')
  }
  const child = state.teams.find((team) => team.id === childId)!
  assert.equal(child.defaultProvider, 'grok')
  assert.equal(child.directory, project.directory)
  assert.deepEqual(child.members.map(({ id, ...configuration }) => configuration), project.members.map(({ id, ...configuration }) => configuration))
  assert.deepEqual(state.teams.find((team) => team.id === project.id), project)
})

test('empty workspace prioritizes connection during inspection and ready alternatives without waiting', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const providers = useProviders.getState(), collaboration = useCollaboration.getState()
  t.after(() => { useProviders.setState(providers); useCollaboration.setState(collaboration) })
  const team = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: { [team.id]: 'keep my draft' },
    attachmentDrafts: {}, taskSchedules: {}, runtimeError: null, connectionErrors: {} })
  useProviders.setState({ diagnostics: [], checking: true, checked: false, error: null,
    providerChecks: { grok: { checking: true }, codex: { checking: true } } })
  const checking = renderToStaticMarkup(createElement(CollaborationWorkspace))
  assert.match(checking, /正在检查本机模型/)
  assert.match(checking, /连接模型账号/)
  assert.match(checking, /keep my draft/)
  assert.doesNotMatch(checking, /没有已授权|未登录/)
  useProviders.setState({ diagnostics: [{ ...authorizedProvider, id: 'claude' }],
    providerChecks: { grok: { checking: true }, codex: { checking: true }, claude: { checked: true, checking: false } } })
  const partial = renderToStaticMarkup(createElement(CollaborationWorkspace))
  assert.match(partial, /选择可用模型/)
  assert.match(partial, /已有模型账号可直接使用/)
  assert.match(partial, /keep my draft/)
})

test('an authorized manager can start while an unused employee is not authorized', async (t) => {
  const initialProviders = useProviders.getState()
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.members.push({ id: 'claude-worker', name: 'Claude', provider: 'claude', role: 'test', persona: '', isLead: false })
  useCollaboration.setState({ teams: [team], runs: {}, drafts: {}, attachmentDrafts: {}, taskSchedules: {} })
  useProviders.setState({ checked: true, checking: false, error: null,
    diagnostics: [authorizedProvider, { ...authorizedProvider, id: 'claude', auth: { ...authorizedProvider.auth!, signedIn: false } }] })
  const snapshots = new Map<string, RunSnapshot>()
  const start = t.mock.method(runtimeClient, 'start', async (request: RunRequest) => {
    const snapshot: RunSnapshot = { id: request.id, workspaceId: team.id, status: 'completed', createdAt: '', replies: [], permissions: [], contextTrimmed: false }
    snapshots.set(request.id, snapshot)
    return snapshot
  })
  t.mock.method(runtimeClient, 'run', async (id: string) => snapshots.get(id)!)
  try {
    await useCollaboration.getState().send(team.id, lead.id, undefined, undefined, 'ask the manager')
    assert.equal(start.mock.callCount(), 1)
    assert.equal(start.mock.calls[0].arguments[0].coordination?.leadId, lead.id)
    await useCollaboration.getState().send(team.id, 'claude-worker', undefined, undefined, 'direct task')
    assert.equal(start.mock.callCount(), 1)
  } finally { useProviders.setState(initialProviders) }
})

test('runtime metrics distinguish execution from queue and permission waits, and support older runs', () => {
  const run: RunSnapshot = { id: 'metrics', workspaceId: 'project', status: 'completed', createdAt: '2026-10-08T00:00:00Z',
    permissions: [], replies: [], contextTrimmed: false }
  assert.equal(renderToStaticMarkup(createElement(RunMetricsPanel, { run })), '')
  run.metrics = { modelCalls: 4, leadCalls: 2, workerCalls: 2, leadExecutionMs: 5000, workerExecutionMs: 7000,
    permissionWaitMs: 61000, queueWaitMs: 250, contextCharacters: 24000, contextEstimatedTokens: 12000,
    archiveWrites: 2, archiveReuses: 2, fileScans: 4 }
  const html = renderToStaticMarkup(createElement(RunMetricsPanel, { run }))
  assert.match(html, /4 次调用 · 累计 12.0 秒/)
  assert.match(html, /等待确认（累计）/)
  assert.match(html, /1 分 1 秒/)
  assert.match(html, /输入 token 估算（累计）/)
  assert.match(html, /<summary aria-label="执行统计"/)
  assert.equal(formatDuration(NaN), '-')
  assert.equal(formatDuration(-1), '-')
  assert.equal(formatDuration(250), '250 ms')
})

test('retrying a task preserves review feedback and sends all dependency identities with precise result references', async (t) => {
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.tasks = [
    { id: 'a', title: 'first', owner: lead.id, description: '', acceptance: 'checked', dependency: null, state: 'done',
      managedRunId: 'prior', resultRunId: 'prior', acceptedRunId: 'prior', managedStatus: 'completed' },
    { id: 'b', title: 'second', owner: lead.id, description: '', acceptance: 'checked', dependency: null, state: 'done',
      managedRunId: 'prior', resultRunId: 'prior', acceptedRunId: 'prior', managedStatus: 'completed' },
    { id: 'c', title: 'retry', owner: lead.id, description: 'fix it', acceptance: 'tests pass', dependency: 'a',
      managedDependencies: ['b'], state: 'ready', managedRunId: 'prior', managedStatus: 'failed', reviewNote: '边界值未覆盖，请补回归测试' }
  ]
  team.messages = [{ id: 'ui-a', runtimeReplyId: 'backend-a', author: lead.id, to: 'all', time: '', kind: 'handoff',
    sample: false, text: 'first output', taskId: 'a', runId: 'prior', status: 'completed', private: false }]
  useCollaboration.setState({ teams: [team], runs: {}, drafts: {}, attachmentDrafts: {}, taskSchedules: {}, connectionErrors: {} })
  const requests: RunRequest[] = [], snapshots = new Map<string, RunSnapshot>()
  t.mock.method(runtimeClient, 'start', async (request: RunRequest) => {
    requests.push(request)
    const snapshot: RunSnapshot = { id: request.id, workspaceId: team.id, status: 'completed', createdAt: new Date().toISOString(),
      replies: [], permissions: [], contextTrimmed: false }
    snapshots.set(request.id, snapshot)
    return snapshot
  })
  t.mock.method(runtimeClient, 'run', async (id: string) => snapshots.get(id)!)
  await useCollaboration.getState().executeTask(team.id, 'c')
  assert.equal(requests[0].task?.review, '边界值未覆盖，请补回归测试')
  assert.deepEqual(requests[0].task?.dependencies?.map((dependency) => dependency.id).sort(), ['a', 'b'])
  await useCollaboration.getState().send(team.id, lead.id, undefined, undefined, 'continue')
  assert.equal(requests[1].coordination?.previousTasks?.find((task) => task.id === 'a')?.replyId, 'backend-a')
  assert.deepEqual(requests[1].coordination?.previousTasks?.find((task) => task.id === 'c')?.dependencies.slice().sort(), ['a', 'b'])
})
