import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { managedAssetDirectory, runtimeRoot, workspaceDir } from '../src/main/runtime/cli'
import { uploadAttachment, resolveAttachments } from '../src/main/runtime/attachments'
import { collectRunImages, previewWorkspaceImage } from '../src/main/runtime/media'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { collectGalleryImages, galleryImageData } from '../src/renderer/src/lib/gallery'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')
const imageInput = { name: 'original.png', data: png.toString('base64') }
const catalogue = [{ id: 'codex', auth: { signedIn: true }, models: [{ id: 'test', name: 'Test', efforts: [], isDefault: true }] }] as RuntimeProvider[]
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({ id: randomUUID(), workspaceId: randomUUID(), prompt: 'Fixture only', goal: '',
  employees: [{ id: 'worker', name: 'Worker', provider: 'codex', role: '', persona: '' }], context: [], artifacts: [], ...patch })
const makeDirectory = (name: string) => fs.mkdtempSync(path.join(os.homedir(), name))
const fixture = () => ({ cwd: makeDirectory('source-'), scope: randomUUID(), other: makeDirectory('outside-') })
const runtime = (execute: NonNullable<Parameters<typeof createRuntime>[0]>['execute'] = async () => {}) =>
  createRuntime({ directory: workspaceDir, providers: async () => structuredClone(catalogue), skills: () => [], execute })
const junction = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
async function terminal(h: ReturnType<typeof runtime>, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = await h.api.run(id)
    if (!['queued', 'running', 'needs_permission'].includes(result.status)) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Controlled runtime did not settle')
}

test('the runner isolates HOME and managed reads never create a missing root', () => {
  assert.ok(os.homedir().includes('managed-assets-'))
  assert.equal(managedAssetDirectory('missing-read'), undefined)
  assert.equal(fs.existsSync(runtimeRoot), false)
})

test('managed roots are exactly one validated child beneath the host runtime root', () => {
  for (const invalid of ['', '../other', 'a/b', 'a\\b', '/absolute', 'a'.repeat(101), 7])
    assert.throws(() => managedAssetDirectory(invalid as string, true), /编号/)
  const scope = randomUUID(), root = managedAssetDirectory(scope, true)!
  assert.equal(root, fs.realpathSync(path.join(runtimeRoot, scope)))
  assert.equal(managedAssetDirectory(scope), root)
  assert.equal(workspaceDir(scope), root)
})

test('a scope junction cannot turn fixed asset authority into another directory', () => {
  const { scope, other } = fixture()
  junction(other, path.join(runtimeRoot, scope))
  assert.throws(() => managedAssetDirectory(scope), /链接/)
  assert.throws(() => managedAssetDirectory(scope, true), /链接/)
  assert.throws(() => workspaceDir(scope), /链接/)
  assert.deepEqual(fs.readdirSync(other), [])
})

test('an ancestor junction is rejected before any nested directory creation', () => {
  const external = makeDirectory('external-root-'), moved = `${runtimeRoot}-original`
  fs.renameSync(runtimeRoot, moved)
  let linked = false
  try {
    junction(external, runtimeRoot)
    linked = true
    assert.throws(() => managedAssetDirectory(randomUUID(), true), /链接/)
    assert.deepEqual(fs.readdirSync(external), [])
  } finally {
    if (linked) fs.unlinkSync(runtimeRoot)
    fs.renameSync(moved, runtimeRoot)
  }
})

test('uploads use the managed scope without adding files to the source directory', async () => {
  const { scope, cwd } = fixture(), h = runtime()
  try {
    const a = await h.api.upload(scope, imageInput, cwd)
    assert.equal(path.dirname(a.path), path.join(managedAssetDirectory(scope)!, 'attachments'))
    assert.deepEqual(fs.readFileSync(a.path), png)
    assert.deepEqual(fs.readdirSync(cwd), [])
    assert.equal((await h.api.media(scope, a.path, cwd)).dataUrl, `data:image/png;base64,${imageInput.data}`)
  } finally { await h.close() }
})

test('missing source directories do not prevent attaching or viewing managed images', async () => {
  const { scope, cwd } = fixture(), missing = path.join(cwd, 'removed-project'), h = runtime()
  try {
    const a = await h.api.upload(scope, imageInput, missing)
    assert.equal((await h.api.media(scope, a.path, missing)).kind, 'image')
    assert.equal((await h.api.media(scope, path.relative(managedAssetDirectory(scope)!, a.path), missing)).kind, 'image')
    assert.equal(fs.existsSync(missing), false)
    await assert.rejects(h.api.start(request({ directory: missing, assetScopeId: scope, attachments: [a] })), /不存在/)
  } finally { await h.close() }
})

test('media reads on an unknown scope create no workspace and never search other scopes', async () => {
  const { scope, cwd } = fixture(), otherScope = randomUUID(), h = runtime()
  try {
    const a = await h.api.upload(scope, imageInput, cwd)
    await assert.rejects(h.api.media(otherScope, a.path), /不存在/)
    await assert.rejects(h.api.media(otherScope, a.path, cwd), /工作空间/)
    assert.equal(managedAssetDirectory(otherScope), undefined)
    await assert.rejects(h.api.media('../escape', a.path, cwd), /编号/)
  } finally { await h.close() }
})

test('attachments accept both explicit source cwd and the fixed parent asset root', async () => {
  const { cwd, scope } = fixture(), managed = managedAssetDirectory(scope, true)!
  const old = await uploadAttachment(cwd, { name: 'old.txt', data: Buffer.from('legacy asset').toString('base64') })
  const current = await uploadAttachment(managed, imageInput)
  const resolved = resolveAttachments(cwd, [old, { ...current, mime: 'application/octet-stream', size: 0 }], managed)
  assert.equal(resolved[0].path, old.path)
  assert.equal(resolved[1].mime, 'image/png')
  assert.equal(resolved[1].size, png.length)
  assert.throws(() => resolveAttachments(cwd, [current]), /当前对话/)
})

test('attachments and previews reject sibling scope files and directory junction escapes', async () => {
  const { cwd, scope, other } = fixture(), managed = managedAssetDirectory(scope, true)!
  const foreign = await uploadAttachment(other, imageInput)
  assert.throws(() => resolveAttachments(cwd, [foreign], managed), /当前对话/)
  assert.throws(() => previewWorkspaceImage(cwd, foreign.path, managed), /工作空间/)
  junction(other, path.join(managed, 'linked'))
  const link = path.join(managed, 'linked', 'attachments', path.basename(foreign.path))
  assert.throws(() => resolveAttachments(cwd, [{ ...foreign, path: link }], managed), /链接/)
  assert.throws(() => previewWorkspaceImage(cwd, link, managed), /链接/)
})

test('uploads cannot follow an attachments junction even to another folder in the same scope', async () => {
  const { scope } = fixture(), managed = managedAssetDirectory(scope, true)!, sibling = path.join(managed, 'other')
  fs.mkdirSync(sibling)
  junction(sibling, path.join(managed, 'attachments'))
  await assert.rejects(uploadAttachment(managed, imageInput), /链接/)
  assert.deepEqual(fs.readdirSync(sibling), [])
})

test('an attachments junction swapped at open receives no upload bytes before rejection', async () => {
  const { scope, other } = fixture(), managed = managedAssetDirectory(scope, true)!
  const original = fs.promises.open, directory = path.join(managed, 'attachments')
  let swapped = false
  fs.promises.open = (async (file, ...args) => {
    if (path.dirname(String(file)) === directory && !swapped) {
      swapped = true
      fs.renameSync(directory, `${directory}-original`)
      junction(other, directory)
    }
    return original(file, ...args)
  }) as typeof original
  try {
    await assert.rejects(uploadAttachment(managed, imageInput), /链接|变化/)
    assert.equal(swapped, true)
    for (const file of fs.readdirSync(other)) assert.equal(fs.statSync(path.join(other, file)).size, 0, 'a rejected open must never write the attachment into the outside root')
  } finally { fs.promises.open = original }
})

test('a regular scope directory replaced at open receives no bytes before identity rejection', async () => {
  const { scope } = fixture(), managed = managedAssetDirectory(scope, true)!
  const original = fs.promises.open
  let swapped = false
  fs.promises.open = (async (file, ...args) => {
    if (String(file).startsWith(managed + path.sep) && !swapped) {
      swapped = true
      fs.renameSync(managed, `${managed}-original`)
      fs.mkdirSync(path.join(managed, 'attachments'), { recursive: true })
    }
    return original(file, ...args)
  }) as typeof original
  try {
    await assert.rejects(uploadAttachment(managed, imageInput), /变化/)
    assert.equal(swapped, true)
    for (const file of fs.readdirSync(path.join(managed, 'attachments')))
      assert.equal(fs.statSync(path.join(managed, 'attachments', file)).size, 0)
  } finally { fs.promises.open = original }
})

test('a file name replaced after open cannot receive bytes through the abandoned descriptor', async () => {
  const { scope } = fixture(), managed = managedAssetDirectory(scope, true)!
  const original = fs.promises.open
  let abandoned: string | undefined
  fs.promises.open = (async (file, ...args) => {
    const handle = await original(file, ...args)
    if (String(file).startsWith(managed + path.sep)) {
      abandoned = `${file}-abandoned`
      fs.renameSync(String(file), abandoned)
      fs.writeFileSync(String(file), '')
    }
    return handle
  }) as typeof original
  try {
    await assert.rejects(uploadAttachment(managed, imageInput), /变化/)
    assert.ok(abandoned)
    assert.equal(fs.statSync(abandoned).size, 0)
  } finally { fs.promises.open = original }
})

test('inline and session images become managed assets while existing source images stay readable', () => {
  const { cwd, scope } = fixture(), managed = managedAssetDirectory(scope, true)!
  const images = collectRunImages({ type: 'image', data: imageInput.data, mimeType: 'image/png' }, cwd, undefined, managed)
  assert.equal(images.length, 1)
  assert.equal(path.dirname(images[0].path!), path.join(managed, 'images'))
  assert.deepEqual(fs.readdirSync(cwd), [])
  assert.equal(collectRunImages({ path: images[0].path }, cwd, undefined, managed)[0].path, images[0].path)
  const local = path.join(cwd, 'local.png')
  fs.writeFileSync(local, png)
  assert.equal(collectRunImages({ path: local }, cwd, undefined, managed)[0].path, local)
  const session = path.join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(cwd), 'fixture-session', 'images')
  fs.mkdirSync(session, { recursive: true })
  const sessionImage = path.join(session, 'session.png')
  fs.writeFileSync(sessionImage, png)
  const copied = collectRunImages({ path: sessionImage }, cwd, 'fixture-session', managed)[0]
  assert.equal(copied.path, images[0].path)
  assert.equal(copied.sourcePath, sessionImage)
  assert.equal(fs.existsSync(path.join(cwd, 'images')), false)
})

test('managed collection still rejects outside secrets and unsafe output links', () => {
  const { cwd, scope, other } = fixture(), managed = managedAssetDirectory(scope, true)!
  const secret = path.join(other, 'private.png')
  fs.writeFileSync(secret, png)
  assert.deepEqual(collectRunImages({ path: secret }, cwd, undefined, managed), [])
  junction(other, path.join(managed, 'images'))
  assert.deepEqual(collectRunImages({ type: 'image', data: imageInput.data, mimeType: 'image/png' }, cwd, undefined, managed), [])
  assert.deepEqual(fs.readdirSync(other), ['private.png'])
})

test('plain text and remote image replies do not allocate an asset directory', () => {
  const { cwd } = fixture()
  const unavailable = () => assert.fail('must not request writable root')
  assert.deepEqual(collectRunImages({ text: 'plain text' }, cwd, undefined, unavailable), [])
  assert.equal(collectRunImages({ path: 'https://example.test/image.png' }, cwd, undefined, unavailable)[0].path, 'https://example.test/image.png')
})

test('asset scope is validated independently and does not authorize private assistant context', () => {
  validateRequest(request({ assetScopeId: 'parent-project' }))
  for (const assetScopeId of ['', '../parent', 7, 'a'.repeat(101)])
    assert.throws(() => validateRequest(request({ assetScopeId: assetScopeId as string })), /资源空间/)
  assert.throws(() => validateRequest(request({ assetScopeId: 'parent', privateContext: [{ author: 'you', text: 'private' }] })), /私有对话/)
})

test('a child worker uses the parent assets while its run and source cwd remain the child identity', async () => {
  const { scope, cwd } = fixture(), child = randomUUID(), seen: any[] = []
  const h = runtime(async input => { seen.push(input); input.media?.({ type: 'image', data: imageInput.data, mimeType: 'image/png' }) })
  try {
    const a = await h.api.upload(scope, imageInput, cwd)
    const r = request({ workspaceId: child, assetScopeId: scope, directory: cwd, attachments: [a] })
    await h.api.start(r)
    const result = await terminal(h, r.id)
    assert.equal(result.status, 'completed')
    assert.equal(result.workspaceId, child)
    assert.equal(result.assistantScopeId, undefined)
    assert.equal(result.replies[0].cwd, cwd)
    assert.equal(seen[0].attachments[0].path, a.path)
    assert.ok(result.replies[0].images![0].path!.startsWith(managedAssetDirectory(scope)! + path.sep))
    assert.equal(managedAssetDirectory(child), undefined)
    assert.deepEqual(fs.readdirSync(cwd), [])
  } finally { await h.close() }
})

test('legacy requests without assetScopeId keep assistant scope fallback, then workspace scope', async () => {
  const { scope, cwd } = fixture(), h = runtime()
  try {
    const a = await h.api.upload(scope, imageInput)
    for (const patch of [{ workspaceId: randomUUID(), assistantScopeId: scope }, { workspaceId: scope }]) {
      const r = request({ ...patch, directory: cwd, attachments: [a] })
      await h.api.start(r)
      assert.equal((await terminal(h, r.id)).status, 'completed')
    }
  } finally { await h.close() }
})

test('gallery preserves child grouping while resolving local images through the parent scope', async () => {
  const project = createWorkspace('project', 'codex'), child = createWorkspace('conversation', 'codex', 'Child', '', project)
  child.messages = [{ id: 'image', author: child.members[0].id, to: 'you', text: '', images: [{ path: '/fixture.png' }], time: '', kind: 'message', sample: false }]
  const items = collectGalleryImages([project, child])
  assert.equal(items.length, 1)
  assert.equal(items[0].workspaceId, child.id)
  assert.equal(items[0].assetScopeId, project.id)
  const original = runtimeClient.media
  try {
    runtimeClient.media = async (id, source) => {
      assert.equal(id, project.id)
      assert.equal(source, '/fixture.png')
      return { kind: 'image', path: source, name: 'fixture.png', ext: 'png', mime: 'image/png', size: png.length, dataUrl: `data:image/png;base64,${imageInput.data}` }
    }
    assert.equal(await galleryImageData(items[0]), `data:image/png;base64,${imageInput.data}`)
  } finally { runtimeClient.media = original }
})

test('closed runtimes refuse both uploads and previews', async () => {
  const { scope } = fixture(), h = runtime()
  const a = await h.api.upload(scope, imageInput)
  await h.close()
  await assert.rejects(h.api.upload(scope, imageInput), /已关闭/)
  await assert.rejects(h.api.media(scope, a.path), /已关闭/)
})
