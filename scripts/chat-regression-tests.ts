import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractMediaFromContent, extractMediaFromText, stripDisplayedMedia } from '../src/shared/media'
import { collectRunImages, previewWorkspaceImage } from '../src/main/runtime/media'
import { isAutomaticSkillUse, isRequestedImageTool, skillInstructions } from '../src/main/runtime/skill-policy'
import type { SkillInfo } from '../src/shared/types'
import { createWorkspace, isValidTeam } from '../src/renderer/src/lib/collaboration-data'
import { uploadAttachment, resolveAttachments } from '../src/main/runtime/attachments'
import { MAX_ATTACHMENT_BYTES } from '../src/shared/attachments'
import { useCollaboration, refreshRun, resumeRuns, reconnectRun } from '../src/renderer/src/stores/collaboration'
import { collaborationContext } from '../src/renderer/src/lib/collaboration-context'
import { RUN_EXPIRED_MESSAGE } from '../src/shared/runtime'
import { imageReplyBody } from '../src/shared/reply-display'
import { batchedStorage } from '../src/renderer/src/lib/batched-storage'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import { collectGalleryImages } from '../src/renderer/src/lib/gallery'
import { handleComposerEnter } from '../src/renderer/src/lib/composer-keyboard'
import type { RunRequest, RunSnapshot } from '../src/shared/runtime'
import { PermissionMessage } from '../src/renderer/src/components/PermissionMessage'
import { permissionDisplay, permissionOptionLabel } from '../src/renderer/src/lib/permission-display'
import { createWorkspaceBackup, parseWorkspaceBackup, MAX_WORKSPACE_BACKUP_BYTES } from '../src/renderer/src/lib/workspace-backup'
import { conversationFeed } from '../src/renderer/src/lib/conversation-feed'

test('portable backups preserve projects and unsaved drafts without including other account stores or image bytes', () => {
  const project = createWorkspace('project', 'grok', 'Portable project', 'ship', undefined, 'I:/portable')
  const conversation = createWorkspace('conversation', 'grok', 'Portable conversation', '', project)
  conversation.messages = [{ id: 'hello', author: 'you', to: 'all', text: 'Keep the full history', time: '10:00', kind: 'message', sample: false,
    images: [{ path: 'I:/image.png', dataUrl: 'data:image/png;base64,private-image-bytes' }] }]
  const source = { teams: [project, conversation], activeTeamId: conversation.id, drafts: { [conversation.id]: 'not yet saved' },
    attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok' as const, deletedGalleryKeys: [], apiKey: 'account-secret-must-not-export' }
  const text = createWorkspaceBackup(source)
  assert.doesNotMatch(text, /account-secret-must-not-export|private-image-bytes/)
  const imported = parseWorkspaceBackup(text)
  assert.equal(imported.teams[1].parentId, project.id)
  assert.equal(imported.teams[0].directory, 'I:/portable')
  assert.equal(imported.teams[1].messages[0].text, 'Keep the full history')
  assert.equal(imported.teams[1].messages[0].images?.[0].path, 'I:/image.png')
  assert.equal(imported.drafts[conversation.id], 'not yet saved')
})

test('backup parsing rejects oversized, prototype-bearing and invalid linked data before modifying the workspace', () => {
  const team = createWorkspace('conversation', 'grok')
  const text = createWorkspaceBackup({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok', deletedGalleryKeys: [] })
  assert.throws(() => parseWorkspaceBackup(' '.repeat(MAX_WORKSPACE_BACKUP_BYTES + 1)), /20 MiB/)
  assert.throws(() => parseWorkspaceBackup('{"__proto__":{"polluted":true}}'), /不安全/)
  const corrupt = (edit: (value: any) => void) => { const value = JSON.parse(text); edit(value); return JSON.stringify(value) }
  assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.version = 99 })), /版本/)
  assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.state.teams[0].parentId = 'missing-project' })), /关系/)
  assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.state.teams[0].members[0].id = '__proto__' })), /标识/)
  for (const id of Object.getOwnPropertyNames(Object.prototype))
    assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.state.teams[0].id = id; value.state.activeTeamId = id })), /标识/)
  assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.state.teams[0].tasks = [{ id: 'loop', title: '', description: '', owner: team.members[0].id, state: 'ready', dependency: 'loop', acceptance: '' }] })), /依赖/)
  assert.throws(() => parseWorkspaceBackup(corrupt((value) => { value.state.drafts[team.id] = [] })), /草稿/)
})

test('restoring a backup creates a downloadable prior snapshot and cannot resume models or permissions', (t) => {
  const original = useCollaboration.getState()
  const oldStart = runtimeClient.start, oldRun = runtimeClient.run
  t.after(() => { useCollaboration.setState(original); runtimeClient.start = oldStart; runtimeClient.run = oldRun })
  runtimeClient.start = async () => { assert.fail('restoring must never start a model') }
  runtimeClient.run = async () => { assert.fail('restoring must never resume a model') }
  const current = createWorkspace('conversation', 'grok', 'Before restore')
  useCollaboration.setState({ teams: [current], activeTeamId: current.id, drafts: { [current.id]: 'recover me' },
    attachmentDrafts: {}, runs: {}, taskSchedules: {}, modelDefaults: {}, deletedGalleryKeys: [] })
  const imported = createWorkspace('project', 'grok', 'Imported')
  imported.permissionMode = 'auto'
  imported.messages.push({ id: 'source', author: 'you', text: 'Stopped at backup time', to: 'all', kind: 'message', sample: false, time: '10:00',
    runId: 'old-run', sessionId: 'old-provider-session', status: 'needs_permission', toolPermission: {
      id: 'permission', employeeId: imported.members[0].id, title: 'Write', detail: 'result.txt', createdAt: '', status: 'pending', options: [] } })
  const backup = createWorkspaceBackup({ teams: [imported], activeTeamId: imported.id, drafts: {}, attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok', deletedGalleryKeys: [] })
  useCollaboration.getState().restoreWorkspaceBackup(backup)
  const state = useCollaboration.getState(), restored = state.teams[0]
  assert.equal(parseWorkspaceBackup(state.previousWorkspaceBackup!).drafts[current.id], 'recover me')
  assert.equal(restored.permissionMode, 'ask')
  assert.equal(restored.messages[0].status, 'cancelled')
  assert.equal(restored.messages[0].toolPermission?.status, 'cancelled')
  assert.equal(restored.messages[0].runId, 'restored-history:old-run')
  assert.equal(restored.messages[0].sessionId, undefined)
  assert.deepEqual(state.runs, {})
  assert.deepEqual(state.taskSchedules, {})
  resumeRuns()
  reconnectRun(restored.messages[0].runId!)
  assert.deepEqual(useCollaboration.getState().runs, {})
  useCollaboration.setState({ taskSchedules: { [restored.id]: { remaining: [], status: 'running' } } })
  assert.throws(() => useCollaboration.getState().restoreWorkspaceBackup(backup), /先停止/)
  assert.equal(useCollaboration.getState().teams[0], restored, 'blocked import must keep the current workspace untouched')
  useCollaboration.setState({ taskSchedules: {} })
  assert.throws(() => useCollaboration.getState().restoreWorkspaceBackup('{}'), /格式/)
  assert.equal(useCollaboration.getState().teams[0], restored)
})

test('backup history keeps each tool approval with its reply, task result and receipt while rejecting malformed display fields', () => {
  const team = createWorkspace('conversation', 'grok')
  const author = team.members[0].id
  team.artifacts.push({ id: 'result', name: 'result.md', owner: author, description: '', content: 'accepted output', format: 'md', version: 1, sample: false })
  team.tasks.push({ id: 'task', title: 'Finished task', description: '', owner: author, state: 'done', dependency: null, acceptance: '', resultRunId: 'second-run', acceptedRunId: 'second-run' })
  for (const runId of ['first-run', 'second-run']) {
    team.messages.push({ id: `${runId}-reply`, runtimeReplyId: `${runId}-runtime-reply`, runId, author, to: 'all', text: `Output for ${runId}`, time: '', kind: 'message', sample: false, status: 'completed',
      taskId: 'task', artifactId: 'result', receipt: { filesModified: ['result.md'], commands: [{ command: 'node --test', exitCode: 0, summary: 'passed' }] } })
    team.messages.push({ id: `${runId}-permission`, runId, author, to: 'all', text: 'Approved', time: '', kind: 'decision', sample: false, status: 'completed',
      toolPermission: { id: 'same-permission-id', replyId: `${runId}-runtime-reply`, employeeId: author, title: 'Write', detail: '{}', status: 'answered', createdAt: '', resolvedAt: '2026-10-11T10:00:00Z', optionId: 'custom', optionLabel: 'Custom approval', options: [] } })
  }
  const text = createWorkspaceBackup({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok', deletedGalleryKeys: [] })
  const restored = parseWorkspaceBackup(text).teams[0]
  const feed = conversationFeed(restored.messages)
  assert.equal(feed.length, 2)
  assert.equal(feed[0].toolMessages[0].id, 'first-run-permission')
  assert.equal(feed[1].toolMessages[0].id, 'second-run-permission')
  assert.equal(restored.tasks[0].acceptedRunId, feed[1].runId)
  assert.equal(restored.tasks[0].resultRunId, feed[1].runId)
  assert.equal(feed[1].artifactId, restored.artifacts[0].id)
  assert.deepEqual(feed[1].receipt, team.messages[2].receipt)
  const again = parseWorkspaceBackup(createWorkspaceBackup({ teams: [restored], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok', deletedGalleryKeys: [] }))
  assert.equal(again.teams[0].messages[0].runId, feed[0].runId, 'repeated backup cycles keep history identities stable')
  for (const key of ['optionId', 'optionLabel', 'replyId', 'resolvedAt']) {
    const malformed = JSON.parse(text)
    malformed.state.teams[0].messages[1].toolPermission[key] = { bad: 'object' }
    assert.throws(() => parseWorkspaceBackup(JSON.stringify(malformed)), /审批记录/)
  }
  const badReceipt = JSON.parse(text)
  badReceipt.state.teams[0].messages[0].receipt.commands = { bad: 'not-an-array' }
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(badReceipt)), /执行记录/)
})

test('replacing a workspace discards late start and polling results from the previous workspace', async (t) => {
  const original = useCollaboration.getState(), methods = { start: runtimeClient.start, cancel: runtimeClient.cancel, run: runtimeClient.run }
  t.after(() => { useCollaboration.setState(original); Object.assign(runtimeClient, methods) })
  for (const outcome of ['completed', 'rejected'] as const) {
    const team = createWorkspace('conversation', 'grok')
    useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: { [team.id]: 'restored draft' }, attachmentDrafts: {}, runs: {}, taskSchedules: {}, modelDefaults: {}, deletedGalleryKeys: [] })
    const backup = createWorkspaceBackup(useCollaboration.getState())
    let request!: RunRequest, resolve!: (value: RunSnapshot) => void, reject!: (error: Error) => void
    runtimeClient.start = async (value) => { request = value; return new Promise((yes, no) => { resolve = yes; reject = no }) }
    const stopped = (): RunSnapshot => ({ id: request.id, workspaceId: team.id, status: 'cancelled', createdAt: '', permissions: [], replies: [], contextTrimmed: false })
    runtimeClient.cancel = async () => stopped()
    runtimeClient.run = async () => { assert.fail('the replaced start must not initiate a recovery poll') }
    const sending = useCollaboration.getState().send(team.id, 'all')
    await useCollaboration.getState().stop(request.id)
    useCollaboration.getState().restoreWorkspaceBackup(backup)
    if (outcome === 'completed') resolve({ ...stopped(), status: 'completed', replies: [{ employeeId: team.members[0].id, provider: 'grok', model: 'fixture', text: 'old result', status: 'completed' }] })
    else reject(new Error('old request failed'))
    await sending
    assert.deepEqual(useCollaboration.getState().teams[0].messages, [])
    assert.deepEqual(useCollaboration.getState().runs, {})
    assert.deepEqual(useCollaboration.getState().connectionErrors, {})
    assert.equal(useCollaboration.getState().drafts[team.id], 'restored draft')

    useCollaboration.setState({ runs: { [request.id]: stopped() } })
    runtimeClient.run = async () => new Promise((yes) => { resolve = yes })
    const polling = refreshRun(request.id)
    useCollaboration.getState().restoreWorkspaceBackup(backup)
    resolve({ ...stopped(), status: 'completed', replies: [{ employeeId: team.members[0].id, provider: 'grok', model: 'fixture', text: 'old polled output', status: 'completed' }] })
    assert.equal(await polling, null)
    assert.deepEqual(useCollaboration.getState().teams[0].messages, [])
    assert.deepEqual(useCollaboration.getState().runs, {})
  }
})

test('an image upload started before restore cannot create a gallery conversation or send a model prompt afterward', async (t) => {
  const original = useCollaboration.getState(), oldUpload = runtimeClient.upload, oldStart = runtimeClient.start
  t.after(() => { useCollaboration.setState(original); runtimeClient.upload = oldUpload; runtimeClient.start = oldStart })
  const team = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, runs: {}, taskSchedules: {}, modelDefaults: {}, deletedGalleryKeys: [] })
  const backup = createWorkspaceBackup(useCollaboration.getState())
  let finish!: (file: { id: string; name: string; path: string; size: number; mime: string }) => void
  let uploaded!: () => void
  const started = new Promise<void>((resolve) => { uploaded = resolve })
  runtimeClient.upload = async () => { uploaded(); return new Promise((resolve) => { finish = resolve }) }
  runtimeClient.start = async () => { assert.fail('restore must invalidate an unfinished image upload before it sends a prompt') }
  const operation = useCollaboration.getState().generateImages('edit fixture', 'grok', 'auto', 1, {
    id: 'original', keys: [], image: { dataUrl: 'data:image/png;base64,AA==' }, workspaceId: team.id,
    workspaceName: team.name, prompt: '', provider: 'grok', createdAt: '' })
  await started
  useCollaboration.getState().restoreWorkspaceBackup(backup)
  finish({ id: 'upload', name: 'original.png', path: 'I:/original.png', size: 1, mime: 'image/png' })
  await operation
  assert.equal(useCollaboration.getState().teams.length, 1)
  assert.equal(useCollaboration.getState().teams[0].id, team.id)
  assert.deepEqual(useCollaboration.getState().attachmentDrafts, {})
  assert.deepEqual(useCollaboration.getState().runs, {})
})

test('large imported image alias chains deduplicate without recursion overflow and preserve deletion aliases', () => {
  const team = createWorkspace('conversation', 'grok')
  team.messages.push({ id: 'images', author: team.members[0].id, to: 'all', text: 'A history of the same image', kind: 'message', sample: false, time: '',
    images: Array.from({ length: 12000 }, (_, index) => ({ path: `images/image-${index}.png`, sourcePath: `images/image-${index - 1}.png` })) })
  const backup = createWorkspaceBackup({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, modelDefaults: {}, defaultProvider: 'grok', deletedGalleryKeys: [] })
  const restored = parseWorkspaceBackup(backup)
  const gallery = collectGalleryImages(restored.teams)
  assert.equal(gallery.length, 1)
  assert.equal(gallery[0].keys.length, 12001)
  assert.equal(collectGalleryImages(restored.teams, {}, [`${team.id}/images/image-0.png`]).length, 0)
})

test('file permission cards show readable file details inside the conversation with long content collapsed', () => {
  const permission = { id: 'write', employeeId: 'grok', title: "Write 'I:\\code\\test\\portrait.md'", createdAt: new Date().toISOString(), status: 'pending' as const,
    detail: JSON.stringify({ file_path: 'I:\\code\\test\\portrait.md', content: '第一行\n第二行\n' + '长内容'.repeat(2000) }),
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No, and tell Grok what to do differently' }] }
  const display = permissionDisplay(permission)
  assert.equal(display.path, 'I:\\code\\test\\portrait.md')
  assert.match(display.content!, /第一行\n第二行/)
  assert.equal(permissionOptionLabel(permission.options[0]), '允许本次')
  assert.equal(permissionOptionLabel(permission.options[1]), '拒绝本次')
  const html = renderToStaticMarkup(createElement(PermissionMessage, { permission, pending: true, onAnswer: async () => assert.fail('rendering must not approve a tool') }))
  assert.match(html, /permission-message/)
  assert.match(html, /允许本次/)
  assert.match(html, /查看写入内容/)
  assert.doesNotMatch(html, /<details[^>]*\sopen|<dialog|role="dialog"|runtime-permission/)
  const resolved = renderToStaticMarkup(createElement(PermissionMessage, { permission: { ...permission, status: 'answered', optionId: 'no', optionLabel: 'No' }, pending: false, onAnswer: async () => {} }))
  assert.match(resolved, /拒绝本次/)
  assert.doesNotMatch(resolved, /<button/)
})

test('inline permission history is positioned after its employee reply, deduplicated and retains the decision after completion', () => {
  const team = createWorkspace('conversation', 'grok')
  const lead = team.members[0]
  useCollaboration.setState({ teams: [team], runs: {}, activeTeamId: team.id })
  const permission = { id: 'approval', employeeId: lead.id, replyId: 'worker-reply', title: 'Write', detail: '{"content":"private full text","file_path":"I:/test/result.md"}',
    createdAt: new Date().toISOString(), status: 'pending' as const, options: [{ id: 'allow', label: 'Yes' }] }
  const snapshot: RunSnapshot = { id: 'operation-run', workspaceId: team.id, revision: 1, status: 'needs_permission', permissions: [permission],
    permissionHistory: [permission], createdAt: permission.createdAt, contextTrimmed: false,
    replies: [{ id: 'worker-reply', employeeId: lead.id, employeeName: '原员工名称', provider: 'grok', model: 'model', text: '正在写入结果', status: 'running' }] }
  useCollaboration.getState().applyRun(snapshot)
  let messages = useCollaboration.getState().teams[0].messages
  assert.equal(messages.length, 2)
  assert.equal(messages[0].id, 'worker-reply')
  assert.equal(messages[1].toolPermission?.status, 'pending')
  useCollaboration.getState().applyRun({ ...snapshot, revision: 2 })
  assert.equal(useCollaboration.getState().teams[0].messages.length, 2)
  useCollaboration.getState().applyRun({ ...snapshot, revision: 3, status: 'completed', permissions: [],
    replies: snapshot.replies.map((reply) => ({ ...reply, status: 'completed', text: '文件已经完成' })),
    permissionHistory: [{ ...permission, status: 'answered', optionId: 'allow', optionLabel: 'Yes' }] })
  const saved = useCollaboration.getState().teams[0]
  assert.ok(isValidTeam(JSON.parse(JSON.stringify(saved))))
  messages = saved.messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].toolPermission?.status, 'answered')
  assert.match(messages[1].text, /允许本次/)
  assert.doesNotMatch(JSON.stringify(collaborationContext(saved, undefined, messages)), /private full text/)
  useCollaboration.getState().deleteMessage(team.id, messages[1].id)
  assert.equal(useCollaboration.getState().teams[0].messages.length, 1)
  assert.ok(!useCollaboration.getState().teams[0].deletedMessageIds?.includes(`${snapshot.id}-${lead.id}`), 'deleting a permission must not hide the employee reply')
  useCollaboration.getState().applyRun({ ...snapshot, revision: 4, status: 'completed', permissions: [],
    permissionHistory: [{ ...permission, id: 'legacy-history', replyId: undefined, status: 'cancelled' }] })
  const restored = useCollaboration.getState().teams[0].messages
  assert.equal(restored.length, 2)
  assert.equal(restored[0].id, 'worker-reply')
  assert.equal(restored[1].toolPermission?.replyId, 'worker-reply')
})

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII='
const dataUrl = `data:image/png;base64,${png}`

test('Enter submits once but never sends while confirming Chinese input', () => {
  let sent = 0, prevented = 0
  const event = { key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: () => prevented++ }
  const dispatch = (overrides = {}) => handleComposerEnter({ ...event, ...overrides } as Parameters<typeof handleComposerEnter>[0], () => {}, () => sent++)
  assert.equal(dispatch(), true)
  assert.equal(sent, 1)
  dispatch({ repeat: true })
  dispatch({ nativeEvent: { isComposing: true, keyCode: 13 } })
  dispatch({ nativeEvent: { isComposing: false, keyCode: 229 } })
  dispatch({ shiftKey: true })
  assert.equal(sent, 1)
  assert.equal(prevented, 2)
})

test('Ctrl+Enter replaces the selection with a newline and restores the caret without sending', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const frames: FrameRequestCallback[] = []
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original)
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  })
  let sent = 0, caret = -1
  const input = { value: '前面选中后面', selectionStart: 2, selectionEnd: 4, maxLength: 8000, isConnected: true,
    setSelectionRange: (start: number, end: number) => { assert.equal(start, end); caret = start } }
  const event = { key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: false, keyCode: 13 }, currentTarget: input, preventDefault: () => {} }
  const dispatch = () => handleComposerEnter(event as unknown as Parameters<typeof handleComposerEnter>[0], (value) => { input.value = value }, () => sent++)
  dispatch()
  assert.equal(input.value, '前面\n后面')
  frames[0](0)
  assert.equal(caret, 3)
  assert.equal(sent, 0)
  input.selectionStart = input.selectionEnd = input.value.length
  input.maxLength = input.value.length
  dispatch()
  assert.equal(input.value, '前面\n后面', 'newline must respect the input length limit')
})

test('gallery collects assistant images, deduplicates saved aliases and keeps workspace identity', () => {
  const team = createWorkspace('conversation', 'grok')
  team.messages = [
    { id: 'u', author: 'you', text: `画一座森林 ![参考](${dataUrl})`, to: team.members[0].id, time: '10:00', kind: 'message', sample: false },
    { id: 'a', author: team.members[0].id, text: '![森林](images/forest.png)', images: [{ path: '/saved/forest.png', sourcePath: 'images/forest.png' }, { dataUrl }], sourceMessageId: 'u', to: 'all', time: '10:01', kind: 'message', sample: false },
    { id: 'sample', author: team.members[0].id, text: '![示例](/sample.png)', to: 'all', time: '10:02', kind: 'message', sample: true }
  ]
  const second = createWorkspace('conversation', 'codex')
  second.messages = [{ ...team.messages[1], author: second.members[0].id, images: [{ path: 'images/forest.png' }] }]
  const items = collectGalleryImages([team, second])
  assert.equal(items.length, 3)
  assert.equal(items.filter((item) => item.workspaceId === team.id).length, 2)
  assert.equal(items.find((item) => item.workspaceId === team.id)?.prompt, team.messages[0].text)
  const stable = items.find((item) => item.workspaceId === team.id)!.id
  assert.equal(collectGalleryImages([team]).find((item) => item.workspaceId === team.id)!.id, stable)
  assert.equal(collectGalleryImages([{ ...team, sample: true }]).length, 0)
})

test('gallery generation preserves other drafts and defaults and persists generation settings', async (t) => {
  const previous = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [previous], activeTeamId: previous.id, defaultProvider: 'grok', drafts: { [previous.id]: '未发送草稿' }, runs: {}, modelDefaults: { codex: { model: 'test-model' } } })
  let request: RunRequest | undefined
  t.mock.method(runtimeClient, 'start', async (input: RunRequest) => {
    request = input
    return { id: input.id, workspaceId: input.workspaceId, status: 'completed', replies: [], permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false } as RunSnapshot
  })
  await useCollaboration.getState().generateImages('水彩森林', 'codex', '2:3', 4)
  const state = useCollaboration.getState(), created = state.teams.at(-1)!
  assert.equal(state.page, 'gallery')
  assert.equal(state.defaultProvider, 'grok')
  assert.equal(state.activeTeamId, previous.id)
  assert.equal(state.drafts[previous.id], '未发送草稿')
  assert.equal(request?.employees[0].provider, 'codex')
  assert.equal(request?.employees[0].model, 'test-model')
  assert.match(request!.prompt, /4 张独立图片，宽高比 2:3/)
  assert.equal(created.gallery?.prompt, '水彩森林')
  assert.equal(isValidTeam(JSON.parse(JSON.stringify(created))), true)
  await useCollaboration.getState().generateImages('无效数量', 'grok', 'auto', 100)
  assert.equal(useCollaboration.getState().teams.length, 2)
})

test('streaming persistence coalesces snapshots and flushes the complete reply immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: string[] = []
  const storage = batchedStorage<{ text: string; running: boolean }>({
    getItem: () => null,
    setItem: (_key, value) => { writes.push(value.state.text) },
    removeItem: () => {}
  }, (state) => state.running)
  const save = (text: string, running = true) => storage.setItem('chat', { state: { text, running } })
  save('first')
  save('latest')
  assert.deepEqual(writes, [])
  assert.equal((storage.getItem('chat') as any).state.text, 'latest')
  t.mock.timers.tick(500)
  assert.deepEqual(writes, ['latest'])
  save('partial')
  save('complete', false)
  assert.deepEqual(writes, ['latest', 'complete'])
  t.mock.timers.tick(500)
  assert.deepEqual(writes, ['latest', 'complete'], 'no stale timer overwrites the completed reply')
  save('before closing')
  storage.flush()
  assert.equal(writes.at(-1), 'before closing')
  save('deleted')
  storage.removeItem('chat')
  t.mock.timers.tick(500)
  assert.equal(writes.at(-1), 'before closing', 'removed state must not be resurrected')
})

test('failed local saves retain the draft and recovery clears the warning, including an explicit retry', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map<string, string>()
  let fail = false
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => { if (fail) throw new Error('Storage quota exceeded'); saved.set(key, value) },
    removeItem: (key: string) => saved.delete(key)
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const team = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, runs: {}, storageError: false })
  const state = () => useCollaboration.getState()
  const diskDraft = () => JSON.parse(saved.get('grok-desktop-collaboration-ui-v1')!).state.drafts[team.id]
  fail = true
  state().setDraft(team.id, 'unsaved work')
  await Promise.resolve()
  assert.equal(state().storageError, true)
  assert.equal(state().drafts[team.id], 'unsaved work')
  assert.equal(diskDraft(), undefined)
  assert.equal(parseWorkspaceBackup(createWorkspaceBackup(state())).drafts[team.id], 'unsaved work', 'export reads the unsaved in-memory draft')
  fail = false
  state().setDraft(team.id, 'saved after recovery')
  await Promise.resolve()
  assert.equal(state().storageError, false)
  assert.equal(diskDraft(), 'saved after recovery')

  fail = true
  state().setDraft(team.id, 'retry without editing')
  await Promise.resolve()
  assert.equal(state().storageError, true)
  fail = false
  state().retryStorage()
  await Promise.resolve()
  assert.equal(state().storageError, false)
  assert.equal(diskDraft(), 'retry without editing')

  // A queued failure notification must not overwrite the success of a newer write.
  fail = true
  state().setDraft(team.id, 'transient failure')
  fail = false
  state().setDraft(team.id, 'latest successful write')
  await Promise.resolve()
  assert.equal(state().storageError, false)
  assert.equal(diskDraft(), 'latest successful write')
})

test('image replies hide the legacy tool preamble but retain descriptions and failures', () => {
  const description = '画面是一位成年中国女大学生风格的时尚写真：校园图书馆暖光。'
  const preamble = '先读取图片生成技能，再按规范实际调用工具生成这张写真。正在生成一张成年中国女大学生风格的写真照片。写真已生成，可直接查看：\n\n'
  assert.equal(imageReplyBody(preamble + description, true), description)
  assert.equal(imageReplyBody(preamble + description, false), preamble + description)
  for (const text of ['图片生成失败，请重试。', '如何调用工具：先读取图片生成技能。', '这张图片展示了工具调用流程。', '```\n先读取图片生成技能。\n```'])
    assert.equal(imageReplyBody(text, true), text)
})

test('uploads preserve bytes, isolate duplicate names, identify images and reject invalid paths and oversized files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-upload-test-'))
  try {
    const first = await uploadAttachment(dir, { name: '参考图.png', data: png })
    const second = await uploadAttachment(dir, { name: '参考图.png', data: png })
    assert.notEqual(first.path, second.path)
    assert.equal(first.mime, 'image/png')
    assert.equal(fs.readFileSync(first.path).toString('base64'), png)
    assert.equal(previewWorkspaceImage(dir, first.path).dataUrl, dataUrl)
    const svg = await uploadAttachment(dir, { name: 'diagram.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" /></svg>').toString('base64') })
    assert.equal(svg.mime, 'image/svg+xml')
    assert.equal(resolveAttachments(dir, [svg])[0].mime, 'image/svg+xml')
    assert.equal(previewWorkspaceImage(dir, svg.path).kind, 'image')
    const plain = await uploadAttachment(dir, { name: 'empty.txt', data: '' })
    assert.equal(plain.size, 0)
    assert.equal(resolveAttachments(dir, [{ ...plain, mime: 'image/png' }])[0].mime, 'application/octet-stream')
    assert.throws(() => resolveAttachments(dir, [{ ...first, path: path.resolve('resources/icon.png') }]), /当前对话/)
    await assert.rejects(uploadAttachment(dir, { name: '../outside.png', data: png }), /附件无效/)
    await assert.rejects(uploadAttachment(dir, { name: 'bad.png', data: 'not base64!' }), /附件无效/)
    await assert.rejects(uploadAttachment(dir, { name: 'big.txt', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), /8 MB/)
    assert.throws(() => resolveAttachments(dir, Array(6).fill(first)), /5 个/)
    fs.unlinkSync(first.path)
    assert.throws(() => resolveAttachments(dir, [first]))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('image-only sends and retries retain attachments; avatars persist but never enter model requests', async () => {
  const team = createWorkspace('conversation', 'grok')
  const lead = team.members[0]
  lead.avatar = dataUrl
  const file = { id: 'upload-1', name: 'image.png', path: '/workspace/attachments/image.png', size: 64, mime: 'image/png' }
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {}, runs: {} })
  useCollaboration.getState().addAttachments(team.id, [file])
  let sent!: RunRequest
  let snapshot!: RunSnapshot
  runtimeClient.start = async (request) => {
    sent = request
    snapshot = { id: request.id, workspaceId: team.id, status: 'completed', permissions: [], createdAt: '', contextTrimmed: false,
      replies: [{ employeeId: lead.id, provider: 'grok', model: 'test', text: 'seen', status: 'completed' }] }
    return snapshot
  }
  runtimeClient.run = async () => snapshot
  await useCollaboration.getState().send(team.id, lead.id)
  assert.equal(sent.prompt, '请查看并分析附件。')
  assert.deepEqual(sent.attachments, [file])
  assert.equal('avatar' in sent.employees[0], false)
  assert.deepEqual(useCollaboration.getState().attachmentDrafts[team.id], [])
  const saved = useCollaboration.getState().teams[0]
  assert.equal(isValidTeam(saved), true)
  assert.equal(saved.members[0].avatar, dataUrl)
  assert.deepEqual(saved.messages[0].attachments, [file])
  assert.match(collaborationContext(saved, undefined, saved.messages).context[0].text, /image.png/)
  await useCollaboration.getState().retryMessage(team.id, saved.messages[0].id)
  assert.deepEqual(sent.attachments, [file])
  assert.equal(isValidTeam({ ...saved, members: [{ ...lead, avatar: 'javascript:bad' }] }), false)
  const restored = useCollaboration.persist.getOptions().merge!({ teams: [saved], attachmentDrafts: { [team.id]: [file] } }, useCollaboration.getState()) as ReturnType<typeof useCollaboration.getState>
  assert.equal(restored.teams[0].members[0].avatar, dataUrl)
  assert.deepEqual(restored.attachmentDrafts[team.id], [file])
})
test('all provider image payloads reach the same image representation', () => {
  const fixtures = [
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: png } },
    { type: 'imageGeneration', status: 'completed', result: png },
    { type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'image', mimeType: 'image/png', data: png }] } },
    { type: 'functionCallOutput', output: [{ type: 'input_image', image_url: dataUrl }] },
    { type: 'dynamicToolCall', contentItems: [{ type: 'inputImage', imageUrl: dataUrl }] },
    { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] },
    { type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
    { data: [{ b64_json: png }] },
    { type: 'resource', resource: { mimeType: 'image/png', blob: png } }
  ]
  for (const fixture of fixtures) assert.equal(extractMediaFromContent(fixture)[0]?.dataUrl, dataUrl, JSON.stringify(fixture))
  assert.equal(extractMediaFromContent({ type: 'imageGeneration', result: '', savedPath: 'C:/images/test.png' })[0].path, 'C:/images/test.png')
  assert.deepEqual(extractMediaFromContent({ type: 'tool_use', input: { path: '/not-output.png' } }), [])
  assert.deepEqual(extractMediaFromContent({ type: 'imageGeneration', status: 'failed', result: png }), [])
})

test('signed image links render once, preserve their query, and reject executable URLs', () => {
  const url = 'https://example.com/render?id=123&token=test'
  assert.equal(extractMediaFromText(`![生成图片](${url})`)[0].path, url)
  assert.equal(stripDisplayedMedia(`说明\n![生成图片](${url})`), '说明')
  assert.equal(extractMediaFromText('![图](https://example.com/a.png?token=test)').length, 1)
  assert.deepEqual(extractMediaFromText('![坏图](javascript:evil.png)'), [])
  assert.equal(extractMediaFromText(JSON.stringify({ data: [{ b64_json: png }] }))[0].dataUrl, dataUrl)
})

test('binary images persist as files and workspace preview refuses paths outside the workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-chat-media-'))
  try {
    const images = collectRunImages({ type: 'image', data: png, mimeType: 'image/png' }, dir)
    assert.equal(images.length, 1)
    assert.equal(images[0].dataUrl, undefined)
    assert.equal(fs.readFileSync(images[0].path!).toString('base64'), png)
    assert.equal(previewWorkspaceImage(dir, images[0].path!).dataUrl, dataUrl)
    assert.equal(collectRunImages({ type: 'image', data: png, mimeType: 'image/png' }, dir)[0].path, images[0].path)
    assert.throws(() => previewWorkspaceImage(dir, path.resolve('resources/icon.png')), /工作空间/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('enabled skills are directly available; disabling a skill never grants tool approval', () => {
  const skill = { name: 'imagegen', path: path.resolve('skills/imagegen/SKILL.md'), body: 'Use the image tool.', description: 'Generate images', disabled: false } as SkillInfo
  assert.match(skillInstructions([skill]), /Use the image tool/)
  assert.ok(isAutomaticSkillUse('Skill', { skill: 'imagegen' }, [skill]))
  assert.ok(isAutomaticSkillUse('Read', { file_path: skill.path }, [skill]))
  assert.ok(isAutomaticSkillUse(`Get-Content "${skill.path}"`, {}, [skill]))
  assert.equal(isAutomaticSkillUse(`Get-Content "${skill.path}"; Remove-Item anything`, {}, [skill]), false)
  assert.equal(isAutomaticSkillUse(`Get-Content "${skill.path}"`, {}, [{ ...skill, disabled: true }]), false)
  assert.equal(isAutomaticSkillUse('Bash', { command: 'anything' }, [skill]), false)
  assert.equal(isAutomaticSkillUse('Skill', { skill: 'imagegen' }, [{ ...skill, disabled: true }]), false)
  assert.doesNotMatch(skillInstructions([{ ...skill, disabled: true }]), /Use the image tool/)
  assert.ok(isRequestedImageTool('imagine: circle', { variant: 'ImageGen' }, '生成一张简单图片'))
  assert.equal(isRequestedImageTool('imagine', { variant: 'ImageGen' }, '读取我的文件'), false)
  assert.equal(isRequestedImageTool('Bash', { command: 'anything' }, '生成图片'), false)
  assert.ok(isRequestedImageTool('imagine: edit photo', { variant: 'ImageEdit' }, '衣服换成jk', true))
  assert.ok(isRequestedImageTool('image_edit', {}, '把这张图片的背景换成海边'))
  assert.ok(isRequestedImageTool('imagine', { variant: 'ImageEdit' }, 'replace the outfit with a jacket', true))
  assert.equal(isRequestedImageTool('imagine', {}, '分析一下图片', true), false)
  assert.equal(isRequestedImageTool('imagine', {}, '衣服换成jk'), false)
  assert.equal(isRequestedImageTool('Bash', { variant: 'ImageGen' }, '生成图片'), false)
  assert.equal(isRequestedImageTool('imagine', { variant: 'VideoGen' }, '生成图片'), false)
})

test('resend, regenerate and delete preserve message identity and shared history', async () => {
  const team = createWorkspace('conversation', 'grok')
  const lead = team.members[0]
  team.messages = [
    { id: 'first', author: 'you', text: '之前的需求', to: lead.id, time: '', kind: 'message', sample: false },
    { id: 'old-reply', author: lead.id, text: '所有人可见', to: 'all', private: false, time: '', kind: 'message', sample: false },
    { id: 'source', author: 'you', text: '原始需求', to: lead.id, time: '', kind: 'message', sample: false, runId: 'original', status: 'completed' },
    { id: 'reply', author: lead.id, text: '旧回复', to: 'all', time: '', kind: 'message', sample: false, runId: 'original', sourceMessageId: 'source', status: 'completed' },
    { id: 'later', author: 'you', text: '不应混入重生成', to: lead.id, time: '', kind: 'message', sample: false }
  ]
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: { [team.id]: '保留未发送草稿' } })
  let sent!: RunRequest
  let snapshot!: RunSnapshot
  runtimeClient.start = async (request) => {
    sent = request
    snapshot = { id: request.id, workspaceId: team.id, createdAt: new Date().toISOString(), status: 'completed', permissions: [], contextTrimmed: false,
      replies: [{ employeeId: lead.id, provider: 'grok', model: 'test', text: '新回复', status: 'completed', images: [{ path: '/images/result.png' }] }] }
    return snapshot
  }
  runtimeClient.run = async () => snapshot
  const state = () => useCollaboration.getState()
  await state().retryMessage(team.id, 'reply')
  assert.equal(sent.prompt, '原始需求')
  assert.equal(sent.context.length, 1)
  assert.equal(sent.context[0].text, '所有人可见')
  assert.equal(sent.privateContext?.[0].text, '之前的需求')
  assert.equal(state().teams[0].messages.length, 5)
  assert.equal(state().teams[0].messages.find((m) => m.id === 'reply')?.text, '新回复')
  assert.equal(state().drafts[team.id], '保留未发送草稿')
  state().deleteMessage(team.id, 'reply')
  state().applyRun({ ...snapshot, error: 'late update' })
  assert.equal(state().teams[0].messages.some((m) => m.author === lead.id && m.runId === snapshot.id), false)
  await state().retryMessage(team.id, 'source')
  assert.equal(state().teams[0].messages.filter((m) => m.id === 'source').length, 1)
  assert.equal(sent.prompt, '原始需求')
  state().deleteMessage(team.id, 'source')
  await state().retryMessage(team.id, `${snapshot.id}-${lead.id}`)
  assert.match(state().runtimeError!, /原始用户消息已删除/)
})

test('editing replaces the following branch immediately and regenerates with the original attachments and recipients', async (t) => {
  const team = createWorkspace('conversation', 'grok')
  const lead = team.members[0]
  const second = { ...lead, id: 'second', name: '第二位员工', isLead: false }
  team.members.push(second)
  const attachment = { id: 'reference', name: 'reference.png', path: '/uploads/reference.png', size: 20, mime: 'image/png' }
  team.messages = [
    { id: 'first', author: 'you', text: '保留的历史', to: 'all', time: '', kind: 'message', sample: false },
    { id: 'source', author: 'you', text: '原始需求', to: 'all', time: '10:00', kind: 'message', sample: false, runId: 'original', status: 'completed', attachments: [attachment] },
    { id: 'reply', author: lead.id, text: '旧回复', to: 'all', time: '', kind: 'message', sample: false, runId: 'original', sourceMessageId: 'source', status: 'completed', images: [{ path: '/old-image.png' }] },
    { id: 'second-reply', author: second.id, text: '另一条旧回复', to: 'all', time: '', kind: 'message', sample: false, runId: 'original', sourceMessageId: 'source', status: 'completed' },
    { id: 'later', author: 'you', text: '后续问题', to: lead.id, time: '', kind: 'message', sample: false, runId: 'later-run', status: 'completed' },
    { id: 'later-reply', author: lead.id, text: '后续旧回复', to: 'all', time: '', kind: 'message', sample: false, runId: 'later-run', sourceMessageId: 'later', status: 'completed' }
  ]
  const other = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team, other], runs: {}, drafts: { [team.id]: '未发送草稿' }, attachmentDrafts: { [team.id]: [attachment] } })
  const state = () => useCollaboration.getState()
  let sent!: RunRequest, snapshot!: RunSnapshot, finish!: (run: RunSnapshot) => void, starts = 0
  t.mock.method(runtimeClient, 'start', async (request: RunRequest) => {
    sent = request
    starts++
    return new Promise<RunSnapshot>((resolve) => { finish = resolve })
  })
  t.mock.method(runtimeClient, 'run', async () => snapshot)
  const editing = state().editMessage(team.id, 'source', '  修改后的需求  ')
  assert.equal(starts, 1)
  assert.deepEqual(state().teams[0].messages.map((m) => m.id), ['first', 'source'])
  assert.equal(state().teams[0].messages[1].text, '修改后的需求')
  assert.equal(state().teams[0].messages[1].status, 'queued')
  assert.deepEqual(state().teams[0].messages[1].attachments, [attachment])
  assert.deepEqual(state().teams[1], other)
  assert.equal(sent.prompt, '修改后的需求')
  assert.deepEqual(sent.attachments, [attachment])
  assert.deepEqual(sent.employees.map((e) => e.id), [lead.id, second.id])
  assert.deepEqual(sent.context.map((entry) => entry.text), ['保留的历史'])
  assert.equal(state().drafts[team.id], '未发送草稿')
  assert.deepEqual(state().attachmentDrafts[team.id], [attachment])
  await state().editMessage(team.id, 'source', '重复提交')
  assert.equal(starts, 1, 'an in-flight edit cannot be submitted twice')
  snapshot = { id: sent.id, workspaceId: team.id, createdAt: new Date().toISOString(), status: 'completed', permissions: [], contextTrimmed: false,
    replies: [lead, second].map((employee) => ({ employeeId: employee.id, provider: employee.provider, model: 'test', text: '重新生成的回复', status: 'completed' })) }
  finish(snapshot)
  await editing
  assert.equal(state().teams[0].messages.length, 4)
  assert.ok(state().teams[0].messages.slice(2).every((m) => m.text === '重新生成的回复' && m.sourceMessageId === 'source'))
  assert.equal(collectGalleryImages(state().teams).length, 0, 'discarded generated images disappear from the gallery')
  // Message tombstones survive persistence, even without the in-memory run cache.
  useCollaboration.setState({ teams: JSON.parse(JSON.stringify(state().teams)), runs: {} })
  state().applyRun({ ...snapshot, id: 'original', revision: 99, replies: snapshot.replies.map((r) => ({ ...r, text: '迟到的旧回复' })) })
  state().applyRun({ ...snapshot, id: 'later-run', revision: 99, replies: [snapshot.replies[0]] })
  assert.equal(state().teams[0].messages.length, 4, 'late snapshots cannot restore discarded replies')
  assert.ok(isValidTeam(state().teams[0]))
})

test('invalid or paused edits leave the existing conversation untouched', async (t) => {
  const { team } = setupRun('completed')
  const state = () => useCollaboration.getState()
  const before = structuredClone(state().teams[0])
  const start = t.mock.method(runtimeClient, 'start', async () => { throw new Error('must not start') })
  for (const [id, text] of [['user-source', '   '], ['user-source', 'x'.repeat(8001)], ['missing', 'new'], [before.messages[1].id, 'new']])
    await state().editMessage(team.id, id, text)
  assert.deepEqual(state().teams[0], before)
  useCollaboration.setState({ teams: [{ ...before, paused: true }] })
  await state().editMessage(team.id, 'user-source', 'new')
  assert.deepEqual(state().teams[0], { ...before, paused: true })
  assert.match(state().runtimeError!, /暂停/)
  assert.equal(start.mock.callCount(), 0)
})

test('a failed edited request keeps the revised message available to retry without restoring old output', async (t) => {
  const { team } = setupRun('completed')
  const state = () => useCollaboration.getState()
  t.mock.method(runtimeClient, 'start', async () => { throw new Error('模拟发送失败') })
  t.mock.method(runtimeClient, 'run', async () => { throw new Error(RUN_EXPIRED_MESSAGE) })
  await state().editMessage(team.id, 'user-source', '修改后可重试')
  assert.equal(state().teams[0].messages.length, 1)
  assert.equal(state().teams[0].messages[0].text, '修改后可重试')
  assert.equal(state().teams[0].messages[0].status, 'failed')
  assert.equal(state().teams[0].messages[0].error, '模拟发送失败')
})

function setupRun(status: RunSnapshot['status'] = 'running', revision = 1) {
  const team = createWorkspace('conversation', 'grok')
  const run: RunSnapshot = { id: 'recovery-run', workspaceId: team.id, status, revision,
    replies: [{ employeeId: team.members[0].id, provider: 'grok', model: 'test', text: 'partial', status }],
    permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false }
  team.messages.push({ id: 'user-source', author: 'you', text: 'request', time: '', to: team.members[0].id,
    kind: 'message', sample: false, runId: run.id, status })
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: {}, connectionErrors: {} })
  useCollaboration.getState().applyRun(run)
  return { team, run }
}

test('older snapshots never regress terminal state, overwrite text or resurrect permissions', () => {
  const { run } = setupRun('completed', 5)
  useCollaboration.getState().applyRun({ ...run, revision: 3, status: 'needs_permission', replies: [],
    permissions: [{ id: 'old', employeeId: run.replies[0].employeeId, title: 'old', detail: '', options: [] }] })
  assert.equal(useCollaboration.getState().runs[run.id].status, 'completed')
  assert.equal(useCollaboration.getState().runs[run.id].replies[0].text, 'partial')
  assert.deepEqual(useCollaboration.getState().runs[run.id].permissions, [])
})

test('conversation rename persists identity and deletion cancels work without resurrecting late snapshots', async (t) => {
  const { team, run } = setupRun()
  const state = () => useCollaboration.getState()
  assert.equal(state().renameConversation(team.id, '  图片编辑  '), true)
  assert.equal(state().teams[0].name, '图片编辑')
  assert.equal(state().teams[0].messages[0].id, team.messages[0].id)
  assert.equal(state().renameConversation(team.id, ' '), false)
  assert.equal(state().renameConversation(team.id, 'a'.repeat(81)), false)
  useCollaboration.setState({ drafts: { [team.id]: 'draft' }, attachmentDrafts: { [team.id]: [] } })
  let cancels = 0
  t.mock.method(runtimeClient, 'clearAssistant', async (scopeId: string) => ({ profile: { scopeId, name: 'assistant',
    persona: '', addressing: '', style: 'balanced', updatedAt: new Date().toISOString() }, memories: [], commitments: [], revision: 1 }))
  runtimeClient.cancel = async () => {
    cancels++
    return { ...run, revision: 2, status: 'cancelled', permissions: [], replies: run.replies.map((r) => ({ ...r, status: 'cancelled' })) }
  }
  assert.equal(await state().deleteConversation(team.id), true)
  assert.equal(cancels, 1)
  assert.equal(state().teams.length, 1, 'deleting the last conversation leaves a usable empty workspace')
  assert.notEqual(state().activeTeamId, team.id)
  assert.equal(state().drafts[team.id], undefined)
  assert.equal(state().attachmentDrafts[team.id], undefined)
  assert.equal(state().runs[run.id], undefined)
  state().applyRun({ ...run, revision: 9 })
  state().setDraft(team.id, 'late draft')
  state().addAttachments(team.id, [])
  assert.equal(state().runs[run.id], undefined)
  assert.equal(state().drafts[team.id], undefined)
  assert.equal(state().attachmentDrafts[team.id], undefined)
  const project = createWorkspace('project', 'grok')
  useCollaboration.setState({ teams: [...state().teams, project] })
  assert.equal(await state().deleteConversation(project.id), false)
})

test('failed cancellation keeps conversation and partial reply; repeated stop requests are coalesced', async () => {
  const { team, run } = setupRun()
  runtimeClient.cancel = async () => { throw new Error('停止失败，请重试') }
  assert.equal(await useCollaboration.getState().deleteConversation(team.id), false)
  assert.equal(useCollaboration.getState().teams[0].id, team.id)
  assert.equal(useCollaboration.getState().runs[run.id].replies[0].text, 'partial')
  assert.equal(useCollaboration.getState().stoppingRuns[run.id], undefined)
  let resolve!: (value: RunSnapshot) => void
  let calls = 0
  runtimeClient.cancel = async () => { calls++; return new Promise((r) => { resolve = r }) }
  const stopped = useCollaboration.getState().stop(run.id)
  await useCollaboration.getState().stop(run.id)
  assert.equal(calls, 1)
  assert.equal(useCollaboration.getState().stoppingRuns[run.id], true)
  resolve({ ...run, revision: 2, status: 'cancelled', permissions: [], replies: run.replies.map((r) => ({ ...r, status: 'cancelled' })) })
  await stopped
  assert.equal(useCollaboration.getState().runs[run.id].status, 'cancelled')
  assert.equal(useCollaboration.getState().runs[run.id].replies[0].text, 'partial')
})

test('connection failure retains active work; polling coalesces and recovers without resending', async () => {
  const { run } = setupRun()
  let sent = 0
  runtimeClient.start = async () => { sent++; return run }
  runtimeClient.run = async () => { throw new Error('network disconnected') }
  await refreshRun(run.id)
  assert.equal(useCollaboration.getState().runs[run.id].status, 'running')
  assert.match(useCollaboration.getState().connectionErrors[run.id], /重连/)
  let resolve!: (r: RunSnapshot) => void
  let calls = 0
  runtimeClient.run = async () => { calls++; return new Promise((r) => { resolve = r }) }
  const first = refreshRun(run.id), second = refreshRun(run.id)
  assert.equal(calls, 1)
  resolve({ ...run, status: 'completed', revision: 2 })
  await Promise.all([first, second])
  assert.equal(useCollaboration.getState().runs[run.id].status, 'completed')
  assert.equal(useCollaboration.getState().connectionErrors[run.id], undefined)
  assert.equal(sent, 0)
})

test('server-confirmed expired runs stop recovery and preserve partial replies', async () => {
  const { run } = setupRun()
  runtimeClient.run = async () => { throw new Error(RUN_EXPIRED_MESSAGE) }
  await refreshRun(run.id)
  assert.equal(useCollaboration.getState().runs[run.id].status, 'failed')
  assert.equal(useCollaboration.getState().runs[run.id].replies[0].text, 'partial')
})

test('reload resumes assistant-only regeneration and preserves the partial reply', async () => {
  const { run } = setupRun()
  const team = structuredClone(useCollaboration.getState().teams[0])
  team.messages = team.messages.filter((m) => m.author !== 'you')
  let resolve!: (r: RunSnapshot) => void
  runtimeClient.run = async () => new Promise((r) => { resolve = r })
  useCollaboration.setState({ teams: [team], runs: {} })
  resumeRuns()
  assert.equal(useCollaboration.getState().runs[run.id].replies[0].text, 'partial')
  resolve({ ...run, status: 'completed', revision: 2 })
  await refreshRun(run.id)
  assert.equal(useCollaboration.getState().runs[run.id].status, 'completed')
})

test('task execution cannot bypass pause, owner checks, dependencies or invalid task saves', async () => {
  const team = createWorkspace('project', 'grok')
  const owner = team.members[0].id
  team.tasks = [
    { id: 'first', title: 'first', owner, description: '', acceptance: '', state: 'ready', dependency: null },
    { id: 'second', title: 'second', owner, description: '', acceptance: '', state: 'ready', dependency: 'first' }
  ]
  useCollaboration.setState({ teams: [team], runs: {}, drafts: { [team.id]: 'execute' } })
  let sent = 0
  runtimeClient.start = async () => { sent++; throw new Error('should not execute') }
  await useCollaboration.getState().send(team.id, owner, 'second')
  await useCollaboration.getState().send(team.id, 'all', 'first')
  team.paused = true
  await useCollaboration.getState().send(team.id, owner, 'first')
  assert.equal(sent, 0)
  assert.equal(useCollaboration.getState().drafts[team.id], 'execute')
  assert.equal(useCollaboration.getState().saveTask(team.id, { ...team.tasks[0], dependency: 'second' }), false)
  assert.equal(useCollaboration.getState().saveTask(team.id, { ...team.tasks[0], owner: 'missing' }), false)
})

test('project goals and shared deliverables reach child agents within the context budget', () => {
  const parent = createWorkspace('project', 'grok', 'Project', 'keep compatibility')
  parent.artifacts.push({ id: 'artifact', name: 'contract.md', owner: 'you', description: '', format: 'md', version: 1, content: 'shared contract', sample: false })
  const child = createWorkspace('conversation', 'grok', 'Implementation', 'add a feature', parent)
  const context = collaborationContext(child, parent, [])
  assert.match(context.goal, /keep compatibility/)
  assert.match(context.goal, /add a feature/)
  assert.equal(context.artifacts[0].content, 'shared contract')
  const longImage = { id: 'long', author: 'you', text: 'image', to: child.members[0].id, time: '', kind: 'message' as const, sample: false,
    images: [{ path: 'a'.repeat(70000) }] }
  const trimmed = collaborationContext(child, parent, [longImage])
  assert.ok(trimmed.contextTrimmed)
  assert.equal(trimmed.context[0].text, 'image', 'invalid media paths must not discard the user message')
  assert.doesNotMatch(JSON.stringify(trimmed.context), /a{100}/)
})

test('lost start response keeps the run reserved until the server confirms its state', async () => {
  const team = createWorkspace('conversation', 'grok')
  useCollaboration.setState({ teams: [team], runs: {}, drafts: { [team.id]: 'request' }, connectionErrors: {} })
  let sent!: RunRequest, starts = 0, polls = 0
  let resolve!: (value: RunSnapshot) => void
  runtimeClient.start = async (request) => { sent = request; starts++; throw new Error('response lost') }
  runtimeClient.run = async () => {
    if (++polls === 1) throw new Error('disconnected')
    return new Promise((r) => { resolve = r })
  }
  await useCollaboration.getState().send(team.id, team.members[0].id)
  const queued = useCollaboration.getState().runs[sent.id]
  assert.equal(queued.status, 'queued')
  useCollaboration.getState().setDraft(team.id, 'duplicate')
  await useCollaboration.getState().send(team.id, team.members[0].id)
  assert.equal(starts, 1)
  resolve({ ...queued, status: 'completed', revision: 2 })
  await refreshRun(sent.id)
})

test('an old cancellation response cannot reset the task owned by a newer run', () => {
  const { run } = setupRun('cancelled', 2)
  const team = structuredClone(useCollaboration.getState().teams[0])
  const task = { id: 'task', title: 'task', owner: team.members[0].id, state: 'working' as const, dependency: null, description: '', acceptance: '' }
  team.tasks = [task]
  team.messages[0].taskId = task.id
  team.messages.push({ ...team.messages[0], id: 'new-source', runId: 'new-run', status: 'running' })
  useCollaboration.setState({ teams: [team], runs: { [run.id]: run, 'new-run': { ...run, id: 'new-run', status: 'running' } } })
  useCollaboration.getState().applyRun({ ...run, revision: 3 })
  assert.equal(useCollaboration.getState().teams[0].tasks[0].state, 'working')
})

test('completed snapshot cache is bounded without evicting active executions', () => {
  const { run } = setupRun()
  for (let i = 0; i < 120; i++) useCollaboration.getState().applyRun({ ...run, id: `history-${i}`, status: 'completed' })
  assert.equal(Object.keys(useCollaboration.getState().runs).length, 101)
  assert.equal(useCollaboration.getState().runs[run.id].status, 'running')
})
