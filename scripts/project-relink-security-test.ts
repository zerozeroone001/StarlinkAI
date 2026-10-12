import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProjectRelinkService } from '../src/main/project-relink'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { serializePortableWorkspace } from '../src/main/portable-manifest'
import { PORTABLE_LIMITS } from '../src/shared/portable-backup'
import type { WorkspaceBackupState } from '../src/renderer/src/lib/workspace-backup'

function fixture(t: TestContext) {
  const parent = path.resolve('.tmp/project-relink-security'); fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'case-'))
  const workspaces = path.join(root, 'managed'), source = path.join(root, 'old'), target = path.join(root, 'new-source-with-longer-name')
  for (const directory of [workspaces, source, target]) fs.mkdirSync(directory)
  const links: string[] = []
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert(path.basename(root).startsWith('case-'))
    for (const link of links) {
      assert(path.relative(root, link) && !path.relative(root, link).startsWith('..'))
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const team = createWorkspace('project', 'grok'); team.id = 'test-project'; team.directory = source
  const state: WorkspaceBackupState = { teams: [team], activeTeamId: team.id, drafts: {}, attachmentDrafts: {},
    defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] }
  const service = (customRoot = workspaces) => createProjectRelinkService({ workspacesRoot: customRoot,
    busy: () => false, chooseDirectory: async () => target, chooseSourceDirectory: async () => source })
  const link = (destination: string, source: string) => {
    fs.symlinkSync(destination, source, process.platform === 'win32' ? 'junction' : 'dir'); links.push(source)
  }
  const attach = (name: string, content: string) => {
    const directory = path.join(source, 'attachments'); fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, name); fs.writeFileSync(file, content)
    ;(state.attachmentDrafts[team.id] ||= []).push({ id: name.replace(/\W/g, '-'), name, path: file,
      size: Buffer.byteLength(content), mime: 'text/plain' })
    return file
  }
  return { root, workspaces, source, target, team, state, service, link, attach }
}

test('a plan exceeding the serialization limit is still cancellable and never claims commit', async (t) => {
  const f = fixture(t), service = f.service(), text = serializePortableWorkspace(f.state)
  const oldLimit = PORTABLE_LIMITS.manifestBytes
  try {
    ;(PORTABLE_LIMITS as { manifestBytes: number }).manifestBytes = Buffer.byteLength(text) + 5
    const preview = await service.prepare(text, f.team.id); assert(preview)
    await assert.rejects(service.commit(preview.token, false), /超过/)
    assert.equal((await service.status()).phase, 'preview')
    await service.cancel(preview.token)
    assert.equal(service.locked(), false)
    assert.equal((await service.status()).phase, 'idle')
    assert.equal(f.state.teams[0].directory, f.source)
  } finally { (PORTABLE_LIMITS as { manifestBytes: number }).manifestBytes = oldLimit }
})

test('replacing a natively authorized source directory between assets cannot mix unauthorized contents', async (t) => {
  const f = fixture(t), service = f.service()
  const first = f.attach('first.txt', 'synthetic original first')
  const second = f.attach('second.txt', 'synthetic original second')
  const open = fs.openSync
  let scheduled = false
  fs.openSync = ((file, flags, ...args) => {
    const fd = open(file, flags, ...args)
    if (file === first && !scheduled) {
      scheduled = true
      queueMicrotask(() => {
        fs.renameSync(f.source, `${f.source}-original`)
        fs.mkdirSync(path.dirname(second), { recursive: true })
        fs.writeFileSync(second, 'synthetic unapproved replacement')
      })
    }
    return fd
  }) as typeof fs.openSync
  let preview
  try { preview = await service.prepare(serializePortableWorkspace(f.state), f.team.id) }
  finally { fs.openSync = open }
  assert(preview); assert(scheduled)
  assert.equal(preview.files, 1)
  assert(preview.warnings.some((warning) => /变化/.test(warning.reason)))
  await assert.rejects(service.commit(preview.token, true), /变化/)
  await service.cancel(preview.token)
  assert.equal(service.locked(), false)
  assert.equal(fs.readFileSync(second, 'utf8'), 'synthetic unapproved replacement')
  assert.equal(fs.readFileSync(path.join(`${f.source}-original`, 'attachments', 'second.txt'), 'utf8'), 'synthetic original second')
  const managed = path.join(f.workspaces, f.team.id)
  assert(!fs.existsSync(managed) || fs.readdirSync(managed).length === 0)
})

test('a scope junction to another managed scope cannot receive copied project assets', async (t) => {
  const f = fixture(t), other = path.join(f.workspaces, 'other-project')
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'sentinel.txt'), 'other scope remains unchanged')
  f.link(other, path.join(f.workspaces, f.team.id))
  f.attach('attachment.txt', 'synthetic private attachment')
  const service = f.service(), preview = await service.prepare(serializePortableWorkspace(f.state), f.team.id)
  assert(preview)
  assert.equal(preview.files, 0); assert.equal(preview.warnings.length, 1)
  await assert.rejects(service.commit(preview.token, false), /确认/)
  await service.cancel(preview.token)
  assert.deepEqual(fs.readdirSync(other), ['sentinel.txt'])
  assert.equal(fs.readFileSync(path.join(other, 'sentinel.txt'), 'utf8'), 'other scope remains unchanged')
})

test('a junction above the managed root is rejected before creating any external directories', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside'), alias = path.join(f.root, 'linked-parent')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'external remains unchanged')
  f.link(outside, alias)
  f.attach('attachment.txt', 'synthetic private attachment')
  const service = f.service(path.join(alias, 'not-created', 'workspaces'))
  const preview = await service.prepare(serializePortableWorkspace(f.state), f.team.id)
  assert(preview); assert.equal(preview.files, 0); assert.equal(preview.warnings.length, 1)
  await service.cancel(preview.token)
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt'])
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'external remains unchanged')
})

test('a real junction swap immediately before open wx cannot write attachment contents outside staging', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'external remains unchanged')
  f.attach('attachment.txt', 'synthetic private attachment')
  const service = f.service(), open = fs.openSync
  let swapped = false
  fs.openSync = ((file, flags, ...args) => {
    if (!swapped && flags === 'wx' && typeof file === 'string' && file.includes(`${path.sep}relinked-`)) {
      swapped = true
      const folder = path.dirname(file)
      fs.renameSync(folder, `${folder}-original`)
      f.link(outside, folder)
    }
    return open(file, flags, ...args)
  }) as typeof fs.openSync
  let preview
  try { preview = await service.prepare(serializePortableWorkspace(f.state), f.team.id) }
  finally { fs.openSync = open }
  assert(preview); assert(swapped)
  assert.equal(preview.files, 0); assert.equal(preview.warnings.length, 1)
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'external remains unchanged')
  // A narrow path-based open race can leave an empty newly created file before
  // the descriptor/path checks run. It must never receive the attachment bytes.
  for (const name of fs.readdirSync(outside).filter((name) => name !== 'sentinel.txt'))
    assert.equal(fs.statSync(path.join(outside, name)).size, 0)
  await service.cancel(preview.token)
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'external remains unchanged')
})
