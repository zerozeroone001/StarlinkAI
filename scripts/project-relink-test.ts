import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectRelinkService } from '../src/main/project-relink'
import { createPortableBackupService } from '../src/main/portable-backup'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { createWorkspaceBackup, parseWorkspaceSnapshot, type WorkspaceBackupState } from '../src/renderer/src/lib/workspace-backup'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMKkAAAAASUVORK5CYII=', 'base64')
function fixture(t: TestContext, internal = false) {
  const base = path.resolve('.tmp/project-relink-tests'); fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'case-')), workspaces = path.join(root, 'workspaces')
  const project = createWorkspace('project', 'grok'); project.id = 'synthetic-project'
  const old = internal ? path.join(workspaces, project.id) : path.join(root, 'old'), next = path.join(root, 'new')
  fs.mkdirSync(path.join(old, 'attachments'), { recursive: true }); fs.mkdirSync(next)
  fs.writeFileSync(path.join(old, 'source.ts'), 'old source'); fs.writeFileSync(path.join(next, 'source.ts'), 'new source')
  fs.writeFileSync(path.join(old, 'attachments', 'note.txt'), 'retained attachment'); fs.writeFileSync(path.join(old, 'picture.png'), png)
  project.directory = old
  project.permissionMode = 'auto'
  const child = createWorkspace('conversation', 'grok', 'Synthetic child'); child.id = 'synthetic-child'; child.parentId = project.id
  child.directory = old
  child.messages = [{ id: 'message', author: 'you', text: '![relative](picture.png)', to: 'all', kind: 'message', sample: false,
    time: new Date().toISOString(), cwd: old, sessionId: 'old-session', runId: 'old-run', status: 'completed',
    images: [{ path: path.join(old, 'picture.png') }] }]
  const state: WorkspaceBackupState = { teams: [project, child], activeTeamId: child.id, drafts: { [child.id]: 'draft stays' },
    attachmentDrafts: { [child.id]: [{ id: 'attachment', name: 'note.txt', path: path.join(old, 'attachments', 'note.txt'), size: 19, mime: 'text/plain' }] },
    defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [path.join(old, 'picture.png').replace(/\\/g, '/').toLowerCase()] }
  let selections = 0
  const service = (overrides: Partial<Parameters<typeof createProjectRelinkService>[0]> = {}) => createProjectRelinkService({
    workspacesRoot: workspaces, busy: () => false, chooseDirectory: async () => next,
    chooseSourceDirectory: async () => { selections++; return old }, ...overrides })
  t.after(() => { assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('case-')); fs.rmSync(root, { recursive: true, force: true }) })
  const text = () => createWorkspaceBackup(state, 64 * 1024 * 1024, true)
  return { root, old, next, workspaces, state, project, child, service, text, selections: () => selections }
}
test('external relink keeps IDs/drafts/history, copies assets, retires execution links and never writes either source tree', async (t) => {
  const f = fixture(t), api = f.service(), before = f.text(), preview = (await api.prepare(before, f.project.id))!
  assert.equal(preview.warnings.length, 0); assert.equal(preview.files, 2); assert.equal(f.selections(), 1)
  const prepared = parseWorkspaceSnapshot((await api.commit(preview.token, false)).workspaceText, 64 * 1024 * 1024, true)
  assert.deepEqual(prepared.teams.map(team => team.id), f.state.teams.map(team => team.id))
  assert.ok(prepared.teams.every(team => team.directory === f.next)); assert.equal(prepared.teams[1].parentId, f.project.id)
  assert.ok(prepared.teams.every(team => team.permissionMode === 'ask'))
  assert.equal(prepared.drafts[f.child.id], 'draft stays'); assert.equal(prepared.teams[1].messages[0].sessionId, undefined)
  assert.equal(prepared.teams[1].messages[0].runId, 'restored-history:old-run')
  const attachment = prepared.attachmentDrafts[f.child.id][0].path
  assert.ok(attachment.startsWith(path.join(f.workspaces, f.project.id))); assert.equal(fs.readFileSync(attachment, 'utf8'), 'retained attachment')
  const image = prepared.teams[1].messages[0].images![0].path!
  assert.deepEqual(fs.readFileSync(image), png); assert.ok(prepared.teams[1].messages[0].text.includes(image.replace(/\\/g, '/')))
  assert.equal(prepared.deletedGalleryKeys[0], `sha256:${createHash('sha256').update(png).digest('hex')}`)
  assert.deepEqual(fs.readdirSync(f.next), ['source.ts']); assert.equal(fs.readFileSync(path.join(f.old, 'source.ts'), 'utf8'), 'old source')
  await assert.rejects(api.cancel(), /保存/); await api.finish(preview.token); assert.equal(api.locked(), false)
  assert.equal(fs.existsSync(attachment), true); assert.deepEqual(JSON.parse(f.text()).state, JSON.parse(before).state)
})
test('restored managed assets remain available without native old-source authorization', async (t) => {
  const f = fixture(t, true), api = f.service({ chooseSourceDirectory: async () => { throw new Error('must not prompt') } })
  const preview = (await api.prepare(f.text(), f.project.id))!
  assert.equal(preview.warnings.length, 0)
  const prepared = parseWorkspaceSnapshot((await api.commit(preview.token, false)).workspaceText)
  assert.equal(prepared.attachmentDrafts[f.child.id][0].path, f.state.attachmentDrafts[f.child.id][0].path)
  await api.finish(preview.token); assert.equal(fs.readdirSync(path.join(f.workspaces, f.project.id)).some(name => name.startsWith('relinked-')), false)
})
test('native cancel does not create copies or change state', async (t) => {
  const f = fixture(t), api = f.service({ chooseDirectory: async () => null })
  assert.equal(await api.prepare(f.text(), f.project.id), null); assert.equal(api.locked(), false); assert.equal(fs.existsSync(f.workspaces), false)
})
test('preview cancel removes only newly allocated copies and leaves sources intact', async (t) => {
  const f = fixture(t), api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  const managed = path.join(f.workspaces, f.project.id)
  assert.equal(fs.readdirSync(managed).length, 1); await api.cancel(preview.token); assert.deepEqual(fs.readdirSync(managed), [])
  assert.deepEqual(fs.readFileSync(path.join(f.old, 'picture.png')), png)
})
test('cancellation while the native selector is pending rejects its late result', async (t) => {
  const f = fixture(t); let selected!: (value: string) => void
  const api = f.service({ chooseDirectory: () => new Promise(resolve => { selected = resolve }) })
  const pending = api.prepare(f.text(), f.project.id); await api.cancel(); selected(f.next)
  await assert.rejects(pending, /取消/); assert.equal(api.locked(), false); assert.equal(fs.existsSync(f.workspaces), false)
})
test('missing relative images remain anchored to original paths and require incomplete acknowledgement', async (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.old, 'picture.png')); fs.writeFileSync(path.join(f.next, 'picture.png'), png)
  const api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  assert.equal(preview.warnings.length, 2); await assert.rejects(api.commit(preview.token, false), /确认/)
  const state = parseWorkspaceSnapshot((await api.commit(preview.token, true)).workspaceText)
  assert.ok(state.teams[1].messages[0].text.includes(path.join(f.old, 'picture.png').replace(/\\/g, '/')))
  assert.equal(state.teams[1].messages[0].cwd, f.old); await api.finish(preview.token)
})
test('declining old source authorization leaves every external reference unread', async (t) => {
  const f = fixture(t), api = f.service({ chooseSourceDirectory: async () => null }), preview = (await api.prepare(f.text(), f.project.id))!
  assert.equal(preview.files, 0); assert.equal(preview.warnings.length, 3); assert.equal(fs.existsSync(f.workspaces), false)
  await api.cancel(preview.token)
})
test('unrelated external paths and junctions cannot expand authorized roots', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.png'), png)
  fs.symlinkSync(outside, path.join(f.old, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  f.child.messages[0].images = [{ path: path.join(outside, 'secret.png') }, { path: path.join(f.old, 'linked', 'secret.png') }]
  const api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  assert.equal(preview.warnings.length, 2); assert.equal(preview.files, 2); await api.cancel()
})
test('a junction substituted for the managed scope cannot grant implicit access', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.mkdirSync(f.workspaces)
  fs.symlinkSync(outside, path.join(f.workspaces, f.project.id), process.platform === 'win32' ? 'junction' : 'dir')
  const api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  assert.equal(preview.files, 0); assert.equal(preview.warnings.length, 3); assert.deepEqual(fs.readdirSync(outside), [])
  await api.cancel()
})
test('changed destination identity or changed prepared content rejects commit', async (t) => {
  const f = fixture(t), api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  fs.renameSync(f.next, path.join(f.root, 'moved')); fs.mkdirSync(f.next)
  await assert.rejects(api.commit(preview.token, false), /目录已变化/); await api.cancel()
  const next = (await api.prepare(f.text(), f.project.id))!
  const folder = path.join(f.workspaces, f.project.id, `relinked-${next.token}`, 'attachments')
  fs.writeFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'changed')
  await assert.rejects(api.commit(next.token, false), /文件已变化/); await api.cancel()
})
test('busy, invalid scope, stale tokens and duplicate commits fail without changing the project', async (t) => {
  const f = fixture(t); await assert.rejects(f.service({ busy: () => true }).prepare(f.text(), f.project.id), /等待/)
  const api = f.service(); await assert.rejects(api.prepare(f.text(), '../outside'), /不存在/)
  const preview = (await api.prepare(f.text(), f.project.id))!
  await assert.rejects(api.prepare(f.text(), f.project.id), /等待/); await assert.rejects(api.commit('stale', false), /失效/)
  await api.commit(preview.token, false); await assert.rejects(api.commit(preview.token, false), /失效/)
  await api.finish(preview.token)
})
test('relinked managed assets export through portable backup after the source directory disappears', async (t) => {
  const f = fixture(t), api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  const plan = await api.commit(preview.token, false); await api.finish(preview.token)
  fs.renameSync(f.old, path.join(f.root, 'unavailable-old')); fs.renameSync(f.next, path.join(f.root, 'unavailable-new'))
  const prior = process.env.GROK_HOME; process.env.GROK_HOME = path.join(f.root, 'home')
  try {
    const backup = createPortableBackupService({ root: path.join(f.root, 'backups'), workspacesRoot: f.workspaces,
      busy: () => false, chooseArchive: async () => null, chooseDestination: async () => null,
      chooseSourceDirectory: async () => { throw new Error('managed references must not require external access') } })
    const exported = await backup.beginExport(plan.workspaceText)
    assert.equal(exported.warnings.length, 0); assert.equal(exported.counts.files, 2); await backup.cancel()
  } finally { if (prior === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = prior }
})
test('authoritative workspace reload releases abandoned host leases while retaining published copies', async (t) => {
  const f = fixture(t), api = f.service(), preview = (await api.prepare(f.text(), f.project.id))!
  const plan = parseWorkspaceSnapshot((await api.commit(preview.token, false)).workspaceText)
  const file = plan.attachmentDrafts[f.child.id][0].path
  await api.reconcileAfterWorkspaceRead()
  assert.equal(api.locked(), false); assert.equal(fs.readFileSync(file, 'utf8'), 'retained attachment')
  const next = (await api.prepare(f.text(), f.project.id))!
  assert.equal((await api.status()).phase, 'preview')
  await api.reconcileAfterWorkspaceRead()
  assert.equal(api.locked(), false)
  assert.equal(fs.existsSync(path.join(f.workspaces, f.project.id, `relinked-${next.token}`)), false)
  assert.equal(fs.existsSync(file), true)
})
