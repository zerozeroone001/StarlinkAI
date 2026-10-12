import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createAssistantStore, validateAssistantSnapshot, AssistantRevisionConflictError } from '../src/main/runtime/assistant-store'

function fixture() {
  const base = path.resolve('.tmp'); fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'assistant-portable-'))
  return { root, store: createAssistantStore(root), file: (scope: string) => path.join(root, `${createHash('sha256').update(scope).digest('hex')}.json`),
    close: () => { assert.ok(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }) } }
}
const dueAt = '2000-01-01T00:00:00.000Z'

test('portable assistant roundtrip retains facts, timestamps, revision and notification history while remapping scope and pausing', async () => {
  const f = fixture()
  try {
    await f.store.update('source', { name: '跨机器助理', persona: '保留人格与上下文', addressing: '开发者', style: 'warm' })
    await f.store.saveMemory('source', { content: '偏好简洁代码', kind: 'preference', source: 'user' })
    const first = await f.store.saveCommitment('source', { title: '已通知', dueAt })
    await f.store.markNotified('source', first.commitments[0].id, dueAt, '2001-01-01T00:00:00.000Z')
    await f.store.saveCommitment('source', { title: '待通知', dueAt })
    const source = await f.store.exportSnapshot('source'), before = fs.readFileSync(f.file('source'))
    const target = randomUUID(), imported = await f.store.importSnapshot(target, source)
    assert.deepEqual(imported, { ...source, profile: { ...source.profile, scopeId: target }, remindersPaused: true })
    assert.equal(imported.commitments[1].notifiedAt, undefined)
    assert.deepEqual(fs.readFileSync(f.file(target)), fs.readFileSync(f.file(target) + '.bak'))
    assert.deepEqual(fs.readFileSync(f.file('source')), before)
    assert.deepEqual(await createAssistantStore(f.root).exportSnapshot(target), imported)
    assert.deepEqual(await f.store.due(Date.now(), [target]), [])
    assert.equal((await f.store.due(Date.now(), ['source'])).length, 1)
    const resumed = await f.store.setRemindersPaused(target, false, imported.revision)
    assert.equal(resumed.revision, imported.revision + 1)
    assert.equal((await f.store.due(Date.now(), [target, target])).length, 1)
    assert.deepEqual(await f.store.due(Date.now(), []), [])
  } finally { f.close() }
})

test('assistant export uses validated newest replica without repairing or changing source files', async () => {
  const f = fixture()
  try {
    const source = await f.store.saveMemory('scope', { content: '保留', kind: 'fact' })
    fs.writeFileSync(f.file('scope'), '{broken')
    const backup = fs.readFileSync(f.file('scope') + '.bak')
    assert.deepEqual(await f.store.exportSnapshot('scope'), source)
    assert.equal(fs.readFileSync(f.file('scope'), 'utf8'), '{broken')
    assert.deepEqual(fs.readFileSync(f.file('scope') + '.bak'), backup)
    fs.writeFileSync(f.file('scope') + '.bak', '{also broken')
    await assert.rejects(f.store.exportSnapshot('scope'), /无法读取/)
    assert.equal(fs.readFileSync(f.file('scope'), 'utf8'), '{broken')
  } finally { f.close() }
})

test('legacy assistant pause flag defaults false and pause changes require revision CAS without marking notifications', async () => {
  const f = fixture()
  try {
    const original = await f.store.saveCommitment('scope', { title: '待通知', dueAt })
    const legacy = { ...original }; delete legacy.remindersPaused
    assert.equal(validateAssistantSnapshot(legacy, 'scope').remindersPaused, false)
    assert.throws(() => validateAssistantSnapshot({ ...legacy, remindersPaused: 'false' }, 'scope'), /格式无效/)
    const paused = await f.store.setRemindersPaused('scope', true, original.revision)
    assert.equal(paused.commitments[0].notifiedAt, undefined)
    assert.deepEqual(await f.store.markNotified('scope', original.commitments[0].id, dueAt, new Date().toISOString()), paused)
    assert.deepEqual(await f.store.due(Date.now()), [])
    assert.deepEqual(await f.store.setRemindersPaused('scope', true, paused.revision), paused)
    await assert.rejects(f.store.setRemindersPaused('scope', false, original.revision), AssistantRevisionConflictError)
    await assert.rejects(f.store.setRemindersPaused('scope', false, NaN), /预期版本无效/)
    assert.deepEqual(await f.store.get('scope'), paused)
  } finally { f.close() }
})

test('assistant import rejects existing primary or backup, invalid UUID and malformed snapshot without changing files', async () => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), target = randomUUID()
    await assert.rejects(f.store.importSnapshot('ordinary-scope', source), /UUID/)
    assert.throws(() => validateAssistantSnapshot(source, 'different'), /格式无效/)
    await assert.rejects(f.store.importSnapshot(target, { ...source, revision: -1 }), /格式无效/)
    assert.deepEqual(fs.readdirSync(f.root), [])
    for (const suffix of ['', '.bak']) {
      fs.writeFileSync(f.file(target) + suffix, 'existing corrupted evidence')
      await assert.rejects(f.store.importSnapshot(target, source), /已存在/)
      assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file(target) + suffix)])
      assert.equal(fs.readFileSync(f.file(target) + suffix, 'utf8'), 'existing corrupted evidence')
      fs.unlinkSync(f.file(target) + suffix)
    }
  } finally { f.close() }
})

test('concurrent independent assistant imports cannot overwrite a claimed target scope', async () => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), target = randomUUID()
    const result = await Promise.allSettled([f.store.importSnapshot(target, source), createAssistantStore(f.root).importSnapshot(target,
      { ...source, profile: { ...source.profile, name: 'Other writer' } })])
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(result.filter((r) => r.status === 'rejected').length, 1)
    const winner = result.find((r): r is PromiseFulfilledResult<typeof source> => r.status === 'fulfilled')!.value
    assert.deepEqual(await f.store.get(target), winner)
    assert.deepEqual(fs.readFileSync(f.file(target)), fs.readFileSync(f.file(target) + '.bak'))
    assert.equal(fs.readdirSync(f.root).length, 2)
  } finally { f.close() }
})

test('assistant second replica publication failure cleans only the files owned by that import', async () => {
  const f = fixture(), originalOpen = fsp.open
  try {
    const source = await f.store.get('source'), target = randomUUID()
    let opens = 0
    fsp.open = async (...args) => {
      if (++opens === 2) {
        fs.writeFileSync(f.file(target), 'concurrent owner')
        throw Object.assign(new Error('Target exists'), { code: 'EEXIST' })
      }
      return originalOpen(...args)
    }
    await assert.rejects(f.store.importSnapshot(target, source), /Target exists/)
    assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file(target))])
    assert.equal(fs.readFileSync(f.file(target), 'utf8'), 'concurrent owner')
  } finally { fsp.open = originalOpen; f.close() }
})

test('active scope reminder selection never repairs or schedules excluded assistant files', async () => {
  const f = fixture()
  try {
    await f.store.saveCommitment('included', { title: 'Allowed', dueAt })
    await f.store.saveCommitment('excluded', { title: 'Not active', dueAt })
    fs.writeFileSync(f.file('excluded'), '{broken')
    const due = await f.store.due(Date.now(), ['included'])
    assert.equal(due.length, 1); assert.equal(due[0].scopeId, 'included')
    assert.equal(fs.readFileSync(f.file('excluded'), 'utf8'), '{broken')
    await assert.rejects(f.store.due(Date.now(), ['../escape']), /编号无效/)
  } finally { f.close() }
})

test('discarding an uncommitted imported assistant removes matching replicas including a single orphan and is idempotent', async () => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), first = randomUUID(), second = randomUUID()
    await f.store.importSnapshot(first, source)
    await f.store.discardImportedSnapshot(first, source)
    assert.deepEqual(fs.readdirSync(f.root), [])
    await f.store.discardImportedSnapshot(first, source)
    await f.store.importSnapshot(second, source); fs.unlinkSync(f.file(second))
    await f.store.discardImportedSnapshot(second, source)
    assert.deepEqual(fs.readdirSync(f.root), [])
  } finally { f.close() }
})

test('discard preserves modified, unknown and different-source data while removing only an exact original replica', async () => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), target = randomUUID()
    await f.store.importSnapshot(target, source)
    fs.writeFileSync(f.file(target), 'unknown evidence')
    await f.store.discardImportedSnapshot(target, source)
    assert.equal(fs.readFileSync(f.file(target), 'utf8'), 'unknown evidence')
    assert.equal(fs.existsSync(f.file(target) + '.bak'), false)
    fs.unlinkSync(f.file(target))
    await f.store.importSnapshot(target, source)
    const before = fs.readFileSync(f.file(target))
    await f.store.discardImportedSnapshot(target, { ...source, revision: source.revision + 1 })
    assert.deepEqual(fs.readFileSync(f.file(target)), before)
    assert.deepEqual(fs.readFileSync(f.file(target) + '.bak'), before)
    const edited = await f.store.saveMemory(target, { content: '后来保存的记录', kind: 'fact' })
    await f.store.discardImportedSnapshot(target, source)
    assert.deepEqual(await f.store.get(target), edited)
    await assert.rejects(f.store.discardImportedSnapshot('ordinary-scope', source), /UUID/)
  } finally { f.close() }
})

test('discard shares the scope queue with import and does not race an accepted assistant edit', async () => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), target = randomUUID()
    const imported = f.store.importSnapshot(target, source)
    const edit = f.store.saveMemory(target, { content: 'queued before cleanup', kind: 'fact' })
    const discard = f.store.discardImportedSnapshot(target, source)
    await imported; const edited = await edit; await discard
    assert.deepEqual(await f.store.get(target), edited)
  } finally { f.close() }
})

test('discard refuses linked files even when the linked bytes exactly match the imported snapshot', async (t) => {
  const f = fixture()
  try {
    const source = await f.store.get('source'), target = randomUUID()
    await f.store.importSnapshot(target, source)
    const outside = path.join(f.root, 'other-owner.json')
    fs.renameSync(f.file(target), outside)
    try { fs.linkSync(outside, f.file(target)) }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Host cannot create test hard links: ${error.code}`); return }
      throw error
    }
    await f.store.discardImportedSnapshot(target, source)
    assert.equal(fs.existsSync(f.file(target)), true); assert.equal(fs.existsSync(outside), true)
    assert.equal(fs.existsSync(f.file(target) + '.bak'), false)
    assert.deepEqual(fs.readFileSync(f.file(target)), fs.readFileSync(outside))
  } finally { f.close() }
})
