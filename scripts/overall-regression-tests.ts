import { beforeEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useApp } from '../src/renderer/src/stores/app'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { createWorkspace, type Team } from '../src/renderer/src/lib/collaboration-data'
import { collectGalleryImages, groupGalleryImages } from '../src/renderer/src/lib/gallery'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import type { RunRequest, RunSnapshot } from '../src/shared/runtime'

beforeEach(() => {
  Object.assign(globalThis, { window: { grok: {} }, document: { documentElement: { dataset: {}, lang: '' } }, localStorage: { getItem: () => null, setItem: () => {} } })
  useCollaboration.setState({ teams: [], runs: {}, drafts: {}, attachmentDrafts: {}, taskSchedules: {}, connectionErrors: {}, runtimeError: null, deletedGalleryKeys: [], surface: 'workspace' })
  useApp.setState({ ready: false, startupError: null, skills: [], error: null, connected: false })
})
function acceptedTeam() {
  const team = createWorkspace('project', 'claude', '验收一致性')
  const owner = team.members[0].id
  team.tasks = [
    { id: 'one', owner, title: '前置', description: '', acceptance: '核验交付', dependency: null, state: 'done', resultRunId: 'old', acceptedRunId: 'old' },
    { id: 'two', owner, title: '后续', description: '', acceptance: '', dependency: 'one', state: 'done', resultRunId: 'child', acceptedRunId: 'child' }
  ]
  team.messages = [
    { id: 'initial', author: 'you', text: '原始需求', to: owner, time: '', kind: 'message', sample: false },
    { id: 'source', author: 'you', text: '执行前置', to: owner, taskId: 'one', runId: 'old', status: 'completed', time: '', kind: 'message', sample: false },
    { id: 'reply', author: owner, text: '旧交付', to: 'all', taskId: 'one', sourceMessageId: 'source', runId: 'old', status: 'completed', time: '', kind: 'message', sample: false }
  ]
  return team
}
function connect(t: TestContext, team: Team) {
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, taskSchedules: { [team.id]: { status: 'completed', remaining: [] } } })
  const replies = new Map<string, RunSnapshot>()
  const seen: RunRequest[] = []
  t.mock.method(runtimeClient, 'start', async (request: RunRequest) => {
    seen.push(request)
    const snapshot: RunSnapshot = { id: request.id, workspaceId: request.workspaceId, taskId: request.task?.id, status: 'completed', revision: 1,
      permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false, replies: request.employees.map((employee) => ({ employeeId: employee.id,
        employeeName: employee.name, provider: employee.provider, model: 'fixture', text: '新交付', status: 'completed' })) }
    replies.set(request.id, snapshot)
    return snapshot
  })
  t.mock.method(runtimeClient, 'run', async (id: string) => replies.get(id)!)
  return seen
}

test('startup can retry a failed snapshot and unavailable project files do not prevent agent startup', async () => {
  const api = window.grok as any
  api.snapshot = async () => { throw new Error('snapshot unavailable') }
  await useApp.getState().hydrate()
  assert.match(useApp.getState().startupError!, /snapshot unavailable/)
  assert.equal(useApp.getState().ready, false)
  let started = 0
  api.snapshot = async () => ({ projects: [{ path: 'missing', name: '旧项目' }], threads: [], auth: { signedIn: true }, theme: 'dark', locale: 'zh-CN', permissionMode: 'ask', skills: [] })
  api.git = async () => { throw new Error('directory unavailable') }
  api.tree = async () => { throw new Error('directory unavailable') }
  api.skills = { list: async () => [] }
  api.acp = { start: async () => { started++ } }
  await useApp.getState().hydrate()
  assert.equal(started, 1)
  assert.equal(useApp.getState().startupError, null)
  assert.equal(useApp.getState().ready, true)
  assert.equal(useApp.getState().sidebarWidth, 268)
  assert.equal(useApp.getState().rightWidth, 360)
  assert.match(useApp.getState().error!, /项目文件无法读取/)
})

test('regenerating an accepted task revokes dependent acceptance and pauses its old schedule', async (t) => {
  const team = acceptedTeam()
  const seen = connect(t, team)
  await useCollaboration.getState().retryMessage(team.id, 'reply')
  const state = useCollaboration.getState(), updated = state.teams[0]
  assert.equal(seen.length, 1)
  assert.equal(updated.tasks[0].state, 'review')
  assert.notEqual(updated.tasks[0].resultRunId, 'old')
  assert.equal(updated.tasks[0].acceptedRunId, undefined)
  assert.equal(updated.tasks[1].state, 'ready')
  assert.equal(updated.tasks[1].resultRunId, undefined)
  assert.equal(updated.tasks[1].acceptedRunId, undefined)
  assert.equal(state.taskSchedules[team.id].status, 'paused')
})

test('deleting an accepted delivery invalidates its task and descendants without launching a model', (t) => {
  const team = acceptedTeam(), seen = connect(t, team)
  useCollaboration.getState().deleteMessage(team.id, 'reply')
  const state = useCollaboration.getState()
  assert.equal(state.teams[0].messages.some((m) => m.id === 'reply'), false)
  for (const task of state.teams[0].tasks) { assert.equal(task.state, 'ready'); assert.equal(task.acceptedRunId, undefined); assert.equal(task.resultRunId, undefined) }
  assert.equal(state.taskSchedules[team.id].status, 'paused')
  assert.equal(seen.length, 0)
})

test('editing an earlier conversation branch revokes removed task deliveries and retains unsent drafts', async (t) => {
  const team = acceptedTeam()
  connect(t, team)
  useCollaboration.getState().setDraft(team.id, '尚未发送的补充')
  await useCollaboration.getState().editMessage(team.id, 'initial', '新的需求')
  const state = useCollaboration.getState()
  assert.equal(state.teams[0].messages.some((m) => m.id === 'reply'), false)
  assert.equal(state.teams[0].tasks.every((task) => task.state === 'ready' && !task.acceptedRunId), true)
  assert.equal(state.drafts[team.id], '尚未发送的补充')
})

test('deleting unrelated chat content preserves an accepted delivery and task state', (t) => {
  const team = acceptedTeam()
  connect(t, team)
  useCollaboration.getState().deleteMessage(team.id, 'initial')
  assert.equal(useCollaboration.getState().teams[0].tasks[0].acceptedRunId, 'old')
  assert.equal(useCollaboration.getState().teams[0].tasks[1].acceptedRunId, 'child')
})

test('gallery keeps the original provider when an employee changes provider or no longer exists', () => {
  const team = acceptedTeam()
  team.messages[2] = { ...team.messages[2], provider: 'claude', images: [{ path: '/fixture.png' }] }
  team.members[0].provider = 'grok'
  assert.equal(collectGalleryImages([team])[0].provider, 'claude')
  team.members = []
  team.defaultProvider = 'gemini'
  assert.equal(collectGalleryImages([team])[0].provider, 'claude')
})

test('gallery groups preserve result order and isolate matching prompts from different workspaces', () => {
  const team = createWorkspace('conversation', 'codex')
  team.messages = [{ id: 'images', author: team.members[0].id, to: 'all', time: '', kind: 'message', sample: false,
    text: '', images: [{ path: '/one.png', alt: '海边' }, { path: '/two.png', alt: '山间' }, { path: '/three.png', alt: '海边' }] }]
  const other = createWorkspace('conversation', 'grok')
  other.messages = [{ ...team.messages[0], id: 'other', author: other.members[0].id, images: [{ path: '/four.png', alt: '海边' }] }]
  const images = collectGalleryImages([team, other])
  const groups = groupGalleryImages(images)
  assert.deepEqual(groups.map((group) => [group.workspaceId, group.prompt, group.images.length]), [
    [other.id, '海边', 1], [team.id, '海边', 2], [team.id, '山间', 1]
  ])
  assert.deepEqual(groups[1].images.map((image) => image.image.path), ['/one.png', '/three.png'])
  assert.equal(new Set(groups.map((group) => group.id)).size, 3)
})

test('gallery jobs cannot become conversations through navigation, restore, or deleting the last chat', async (t) => {
  t.mock.method(runtimeClient, 'clearAssistant', async (scopeId: string) => ({ profile: { scopeId, name: 'assistant',
    persona: '', addressing: '', style: 'balanced', updatedAt: new Date().toISOString() }, memories: [], commitments: [], revision: 1 }))
  const conversation = createWorkspace('conversation', 'codex')
  connect(t, conversation)
  await useCollaboration.getState().generateImages('画廊专属任务', 'codex', '2:3', 4)
  const state = useCollaboration.getState(), job = state.teams.at(-1)!
  assert.ok(job.gallery)
  assert.equal(state.activeTeamId, conversation.id)
  assert.equal(state.teams.find((team) => team.id === conversation.id)?.messages.length, 0)
  state.navigate('team', job.id)
  assert.equal(useCollaboration.getState().page, 'gallery')
  assert.equal(useCollaboration.getState().activeTeamId, conversation.id)
  const saved = useCollaboration.persist.getOptions().partialize!(useCollaboration.getState()) as any
  const restored = useCollaboration.persist.getOptions().merge!({ ...saved, activeTeamId: job.id }, useCollaboration.getState())
  assert.equal(restored.page, 'gallery')
  assert.equal(restored.activeTeamId, conversation.id)
  const onlyGallery = useCollaboration.persist.getOptions().merge!({ ...saved, teams: [job], activeTeamId: job.id }, useCollaboration.getState())
  assert.ok(onlyGallery.teams.some((team) => team.id === onlyGallery.activeTeamId && !team.gallery))
  assert.ok(await useCollaboration.getState().deleteConversation(conversation.id))
  const after = useCollaboration.getState()
  assert.ok(after.teams.some((team) => team.id === job.id))
  assert.ok(after.teams.some((team) => team.id === after.activeTeamId && !team.gallery))
})

test('gallery shows four images once after a stopped run is executed again', () => {
  const first = createWorkspace('conversation', 'codex'), second = createWorkspace('conversation', 'codex')
  for (const [teamIndex, team] of [first, second].entries()) {
    const cwd = `C:/work/gallery-${teamIndex}`
    const images = Array.from({ length: 4 }, (_, i) => ({
      path: `${cwd}/images/${String(i + 1).repeat(64)}.png`, sourcePath: `C:/output/image-${i}.png`
    }))
    team.messages = [{ id: `reply-${teamIndex}`, author: team.members[0].id, to: 'all',
      text: images.map((image) => `![图片](${image.sourcePath})`).join('\n'), images, cwd,
      status: teamIndex ? 'completed' : 'cancelled', time: '', kind: 'message', sample: false }]
  }
  const gallery = collectGalleryImages([first, second])
  assert.equal(gallery.length, 4)
  assert.ok(gallery.every((item) => item.workspaceId === second.id))
})

test('gallery resolves relative links and Windows path aliases across replies', () => {
  const team = createWorkspace('conversation', 'codex')
  const base = { author: team.members[0].id, to: 'all', time: '', kind: 'message' as const, sample: false, cwd: 'C:/work/gallery' }
  team.messages = [
    { ...base, id: 'saved', text: '', images: [{ path: 'C:/work/gallery/images/one.png', sourcePath: 'C:/output/one.png' }] },
    { ...base, id: 'links', text: '![one](images/one.png)\n![one](c:/OUTPUT/one.png)' }
  ]
  assert.equal(collectGalleryImages([team]).length, 1)
  const other = createWorkspace('conversation', 'codex')
  other.messages = [{ ...base, id: 'different', cwd: 'C:/work/other', text: '![different](images/one.png)' }]
  assert.equal(collectGalleryImages([team, other]).length, 2)
})

test('new gallery execution uses the selected count after stopping the previous job', async (t) => {
  const seen = connect(t, createWorkspace('conversation', 'codex'))
  await useCollaboration.getState().generateImages('雪山', 'codex', 'auto', 4)
  const previous = Object.values(useCollaboration.getState().runs).at(-1)!
  t.mock.method(runtimeClient, 'cancel', async () => ({ ...previous, status: 'cancelled' as const, revision: 2 }))
  await useCollaboration.getState().stop(previous.id)
  await useCollaboration.getState().generateImages('雪山', 'codex', 'auto', 4)
  assert.equal(seen.length, 2)
  assert.ok(seen.every((request) => request.prompt.includes('生成 4 张独立图片')))
  assert.notEqual(seen[0].workspaceId, seen[1].workspaceId)
  assert.equal(seen[1].context.length, 0)
})

test('batch gallery deletion persists aliases without removing chat images and supports undo', () => {
  const team = createWorkspace('conversation', 'codex')
  team.messages = [{ id: 'images', author: team.members[0].id, to: 'all', time: '', kind: 'message', sample: false,
    text: '![first](C:/output/first.png)', images: [
      { path: 'C:/work/images/first.png', sourcePath: 'C:/output/first.png' },
      { path: 'C:/work/images/second.png' }, { path: 'C:/work/images/third.png' }
    ] }]
  useCollaboration.setState({ teams: [team] })
  const items = collectGalleryImages([team]).slice(0, 2)
  useCollaboration.getState().deleteGalleryImages(items)
  const saved = useCollaboration.persist.getOptions().partialize!(useCollaboration.getState()) as any
  const restored = useCollaboration.persist.getOptions().merge!(saved, useCollaboration.getState())
  assert.equal(collectGalleryImages(restored.teams, {}, restored.deletedGalleryKeys).length, 1)
  assert.equal(restored.teams[0].messages[0].images?.length, 3)
  const duplicate = createWorkspace('conversation', 'codex')
  duplicate.messages = [{ ...team.messages[0], id: 'duplicate', images: undefined }]
  assert.equal(collectGalleryImages([team, duplicate], {}, restored.deletedGalleryKeys).length, 1)
  useCollaboration.getState().restoreGalleryImages(items.flatMap((item) => item.keys))
  assert.equal(collectGalleryImages([team], {}, useCollaboration.getState().deletedGalleryKeys).length, 3)
})

test('gallery editing uploads the original and requests exactly one edited image', async (t) => {
  const team = createWorkspace('conversation', 'codex')
  team.messages = [{ id: 'image', author: team.members[0].id, to: 'all', time: '', kind: 'message', sample: false,
    text: '', images: [{ path: 'C:/original.png' }], cwd: 'C:/original-workspace' }]
  const seen = connect(t, team), image = collectGalleryImages([team])[0]
  t.mock.method(runtimeClient, 'media', async (workspaceId: string, source: string) => {
    assert.equal(workspaceId, team.id); assert.equal(source, image.image.path)
    return { dataUrl: 'data:image/png;base64,aGVsbG8=' }
  })
  t.mock.method(runtimeClient, 'upload', async (workspaceId: string, input: { name: string; data: string }) => {
    assert.equal(input.data, 'aGVsbG8='); assert.notEqual(workspaceId, team.id)
    return { id: 'original-attachment', name: input.name, path: 'C:/new/attachments/original.png', size: 5, mime: 'image/png' }
  })
  await useCollaboration.getState().generateImages('背景改成海边', 'codex', 'auto', 4, image)
  assert.equal(seen.length, 1)
  assert.match(seen[0].prompt, /图片编辑工具.*1 张编辑后的图片/)
  assert.equal(seen[0].attachments?.[0].id, 'original-attachment')
  assert.equal(useCollaboration.getState().teams.at(-1)?.gallery?.count, 1)
  assert.equal(useCollaboration.getState().activeTeamId, team.id)
  assert.deepEqual(useCollaboration.getState().teams.find((item) => item.id === team.id)?.messages, team.messages)
  assert.equal(collectGalleryImages(useCollaboration.getState().teams).some((item) => item.id === image.id), true)
})

test('failed original image upload does not launch an editing job or add an empty workspace', async (t) => {
  const team = createWorkspace('conversation', 'codex'), seen = connect(t, team)
  team.messages = [{ id: 'image', author: team.members[0].id, to: 'all', time: '', kind: 'message', sample: false,
    text: '', images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] }]
  t.mock.method(runtimeClient, 'upload', async () => { throw new Error('upload failed') })
  await assert.rejects(useCollaboration.getState().generateImages('换背景', 'codex', 'auto', 1, collectGalleryImages([team])[0]), /upload failed/)
  assert.equal(seen.length, 0)
  assert.equal(useCollaboration.getState().teams.length, 1)
})

test('slow skill results from a previous workspace cannot replace the current workspace list', async (t) => {
  let release!: (skills: any) => void
  const team = acceptedTeam(), other = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team, other], activeTeamId: team.id })
  t.mock.method(runtimeClient, 'skills', (id: string) => id === team.id ? new Promise((resolve) => { release = resolve }) : Promise.resolve([{ name: 'current-skill' }] as any))
  const pending = useApp.getState().loadSkills()
  useCollaboration.getState().navigate('team', other.id)
  await useApp.getState().loadSkills()
  release([{ name: 'stale-skill' }])
  await pending
  assert.equal(useApp.getState().skills[0].name, 'current-skill')
})

test('late skill failures after navigation cannot replace a current screen error', async (t) => {
  let reject!: (error: Error) => void
  const team = acceptedTeam(), other = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team, other], activeTeamId: team.id })
  t.mock.method(runtimeClient, 'skills', () => new Promise((_resolve, fail) => { reject = fail }))
  const pending = useApp.getState().loadSkills()
  useCollaboration.getState().navigate('team', other.id)
  useApp.setState({ error: '当前空间提示' })
  reject(new Error('旧空间错误'))
  await pending
  assert.equal(useApp.getState().error, '当前空间提示')
})

test('inserting a skill prepares the draft and preserves attachments without dispatching a model request', (t) => {
  const team = acceptedTeam(), seen = connect(t, team)
  const files = [{ id: 'upload', name: 'notes.txt', path: '/notes.txt', size: 12, mime: 'text/plain' }]
  useCollaboration.setState({ drafts: { [team.id]: '检查现有交付' }, attachmentDrafts: { [team.id]: files } })
  useApp.setState({ settingsOpen: true })
  useApp.getState().runSkill({ name: 'review', userInvocable: true, disabled: false } as any)
  assert.equal(useCollaboration.getState().drafts[team.id], '/review 检查现有交付')
  assert.deepEqual(useCollaboration.getState().attachmentDrafts[team.id], files)
  assert.equal(useApp.getState().settingsOpen, false)
  assert.equal(seen.length, 0)
  assert.equal(useCollaboration.getState().teams[0].messages.length, team.messages.length)
})
