import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitState, fileTree, readTextFile } from '../src/main/git'
import { importLocalProject, loadDesktopState, renameProject, hideProject, mergeProjects } from '../src/main/desktop-state'
import { useApp } from '../src/renderer/src/stores/app'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { emptyRuntime } from '../src/renderer/src/lib/session-runtime'
import { prepareProjectDirectory, resolveProjectDirectory } from '../src/main/project-directory'
import { createWorkspace, isValidTeam, teamDirectory } from '../src/renderer/src/lib/collaboration-data'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tree = (cwd: string) => [{ name: cwd, path: `${cwd}/file.txt`, dir: false }]
const preview = (file: string, text = 'original') => ({ path: file, name: file, ext: 'txt', size: text.length, kind: 'text' as const, mime: 'text/plain', text })
let api: any
beforeEach(() => {
  api = {
    git: async () => null, tree: async (cwd: string) => tree(cwd),
    skills: { list: async () => [] }, previewFile: async (file: string) => preview(file),
    pickFolder: async () => null
  }
  Object.assign(globalThis, { window: { grok: api } })
  useApp.setState({ cwd: '', activeThreadId: null, threads: [], projects: [], runtimes: {}, drafts: {},
    draft: '', messages: [], tree: [], git: null, skills: [], preview: null, previewPath: null, error: null })
  useCollaboration.setState({ surface: 'workspace' })
})

test('project directories select existing folders and create only new single folders without replacing data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-directory-test-'))
  try {
    const folder = prepareProjectDirectory({ mode: 'new', parent: root, name: '中文 project' })
    assert.equal(folder, fs.realpathSync(path.join(root, '中文 project')))
    const keep = path.join(folder, 'keep.txt')
    fs.writeFileSync(keep, 'keep original')
    assert.equal(prepareProjectDirectory({ mode: 'existing', path: folder + path.sep + '.' }), folder)
    assert.throws(() => prepareProjectDirectory({ mode: 'new', parent: root, name: '中文 project' }), /已存在/)
    for (const name of ['', '.', '..', '../escape', 'nested/child', 'nested\\child', 'CON', 'nul.txt', 'COM1', 'a:b', 'trailing.'])
      assert.throws(() => prepareProjectDirectory({ mode: 'new', parent: root, name }), /名称无效/)
    for (const folderPath of ['', 'relative', path.join(root, 'missing'), keep])
      assert.throws(() => resolveProjectDirectory(folderPath), /路径|不存在/)
    assert.throws(() => prepareProjectDirectory({ mode: 'new', parent: path.join(root, 'missing'), name: 'child' }), /不存在/)
    assert.equal(fs.readFileSync(keep, 'utf8'), 'keep original')
    assert.deepEqual(fs.readdirSync(root), ['中文 project'])
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-directory-test-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('new projects require a directory, child conversations inherit it and saved snapshots retain it', (t) => {
  const previous = useCollaboration.getState()
  t.after(() => useCollaboration.setState(previous, true))
  useCollaboration.setState({ teams: [], runs: {}, drafts: {} })
  const state = useCollaboration.getState()
  assert.throws(() => state.createWorkspace('project', 'Missing'), /目录/)
  assert.throws(() => state.createWorkspace('project', 'Relative', '', undefined, 'relative'), /目录/)
  assert.equal(useCollaboration.getState().teams.length, 0)
  const directory = path.resolve('resources')
  const id = state.createWorkspace('project', 'Bound', 'goal', undefined, directory)
  const childId = state.createWorkspace('conversation', 'Child', '', id)
  const current = useCollaboration.getState()
  const saved = JSON.parse(JSON.stringify(useCollaboration.persist.getOptions().partialize!(current)))
  const restored = useCollaboration.persist.getOptions().merge!(saved, current) as typeof current
  assert.equal(restored.teams.find((team) => team.id === id)?.directory, directory)
  assert.equal(restored.teams.find((team) => team.id === childId)?.directory, directory)
  assert.equal(teamDirectory(restored.teams, childId), directory)
  assert.ok(restored.teams.every(isValidTeam))
  assert.equal(isValidTeam({ ...restored.teams[0], directory: 123 }), false)
})

test('binding an older project updates its children while preserving history and checking active runs', (t) => {
  const previous = useCollaboration.getState()
  t.after(() => useCollaboration.setState(previous, true))
  const project = createWorkspace('project', 'grok', 'Older project')
  const child = createWorkspace('conversation', 'grok', 'Existing child', '', project)
  useCollaboration.setState({ teams: [project, child], runs: { busy: { id: 'busy', workspaceId: child.id, status: 'running' } as any } })
  const directory = path.resolve('resources')
  assert.throws(() => useCollaboration.getState().updateTeam(project.id, project.name, '', project.members, directory), /执行结束/)
  assert.equal(useCollaboration.getState().teams[0].directory, undefined)
  useCollaboration.setState({ runs: {} })
  useCollaboration.getState().updateTeam(project.id, project.name, '', project.members, directory)
  assert.equal(useCollaboration.getState().teams[1].directory, directory)
  assert.deepEqual(useCollaboration.getState().teams[1].messages, child.messages)
  assert.equal(useCollaboration.getState().teams[1].id, child.id)
})

test('sending from a project child uses the project directory in its execution request', async (t) => {
  const previous = useCollaboration.getState(), previousStart = runtimeClient.start
  t.after(() => { useCollaboration.setState(previous, true); runtimeClient.start = previousStart })
  const project = createWorkspace('project', 'grok', 'Bound project', '', undefined, path.resolve('resources'))
  const child = createWorkspace('conversation', 'grok', 'Child', '', project)
  child.directory = path.resolve('docs') // The parent is authoritative even for stale child snapshots.
  useCollaboration.setState({ teams: [project, child], runs: {}, drafts: { [child.id]: 'Inspect project' } })
  let received: import('../src/shared/runtime').RunRequest | undefined
  runtimeClient.start = async (request) => {
    received = request
    return { id: request.id, workspaceId: request.workspaceId, status: 'completed', replies: [], permissions: [], createdAt: '', contextTrimmed: false }
  }
  await useCollaboration.getState().send(child.id, child.members[0].id)
  assert.equal(received?.workspaceId, child.id)
  assert.equal(received?.directory, project.directory)
})

test('focusing another project separates its directory from the old session and keeps its draft', async () => {
  useApp.setState({ cwd: 'A', activeThreadId: 'session-A', draft: 'unfinished', drafts: { 'session-A': 'unfinished' },
    runtimes: { 'session-A': emptyRuntime() }, preview: preview('A/file.txt'), previewPath: 'A/file.txt' })
  await useApp.getState().focusProject('B')
  assert.equal(useApp.getState().activeThreadId, null)
  assert.equal(useApp.getState().cwd, 'B')
  assert.equal(useApp.getState().drafts['session-A'], 'unfinished')
  assert.equal(useApp.getState().preview, null)
  assert.equal(useCollaboration.getState().surface, 'legacy')
})

test('rapid project switches ignore the slower previous directory response', async () => {
  const slow = deferred<ReturnType<typeof tree>>()
  api.tree = (cwd: string) => cwd === 'A' ? slow.promise : Promise.resolve(tree(cwd))
  const first = useApp.getState().newThread('A')
  await useApp.getState().newThread('B')
  slow.resolve(tree('A'))
  await first
  assert.deepEqual(useApp.getState().tree, tree('B'))
})

test('directory loading errors are shown without retaining another project file tree', async () => {
  useApp.setState({ cwd: 'A', tree: tree('A') })
  api.tree = async () => { throw new Error('directory unavailable') }
  await useApp.getState().newThread('B')
  assert.deepEqual(useApp.getState().tree, [])
  assert.match(useApp.getState().error!, /directory unavailable/)
})

test('cancelled import leaves the current project and draft unchanged', async () => {
  useApp.setState({ cwd: 'A', activeThreadId: 'session-A', draft: 'unfinished' })
  await useApp.getState().addProject()
  assert.equal(useApp.getState().cwd, 'A')
  assert.equal(useApp.getState().draft, 'unfinished')
  assert.equal(useApp.getState().activeThreadId, 'session-A')
})

test('failed import reports an error and does not switch away from the current project', async () => {
  useApp.setState({ cwd: 'A' })
  api.pickFolder = async () => 'missing'
  api.addProjectPath = async () => { throw new Error('directory unavailable') }
  await useApp.getState().addProject()
  assert.equal(useApp.getState().cwd, 'A')
  assert.match(useApp.getState().error!, /directory unavailable/)
})

test('successful folder import opens a new local session with the imported directory', async () => {
  api.pickFolder = async () => 'B'
  api.addProjectPath = async () => [{ id: 'B', name: 'B', path: 'B' }]
  await useApp.getState().addProject()
  assert.equal(useApp.getState().projects[0].path, 'B')
  assert.equal(useApp.getState().cwd, 'B')
  assert.deepEqual(useApp.getState().tree, tree('B'))
  assert.equal(useCollaboration.getState().surface, 'legacy')
})

test('sending without a project aborts if importing the selected folder fails', async () => {
  api.pickFolder = async () => 'missing'
  api.addProjectPath = async () => { throw new Error('directory unavailable') }
  let started = false
  api.acp = { newSession: async () => { started = true; return { sessionId: 'unexpected' } } }
  await useApp.getState().send('develop this project')
  assert.equal(started, false)
  assert.deepEqual(useApp.getState().projects, [])
  assert.equal(useApp.getState().cwd, '')
  assert.match(useApp.getState().error!, /directory unavailable/)
})

test('selecting or closing a preview ignores older pending file reads', async () => {
  const slow = deferred<ReturnType<typeof preview>>()
  api.previewFile = (file: string) => file === 'old' ? slow.promise : Promise.resolve(preview(file))
  const first = useApp.getState().openPreview('old')
  await useApp.getState().openPreview('new')
  slow.resolve(preview('old'))
  await first
  assert.equal(useApp.getState().preview?.path, 'new')
  const closing = deferred<ReturnType<typeof preview>>()
  api.previewFile = () => closing.promise
  const pending = useApp.getState().openPreview('closing')
  useApp.getState().closePreview()
  closing.resolve(preview('closing'))
  await pending
  assert.equal(useApp.getState().preview, null)
})

test('refresh after an agent edit reloads the selected file contents', async () => {
  useApp.setState({ cwd: 'A', previewPath: 'A/file.txt', preview: preview('A/file.txt') })
  api.previewFile = async (file: string) => preview(file, 'modified')
  await useApp.getState().refreshWorkspace('A')
  assert.equal(useApp.getState().preview?.text, 'modified')
})

test('switching project prevents a pending preview from reopening the old file', async () => {
  useApp.setState({ cwd: 'A' })
  const slow = deferred<ReturnType<typeof preview>>()
  api.previewFile = () => slow.promise
  const reading = useApp.getState().openPreview('A/file.txt')
  await useApp.getState().newThread('B')
  slow.resolve(preview('A/file.txt'))
  await reading
  assert.equal(useApp.getState().preview, null)
  assert.equal(useApp.getState().previewPath, null)
})

test('local imports persist, deduplicate, preserve renamed projects and reject invalid folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-project-import-'))
  const previousHome = process.env.GROK_HOME
  process.env.GROK_HOME = path.join(root, 'state')
  try {
    const folder = path.join(root, '中文 project')
    fs.mkdirSync(folder)
    const file = path.join(folder, 'keep.txt')
    fs.writeFileSync(file, 'keep original')
    assert.equal(importLocalProject(folder).length, 1)
    renameProject(folder, 'Custom name')
    const projects = importLocalProject(folder + path.sep + '.')
    assert.equal(projects.length, 1)
    assert.equal(projects[0].name, 'Custom name')
    assert.equal(loadDesktopState().projects[0].path, folder)
    assert.throws(() => importLocalProject(''), /有效/)
    assert.throws(() => importLocalProject('relative'), /有效/)
    assert.throws(() => importLocalProject(path.join(root, 'missing')), /不存在/)
    assert.throws(() => importLocalProject(file), /不存在/)
    assert.equal(loadDesktopState().projects.length, 1)
    hideProject(folder)
    assert.deepEqual(mergeProjects([]), [])
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep original')
    assert.equal(importLocalProject(folder).length, 1)
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-project-import-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Git review preserves dotted branch names, Unicode filenames and rename destinations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-project-regression-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' })
  try {
    git('init', '-b', 'feature/v1.2')
    git('config', 'user.name', 'Project Test')
    git('config', 'user.email', 'project-test@example.invalid')
    git('config', 'core.autocrlf', 'false')
    git('config', 'core.hooksPath', path.join(root, 'no-hooks'))
    fs.writeFileSync(path.join(root, 'initial.txt'), 'first staged file\n')
    git('add', '.')
    const initial = await gitState(root)
    assert.equal(initial?.branch, 'feature/v1.2')
    assert.match(initial?.diff || '', /first staged file/)
    fs.writeFileSync(path.join(root, 'old.txt'), 'rename me\n')
    fs.writeFileSync(path.join(root, '中文 文件.txt'), 'original\n')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
    git('mv', 'old.txt', 'new name.txt')
    fs.appendFileSync(path.join(root, '中文 文件.txt'), 'modified\n')
    const state = await gitState(root)
    assert.equal(state?.branch, 'feature/v1.2')
    assert.ok(state?.files.some((f) => f.path === '中文 文件.txt'))
    assert.ok(state?.files.some((f) => f.path === 'new name.txt' && f.staged))
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, '中文 child.txt'), 'child\n')
    const childState = await gitState(nested)
    assert.deepEqual(childState?.files.map((f) => f.path), ['中文 child.txt'])
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-project-regression-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('file browsing loads one directory at a time without hiding deep, dot or late entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tree-regression-'))
  try {
    const deep = path.join(root, 'one', 'two', 'three', 'four', 'five')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'last.txt'), 'last')
    fs.writeFileSync(path.join(root, '.env.example'), 'EXAMPLE=true')
    fs.mkdirSync(path.join(root, 'node_modules'))
    for (let i = 0; i < 405; i++) fs.writeFileSync(path.join(root, `${i}.txt`), 'file')
    const first = fileTree(root)
    assert.equal(first.length, 407)
    assert.ok(first.some((n) => n.name === '.env.example'))
    assert.equal(first.find((n) => n.name === 'one')?.children, undefined)
    let cursor = root
    for (const part of ['one', 'two', 'three', 'four', 'five']) {
      cursor = fileTree(cursor).find((n) => n.name === part)!.path
    }
    assert.equal(fileTree(cursor)[0].name, 'last.txt')
    assert.throws(() => fileTree(path.join(root, 'missing')))
    const large = path.join(root, 'large.txt')
    fs.writeFileSync(large, 'a'.repeat(1000000))
    assert.equal(readTextFile(large, 100), 'a'.repeat(100) + '\n…')
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-tree-regression-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('double send during session creation dispatches exactly one request', async () => {
  const created = deferred<{ sessionId: string }>()
  let sessions = 0, prompts = 0
  api.acp = {
    newSession: async () => { sessions++; return created.promise },
    prompt: async () => { prompts++ }
  }
  api.threads = async () => []
  useApp.setState({ cwd: 'A' })
  const first = useApp.getState().send('hello')
  const second = useApp.getState().send('hello')
  created.resolve({ sessionId: 'single-send-session' })
  await Promise.all([first, second])
  assert.equal(sessions, 1)
  assert.equal(prompts, 1)
})

test('typing while a new session is starting preserves the next draft', async () => {
  const created = deferred<{ sessionId: string }>()
  const prompts: string[] = []
  api.acp = { newSession: () => created.promise, prompt: async (text: string) => { prompts.push(text) } }
  api.threads = async () => []
  useApp.setState({ cwd: 'A' })
  useApp.getState().setDraft('first request')
  const sending = useApp.getState().send()
  useApp.getState().setDraft('next request still being written')
  created.resolve({ sessionId: 'draft-new-session' })
  await sending
  assert.deepEqual(prompts, ['first request'])
  assert.equal(useApp.getState().draft, 'next request still being written')
  assert.equal(useApp.getState().drafts['draft-new-session'], 'next request still being written')
})

test('sending an explicit command does not discard an unrelated unsent draft', async () => {
  api.acp = { newSession: async () => ({ sessionId: 'command-draft-session' }), prompt: async () => {} }
  api.threads = async () => []
  useApp.setState({ cwd: 'A' })
  useApp.getState().setDraft('unfinished explanation')
  await useApp.getState().send('/review')
  assert.equal(useApp.getState().draft, 'unfinished explanation')
  assert.equal(useApp.getState().drafts['command-draft-session'], 'unfinished explanation')
})

test('resuming a session preserves newer drafts in both the sent and currently viewed conversation', async () => {
  const loaded = deferred<{ sessionId: string }>()
  api.acp = { loadSession: () => loaded.promise, prompt: async () => {} }
  api.threads = async () => []
  useApp.setState({ cwd: 'A', activeThreadId: 'draft-original', runtimes: { 'draft-original': emptyRuntime(), 'draft-other': emptyRuntime() } })
  useApp.getState().setDraft('original request')
  const sending = useApp.getState().send()
  useApp.getState().setDraft('follow-up for original')
  await useApp.getState().openThread({ id: 'draft-other', cwd: 'B', title: 'Other', projectName: 'B',
    updatedAt: new Date().toISOString(), status: 'idle' })
  useApp.getState().setDraft('other conversation draft')
  loaded.resolve({ sessionId: 'draft-restored' })
  await sending
  assert.equal(useApp.getState().activeThreadId, 'draft-other')
  assert.equal(useApp.getState().draft, 'other conversation draft')
  assert.equal(useApp.getState().drafts['draft-other'], 'other conversation draft')
  assert.equal(useApp.getState().drafts['draft-restored'], 'follow-up for original')
  assert.equal(useApp.getState().drafts['draft-original'], undefined)
})

test('new sessions created in the background never take a later new conversation draft', async () => {
  const created = deferred<{ sessionId: string }>()
  api.acp = { newSession: () => created.promise, prompt: async () => {} }
  api.threads = async () => []
  useApp.setState({ cwd: 'A' })
  useApp.getState().setDraft('original request')
  const sending = useApp.getState().send()
  await useApp.getState().newThread('B')
  useApp.getState().setDraft('separate new conversation')
  created.resolve({ sessionId: 'background-created' })
  await sending
  assert.equal(useApp.getState().activeThreadId, null)
  assert.equal(useApp.getState().draft, 'separate new conversation')
  assert.equal(useApp.getState().drafts.__new__, 'separate new conversation')
  assert.equal(useApp.getState().drafts['background-created'], '')
})

test('stopping a background session never replaces the newly opened conversation', async () => {
  const stopped = deferred<void>()
  api.acp = { cancel: () => stopped.promise }
  const first = { ...emptyRuntime(), running: true, messages: [{ id: 'first', kind: 'assistant' as const,
    text: 'first reply', createdAt: new Date().toISOString(), streaming: true }] }
  const second = { ...emptyRuntime(), running: true, messages: [{ id: 'second', kind: 'assistant' as const,
    text: 'second reply', createdAt: new Date().toISOString(), streaming: true }] }
  useApp.setState({ cwd: 'A', activeThreadId: 'stop-first', runtimes: { 'stop-first': first, 'stop-second': second },
    messages: first.messages, running: true })
  const cancelling = useApp.getState().cancel()
  await useApp.getState().openThread({ id: 'stop-second', cwd: 'B', title: 'Second', projectName: 'B',
    updatedAt: new Date().toISOString(), status: 'running' })
  stopped.resolve()
  await cancelling
  assert.equal(useApp.getState().activeThreadId, 'stop-second')
  assert.deepEqual(useApp.getState().messages, second.messages)
  assert.equal(useApp.getState().running, true)
  assert.equal(useApp.getState().runtimes['stop-first'].running, false)
})

test('a failed stop keeps the run active and reports an actionable error', async () => {
  api.acp = { cancel: async () => { throw new Error('Stop failed; retry') } }
  const running = { ...emptyRuntime(), running: true }
  useApp.setState({ activeThreadId: 'stop-error', runtimes: { 'stop-error': running }, running: true })
  await useApp.getState().cancel()
  assert.equal(useApp.getState().running, true)
  assert.equal(useApp.getState().runtimes['stop-error'].running, true)
  assert.match(useApp.getState().error!, /Stop failed; retry/)
})

test('project switch during folder selection cannot redirect the new conversation', async () => {
  const selected = deferred<string>()
  api.pickFolder = () => selected.promise
  api.addProjectPath = async () => [{ id: 'A', name: 'A', path: 'A' }]
  let started = false
  api.acp = { newSession: async () => { started = true; return { sessionId: 'unexpected' } } }
  const sending = useApp.getState().send('hello')
  await useApp.getState().newThread('B')
  selected.resolve('A')
  await sending
  assert.equal(started, false)
  assert.equal(useApp.getState().cwd, 'B')
})

test('refreshing an inaccessible project clears stale entries and reports the failure', async () => {
  useApp.setState({ cwd: 'A', tree: tree('A') })
  api.tree = async () => { throw new Error('project removed') }
  await useApp.getState().refreshWorkspace()
  assert.deepEqual(useApp.getState().tree, [])
  assert.match(useApp.getState().error!, /project removed/)
})

test('an unavailable project directory does not hide a saved conversation', async () => {
  const history = [{ id: 'history-message', kind: 'user' as const, text: 'saved request', createdAt: new Date().toISOString() }]
  api.history = async () => ({ messages: history, nextCursor: null, hasMore: false })
  api.tree = async () => { throw new Error('project directory unavailable') }
  const thread = { id: 'missing-directory-session', cwd: 'missing', title: 'Saved chat', projectName: 'Missing',
    updatedAt: new Date().toISOString(), status: 'idle' as const }
  await useApp.getState().openThread(thread)
  assert.deepEqual(useApp.getState().messages, history)
  assert.deepEqual(useApp.getState().runtimes[thread.id].messages, history)
  assert.deepEqual(useApp.getState().tree, [])
  assert.match(useApp.getState().error!, /project directory unavailable/)
})
