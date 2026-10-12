import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createPortableBackupService } from '../src/main/portable-backup'
import { assetReferences, parsePortableWorkspace, serializePortableWorkspace, validatePortableManifest, workspaceScopes, remapPortableWorkspace, type PortableManifest } from '../src/main/portable-manifest'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { getAssistant, saveAssistantMemory, saveAssistantCommitment, listDueAssistantCommitments } from '../src/main/runtime/assistant-store'
import { readPortableArchive, writePortableArchive } from '../src/main/portable-archive'
import { extractMediaFromText } from '../src/shared/media'
import type { WorkspaceBackupState } from '../src/renderer/src/lib/workspace-backup'
import { PORTABLE_LIMITS } from '../src/shared/portable-backup'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMKkAAAAASUVORK5CYII=', 'base64')
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(t: TestContext) {
  const parent = path.resolve('.tmp/portable-backup-service-tests'); fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'case-')), workspaces = path.join(root, 'workspaces'), jobs = path.join(root, 'jobs')
  fs.mkdirSync(workspaces)
  const previousHome = process.env.GROK_HOME; process.env.GROK_HOME = path.join(root, 'home')
  t.after(() => {
    if (previousHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousHome
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert.ok(path.basename(root).startsWith('case-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const archive = path.join(root, 'portable.zip')
  const service = (overrides: Partial<Parameters<typeof createPortableBackupService>[0]> = {}) => createPortableBackupService({
    root: jobs, workspacesRoot: workspaces, busy: () => false, chooseArchive: async () => archive,
    chooseDestination: async () => archive, chooseSourceDirectory: async () => null, ...overrides
  })
  return { root, workspaces, jobs, archive, service }
}
function state(id = 'original-scope'): WorkspaceBackupState {
  const team = createWorkspace('conversation', 'grok'); team.id = id
  return { teams: [team], activeTeamId: id, drafts: { [id]: 'kept draft' }, attachmentDrafts: {}, defaultProvider: 'grok', modelDefaults: {}, deletedGalleryKeys: [] }
}
function attach(source: WorkspaceBackupState, root: string, content = Buffer.from('synthetic file')) {
  const dir = path.join(root, 'attachments'); fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}-fixture.txt`); fs.writeFileSync(file, content)
  source.attachmentDrafts[source.activeTeamId] = [{ id: randomUUID(), name: 'fixture.txt', path: file, size: content.length, mime: 'text/plain' }]
  return file
}
async function noAssetsManifest(source = state()): Promise<PortableManifest> {
  return { format: 'independent-workspace-backup', version: 1, createdAt: new Date().toISOString(),
    workspace: JSON.parse(serializePortableWorkspace(source)), assistants: await Promise.all(workspaceScopes(source).map(async (scopeId) => ({ scopeId, snapshot: await getAssistant(scopeId) }))), resources: [] }
}

test('portable service round trip remaps scopes, preserves assets/memory and pauses reminders without touching original files', async (t) => {
  const f = fixture(t), original = state(), sourceDir = path.join(f.workspaces, original.activeTeamId)
  const file = attach(original, sourceDir), sourceBytes = fs.readFileSync(file)
  await saveAssistantMemory(original.activeTeamId, { kind: 'fact', content: 'Synthetic retained memory' })
  await saveAssistantCommitment(original.activeTeamId, { title: 'Synthetic overdue reminder', dueAt: '2026-01-01T00:00:00Z' })
  const before = await getAssistant(original.activeTeamId), exporting = f.service()
  const preview = await exporting.beginExport(serializePortableWorkspace(original))
  assert.equal(preview.counts.files, 1); assert.equal(preview.warnings.length, 0)
  await exporting.writeExport(preview.token, false)
  const restoring = f.service(), imported = (await restoring.inspectImport())!
  const plan = await restoring.prepareRestore(imported.token, false), restored = parsePortableWorkspace(plan.workspaceText)
  assert.notEqual(restored.activeTeamId, original.activeTeamId)
  const copied = restored.attachmentDrafts[restored.activeTeamId][0].path
  assert.notEqual(copied, file); assert.deepEqual(fs.readFileSync(copied), sourceBytes)
  assert.deepEqual(fs.readFileSync(file), sourceBytes); assert.deepEqual(await getAssistant(original.activeTeamId), before)
  const assistant = await getAssistant(restored.activeTeamId)
  assert.equal(assistant.memories[0].content, 'Synthetic retained memory'); assert.equal(assistant.remindersPaused, true)
  await assert.rejects(restoring.cancel(), /提交/)
  await restoring.reconcile(plan.operationId, workspaceScopes(restored))
  assert.equal(restoring.locked(), false); assert.deepEqual(restoring.activeScopes(), workspaceScopes(restored))
  assert.deepEqual(await listDueAssistantCommitments(Date.now(), restoring.activeScopes()), [])
  const restarted = f.service(); await restarted.reconcile(plan.operationId, workspaceScopes(restored))
  assert.deepEqual(restarted.activeScopes(), workspaceScopes(restored))
})
test('external roots require native selection and rejected files need explicit incomplete acknowledgement', async (t) => {
  const f = fixture(t), source = state(), external = path.join(f.root, 'external'), outside = path.join(f.root, 'outside')
  const file = attach(source, external); source.teams[0].directory = external
  fs.mkdirSync(outside); const privateFile = path.join(outside, 'private.txt'); fs.writeFileSync(privateFile, 'synthetic private')
  source.attachmentDrafts[source.activeTeamId].push({ id: randomUUID(), name: 'private.txt', path: privateFile, size: 17, mime: 'text/plain' })
  let selections = 0
  const service = f.service({ chooseSourceDirectory: async (_name, requested) => { selections++; assert.equal(requested, external); return external } })
  const preview = await service.beginExport(serializePortableWorkspace(source))
  assert.equal(selections, 1); assert.equal(preview.counts.files, 1); assert.equal(preview.warnings.length, 1)
  await assert.rejects(service.writeExport(preview.token, false), /确认/)
  await service.writeExport(preview.token, true)
  const stage = path.join(f.root, 'inspect'); fs.mkdirSync(stage)
  const result = await readPortableArchive(f.archive, stage)
  assert.deepEqual([...result.assets.keys()], [digest(fs.readFileSync(file))])
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'synthetic private')
})
test('a linked internal workspace cannot grant implicit access to an external attachment directory', async (t) => {
  const f = fixture(t), source = state(), outside = path.join(f.root, 'outside')
  const privateFile = attach(source, outside)
  const internal = path.join(f.workspaces, source.activeTeamId)
  fs.symlinkSync(outside, internal, process.platform === 'win32' ? 'junction' : 'dir')
  source.attachmentDrafts[source.activeTeamId][0].path = path.join(internal, 'attachments', path.basename(privateFile))
  let selections = 0
  const service = f.service({ chooseSourceDirectory: async () => { selections++; return null } })
  const preview = await service.beginExport(serializePortableWorkspace(source))
  assert.equal(selections, 0); assert.equal(preview.counts.files, 0); assert.equal(preview.warnings.length, 1)
  await service.cancel(preview.token)
})
test('unknown/duplicate resource bindings, wrong scope and unreferenced assets are rejected', async (t) => {
  fixture(t)
  const source = state(); source.drafts[source.activeTeamId] = '![fixture](images/fixture.png)'
  const resource = { key: assetReferences(source)[0].key, hash: digest(png), size: png.length, extension: 'png' }
  const manifest = { ...await noAssetsManifest(source), resources: [resource] }, assets = new Map([[digest(png), { path: 'synthetic-only', size: png.length }]])
  assert.ok(validatePortableManifest(manifest, assets))
  assert.throws(() => validatePortableManifest({ ...manifest, resources: [{ ...resource, key: JSON.stringify(['other-scope', 'draft-image', '0']) }] }, assets), /未知|引用/)
  assert.throws(() => validatePortableManifest({ ...manifest, resources: [resource, resource] }, assets), /清单/)
  assert.throws(() => validatePortableManifest({ ...manifest, assistants: [{ ...manifest.assistants[0], scopeId: 'other-scope' }] }, assets), /所属/)
  assert.throws(() => validatePortableManifest({ ...manifest, resources: [{ ...resource, extension: 'bin' }] }, assets), /图片/)
  assert.throws(() => validatePortableManifest(manifest, new Map([...assets, ['0'.repeat(64), { path: 'unused', size: 1 }]])), /额外/)
})
test('deduplicated archive assets cannot expand into too many restored attachment bytes', async (t) => {
  const f = fixture(t), source = state(), bytes = Buffer.alloc(8192, 65), file = attach(source, path.join(f.workspaces, source.activeTeamId), bytes)
  const attachment = source.attachmentDrafts[source.activeTeamId][0]
  source.attachmentDrafts[source.activeTeamId] = Array.from({ length: 4 }, () => ({ ...attachment, id: randomUUID() }))
  const manifest = { ...await noAssetsManifest(source), resources: assetReferences(source).map((ref) => ({ key: ref.key, hash: digest(bytes), size: bytes.length, extension: 'bin' })) }
  await writePortableArchive(f.archive, manifest, [{ hash: digest(bytes), path: file, size: bytes.length }])
  const service = f.service(), preview = (await service.inspectImport())!, before = fs.readdirSync(f.workspaces)
  assert.equal(preview.counts.files, 1)
  const originalLimit = PORTABLE_LIMITS.totalAssetBytes
  ;(PORTABLE_LIMITS as { totalAssetBytes: number }).totalAssetBytes = 24 * 1024
  try { await assert.rejects(service.prepareRestore(preview.token, false), /恢复后的文件总大小/) }
  finally { (PORTABLE_LIMITS as { totalAssetBytes: number }).totalAssetBytes = originalLimit }
  assert.deepEqual(fs.readdirSync(f.workspaces), before)
  assert.equal(service.locked(), false)
  assert.equal(fs.existsSync(path.join(f.jobs, 'pending-restore.json')), false)
})
test('an archive with a forged image type fails before any restored scope is created', async (t) => {
  const f = fixture(t), source = state(), bytes = Buffer.from('synthetic text, not PNG'), file = path.join(f.root, 'fake-image')
  source.drafts[source.activeTeamId] = '![fixture](images/fixture.png)'; fs.writeFileSync(file, bytes)
  const manifest = { ...await noAssetsManifest(source), resources: [{ key: assetReferences(source)[0].key, hash: digest(bytes), size: bytes.length, extension: 'png' }] }
  await writePortableArchive(f.archive, manifest, [{ hash: digest(bytes), path: file, size: bytes.length }])
  const service = f.service()
  await assert.rejects(service.inspectImport(), /图片内容/)
  assert.deepEqual(fs.readdirSync(f.workspaces), []); assert.deepEqual(fs.readdirSync(f.jobs), [])
  assert.equal(service.locked(), false)
})
test('cancel while native source selection is pending stops capture and releases the job after unwind', async (t) => {
  const f = fixture(t), source = state(), external = path.join(f.root, 'external'); attach(source, external); source.teams[0].directory = external
  let resolve!: (value: string | null) => void, selected = false
  const service = f.service({ chooseSourceDirectory: () => { selected = true; return new Promise((accept) => { resolve = accept }) } })
  const pending = service.beginExport(serializePortableWorkspace(source)); void pending.catch(() => {})
  while (!selected) await tick()
  assert.equal(service.locked(), true); await service.cancel(); resolve(external)
  await assert.rejects(pending, /取消/); assert.equal(service.locked(), false)
  assert.deepEqual(fs.readdirSync(f.jobs), [])
})
test('a pre-existing durable restore journal blocks new work until readable-head reconciliation', async (t) => {
  const f = fixture(t); fs.mkdirSync(f.jobs); const operationId = randomUUID()
  fs.writeFileSync(path.join(f.jobs, 'pending-restore.json'), JSON.stringify({ version: 1, operationId, scopes: [randomUUID()], kind: 'restore' }))
  const service = f.service()
  await assert.rejects(service.beginExport(serializePortableWorkspace(state())), /已有/)
  await service.reconcile(null, ['original-scope'])
  assert.equal(service.locked(), false); assert.equal(fs.existsSync(path.join(f.jobs, 'pending-restore.json')), false)
  const record = JSON.parse(fs.readFileSync(path.join(f.jobs, `restore-${operationId}.json`), 'utf8'))
  assert.equal(record.outcome, 'not-committed')
})
test('reconciliation cannot clear the lock while the prepare journal is still being published', async (t) => {
  const f = fixture(t); await writePortableArchive(f.archive, await noAssetsManifest(), [])
  const service = f.service(), preview = (await service.inspectImport())!, rename = fsp.rename
  let reached = false, release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  fsp.rename = (async (...args: Parameters<typeof fsp.rename>) => {
    if (String(args[1]) === path.join(f.jobs, 'pending-restore.json')) { reached = true; await gate }
    return rename(...args)
  }) as typeof rename
  const pending = service.prepareRestore(preview.token, false); void pending.catch(() => {})
  try {
    while (!reached) await tick()
    await assert.rejects(service.reconcile(null, ['original-scope']), /进行|提交/)
  } finally { release(); fsp.rename = rename }
  const plan = await pending
  assert.equal(service.locked(), true)
  await service.reconcile(plan.operationId, workspaceScopes(parsePortableWorkspace(plan.workspaceText)))
})
test('a failed durable ACK retains the pending journal and lock, then retries idempotently', async (t) => {
  const f = fixture(t); await writePortableArchive(f.archive, await noAssetsManifest(), [])
  const service = f.service(), preview = (await service.inspectImport())!, plan = await service.prepareRestore(preview.token, false)
  const scopes = workspaceScopes(parsePortableWorkspace(plan.workspaceText)), rename = fsp.rename
  fsp.rename = (async (...args: Parameters<typeof fsp.rename>) => {
    if (String(args[1]) === path.join(f.jobs, `restore-${plan.operationId}.json`)) throw new Error('synthetic ACK disk failure')
    return rename(...args)
  }) as typeof rename
  try { await assert.rejects(service.reconcile(plan.operationId, scopes), /ACK disk failure/) }
  finally { fsp.rename = rename }
  assert.equal(service.locked(), true); assert.deepEqual(service.activeScopes(), [])
  assert.equal(fs.existsSync(path.join(f.jobs, 'pending-restore.json')), true)
  await service.reconcile(plan.operationId, scopes)
  await service.reconcile(plan.operationId, scopes)
  assert.equal(service.locked(), false); assert.deepEqual(service.activeScopes(), scopes)
  assert.equal(fs.existsSync(path.join(f.jobs, 'pending-restore.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.jobs, `restore-${plan.operationId}.json`), 'utf8')).outcome, 'committed')
})
test('a partial asset write cannot publish a restore plan or change the original workspace/assistant', async (t) => {
  const f = fixture(t), source = state(), originalFile = attach(source, path.join(f.workspaces, source.activeTeamId)), bytes = fs.readFileSync(originalFile)
  await saveAssistantMemory(source.activeTeamId, { kind: 'fact', content: 'Original retained memory' })
  const before = await getAssistant(source.activeTeamId), exporter = f.service(), exporting = await exporter.beginExport(serializePortableWorkspace(source))
  await exporter.writeExport(exporting.token, false)
  const service = f.service(), preview = (await service.inspectImport())!, write = fs.writeFileSync
  let injected = false
  fs.writeFileSync = ((...args: any[]) => {
    if (!injected && typeof args[0] === 'number' && Buffer.isBuffer(args[1])) {
      injected = true; fs.writeSync(args[0], args[1].subarray(0, 3)); throw Object.assign(new Error('synthetic disk full during asset copy'), { code: 'EIO' })
    }
    return (write as any)(...args)
  }) as typeof write
  try { await assert.rejects(service.prepareRestore(preview.token, false), /disk full/) }
  finally { fs.writeFileSync = write }
  assert.equal(injected, true)
  assert.equal(service.locked(), false); assert.equal(fs.existsSync(path.join(f.jobs, 'pending-restore.json')), false)
  assert.deepEqual(fs.readFileSync(originalFile), bytes); assert.deepEqual(await getAssistant(source.activeTeamId), before)
  assert.deepEqual(service.activeScopes(), [])
  assert.deepEqual(fs.readdirSync(f.workspaces), [source.activeTeamId])
  assert.equal(fs.readdirSync(f.jobs).some((name) => name.startsWith('job-')), false)
})
test('cancelling after the first restored file removes new directories but preserves the original files', async (t) => {
  const f = fixture(t), source = state(), file = attach(source, path.join(f.workspaces, source.activeTeamId))
  source.attachmentDrafts[source.activeTeamId].push({ ...source.attachmentDrafts[source.activeTeamId][0], id: randomUUID() })
  const exporter = f.service(), exported = await exporter.beginExport(serializePortableWorkspace(source)); await exporter.writeExport(exported.token, false)
  const service = f.service(), preview = (await service.inspectImport())!, sync = fs.fsyncSync
  let cancelled = false
  fs.fsyncSync = ((fd: number) => {
    sync(fd)
    if (!cancelled) { cancelled = true; void service.cancel(preview.token) }
  }) as typeof sync
  try { await assert.rejects(service.prepareRestore(preview.token, false), /取消/) }
  finally { fs.fsyncSync = sync }
  assert.equal(cancelled, true); assert.equal(service.locked(), false)
  assert.deepEqual(fs.readdirSync(f.workspaces), [source.activeTeamId]); assert.equal(fs.existsSync(file), true)
  assert.deepEqual(fs.readdirSync(f.jobs), [])
})
test('cancellation after the first assistant replica was written discards newly imported assistant files', async (t) => {
  const f = fixture(t), source = state()
  await saveAssistantMemory(source.activeTeamId, { kind: 'fact', content: 'Original scope memory' })
  const assistants = path.join(process.env.GROK_HOME!, 'desktop', 'assistants'), oldFiles = fs.readdirSync(assistants)
  await writePortableArchive(f.archive, await noAssetsManifest(source), [])
  const service = f.service(), preview = (await service.inspectImport())!, open = fsp.open
  let cancelled = false
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args)
    if (!cancelled && String(args[0]).startsWith(assistants + path.sep) && String(args[0]).endsWith('.json.bak')) {
      const write = handle.writeFile.bind(handle)
      handle.writeFile = (async (...values: Parameters<typeof handle.writeFile>) => {
        await write(...values); cancelled = true; await service.cancel(preview.token)
      }) as typeof handle.writeFile
    }
    return handle
  }) as typeof open
  try { await assert.rejects(service.prepareRestore(preview.token, false), /取消/) }
  finally { fsp.open = open }
  assert.equal(cancelled, true); assert.equal(service.locked(), false)
  assert.deepEqual(fs.readdirSync(assistants), oldFiles); assert.deepEqual(fs.readdirSync(f.workspaces), [])
  assert.equal((await getAssistant(source.activeTeamId)).memories[0].content, 'Original scope memory')
})
test('an EIO after partial assistant JSON writes removes both new replicas and the uncommitted directory', async (t) => {
  const f = fixture(t), source = state()
  await saveAssistantMemory(source.activeTeamId, { kind: 'fact', content: 'Preserve original assistant' })
  const assistants = path.join(process.env.GROK_HOME!, 'desktop', 'assistants'), oldFiles = fs.readdirSync(assistants)
  await writePortableArchive(f.archive, await noAssetsManifest(source), [])
  const service = f.service(), preview = (await service.inspectImport())!, open = fsp.open
  let injected = false
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args)
    if (!injected && String(args[0]).startsWith(assistants + path.sep) && String(args[0]).endsWith('.json')) {
      handle.writeFile = (async () => {
        injected = true; await handle.write(Buffer.from('{partial'))
        throw Object.assign(new Error('synthetic assistant EIO after partial write'), { code: 'EIO' })
      }) as typeof handle.writeFile
    }
    return handle
  }) as typeof open
  try { await assert.rejects(service.prepareRestore(preview.token, false), /assistant EIO/) }
  finally { fsp.open = open }
  assert.equal(injected, true); assert.equal(service.locked(), false)
  assert.deepEqual(fs.readdirSync(assistants), oldFiles); assert.deepEqual(fs.readdirSync(f.workspaces), [])
  assert.equal((await getAssistant(source.activeTeamId)).memories[0].content, 'Preserve original assistant')
})
test('a replaced job directory is preserved instead of recursively deleting unknown files', async (t) => {
  const f = fixture(t); await writePortableArchive(f.archive, await noAssetsManifest(), [])
  const service = f.service(), preview = (await service.inspectImport())!
  const directory = path.join(f.jobs, fs.readdirSync(f.jobs).find((name) => name.startsWith('job-'))!)
  fs.renameSync(directory, directory + '-original'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'unrelated'), 'keep unrelated')
  await assert.rejects(service.cancel(preview.token), /目录已变化/)
  assert.equal(fs.readFileSync(path.join(directory, 'unrelated'), 'utf8'), 'keep unrelated')
  assert.equal(fs.existsSync(directory + '-original'), true); assert.equal(service.locked(), true)
})
test('an unknown prepare journal retains new recovery directories instead of guessing that deletion is safe', async (t) => {
  const f = fixture(t), source = state(), file = attach(source, path.join(f.workspaces, source.activeTeamId))
  const exporter = f.service(), exported = await exporter.beginExport(serializePortableWorkspace(source)); await exporter.writeExport(exported.token, false)
  const service = f.service(), preview = (await service.inspectImport())!, write = fs.writeFileSync
  const unknown = '{synthetic interrupted journal'
  let injected = false
  fs.writeFileSync = ((...args: any[]) => {
    if (!injected && typeof args[0] === 'number' && Buffer.isBuffer(args[1])) {
      injected = true; fs.writeSync(args[0], args[1].subarray(0, 3)); write(path.join(f.jobs, 'pending-restore.json'), unknown)
      throw new Error('synthetic disk failure with unknown journal')
    }
    return (write as any)(...args)
  }) as typeof write
  try { await assert.rejects(service.prepareRestore(preview.token, false), /unknown journal/) }
  finally { fs.writeFileSync = write }
  assert.equal(service.locked(), true); assert.equal(fs.readdirSync(f.workspaces).length, 2)
  assert.equal(fs.readFileSync(path.join(f.jobs, 'pending-restore.json'), 'utf8'), unknown)
  assert.equal(fs.existsSync(file), true)
})
test('changed directory identities are retained during failed-restore cleanup', async (t) => {
  const f = fixture(t), source = state(); attach(source, path.join(f.workspaces, source.activeTeamId))
  const exporter = f.service(), exported = await exporter.beginExport(serializePortableWorkspace(source)); await exporter.writeExport(exported.token, false)
  const service = f.service(), preview = (await service.inspectImport())!, open = fs.openSync, close = fs.closeSync
  let replaced = '', targetFd: number | undefined
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args)
    if (args[1] === 'wx' && String(args[0]).startsWith(f.workspaces + path.sep)) targetFd = fd
    return fd
  }) as typeof open
  fs.closeSync = ((fd: number) => {
    close(fd)
    // Windows correctly prevents renaming some directories while a file is
    // open. Replace after close but before the journal's final verification.
    if (!replaced && fd === targetFd) {
      replaced = path.join(f.workspaces, fs.readdirSync(f.workspaces).find((name) => name !== source.activeTeamId)!)
      fs.renameSync(replaced, replaced + '-original'); fs.mkdirSync(replaced); fs.writeFileSync(path.join(replaced, 'unrelated.txt'), 'preserve unrelated')
    }
  }) as typeof close
  try { await assert.rejects(service.prepareRestore(preview.token, false), /目录已被替换/) }
  finally { fs.openSync = open; fs.closeSync = close }
  assert.ok(replaced); assert.equal(fs.readFileSync(path.join(replaced, 'unrelated.txt'), 'utf8'), 'preserve unrelated')
  assert.equal(fs.existsSync(replaced + '-original'), true)
})
test('a restored attachment parent swapped to a junction before open cannot receive attachment content', async (t) => {
  const f = fixture(t), source = state(); attach(source, path.join(f.workspaces, source.activeTeamId), Buffer.from('SYNTHETIC-PRIVATE-CONTENT'))
  const exporter = f.service(), exported = await exporter.beginExport(serializePortableWorkspace(source)); await exporter.writeExport(exported.token, false)
  const service = f.service(), preview = (await service.inspectImport())!, open = fs.openSync
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  let swapped = false
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const target = String(args[0])
    if (!swapped && args[1] === 'wx' && target.startsWith(f.workspaces + path.sep) && path.basename(path.dirname(target)) === 'attachments') {
      swapped = true; const parent = path.dirname(target)
      fs.renameSync(parent, parent + '-original'); fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
    }
    return open(...args)
  }) as typeof open
  try { await assert.rejects(service.prepareRestore(preview.token, false), /链接|变化|替换/) }
  finally { fs.openSync = open }
  assert.equal(swapped, true); assert.equal(service.locked(), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  for (const name of fs.readdirSync(outside).filter((name) => name !== 'keep.txt')) assert.equal(fs.statSync(path.join(outside, name)).size, 0)
  assert.deepEqual(fs.readdirSync(f.workspaces), [source.activeTeamId])
})
test('JSON-escaped Windows media paths and overlapping paths are remapped without stale references', async (t) => {
  fixture(t)
  for (const draft of [JSON.stringify({ path: 'C:\\synthetic\\picture.png' }), '![a](images/picture.png) ![b](images/picture.png.other.png)']) {
    const source = state(); source.drafts[source.activeTeamId] = draft
    const refs = assetReferences(source), manifest = { ...await noAssetsManifest(source), resources: refs.map((ref, index) => ({ key: ref.key, hash: digest(Buffer.from(String(index))), size: 1, extension: 'png' })) }
    const mapped = remapPortableWorkspace(source, manifest, (id) => path.resolve('.tmp/portable-test-target', id))
    const actual = extractMediaFromText(mapped.state.drafts[mapped.state.activeTeamId]).map((image) => path.normalize(image.path!)).sort()
    const expected = [...new Set(mapped.copies.map((copy) => path.normalize(copy.destination)))].sort()
    assert.deepEqual(actual, expected)
  }
})
