import { createWorkspaceDatabase, WorkspaceDatabaseError } from '../src/renderer/src/lib/workspace-database'
import type { StorageValue } from 'zustand/middleware'
import { batchedStorage } from '../src/renderer/src/lib/batched-storage'

type State = { teams: { id: string; messages: { id: string; text: string }[] }[]; drafts: Record<string, string> }
type Value = StorageValue<State>
const key = 'workspace'
const results: { name: string; ok: boolean; error?: string }[] = []
function assert(value: unknown, message = 'Assertion failed'): asserts value { if (!value) throw Error(message) }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
const same = (a: unknown, b: unknown) => assert(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), 'Snapshot/records differ')
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
const value = (text: string): Value => ({ version: 2, state: { teams: [{ id: text, messages: [{ id: 'message', text }] }], drafts: {} } })
const make = (name: string) => createWorkspaceDatabase<State>({ factory: indexedDB, legacy: () => null, databaseName: name,
  validate: (v) => !!v.state.drafts && v.state.teams.every((t) => Array.isArray(t.messages)) })
async function inspect(name: string, mutate?: (store: IDBObjectStore) => void) {
  const db = await request(indexedDB.open(name, 1))
  try {
    const tx = db.transaction('records', mutate ? 'readwrite' : 'readonly')
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
    const store = tx.objectStore('records'); mutate?.(store)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]); await done
    return keys.map((key, i) => ({ key, value: values[i] }))
  } finally { db.close() }
}
const slot = (rows: Awaited<ReturnType<typeof inspect>>, name: string) => rows.find((r) => JSON.stringify(r.key) === JSON.stringify([key, name]))?.value
async function rejects(promise: Promise<unknown>, code: string) {
  try { await promise } catch (error) { assert(error instanceof WorkspaceDatabaseError && error.code === code, `Expected ${code}: ${String(error)}`); return }
  throw Error(`Expected ${code}`)
}
const close = async (db: ReturnType<typeof make>) => { await db.close().catch(() => {}) }
async function fixture(name: string) { const db = make(name); await db.getItem(key); await db.setItem(key, value('original')); return db }
async function test(name: string, body: (name: string) => Promise<void>) {
  try { await body(`restore-tests-${crypto.randomUUID()}`); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.stack : String(error) }) }
}

export async function runRestoreTests() {
  await test('restore pin survives ordinary saves, GC, restart and rollback can itself be undone', async (name) => {
    let db = await fixture(name)
    await db.commitRestore(key, value('imported'), 'import-1')
    same(slot(await inspect(name), 'head').format, 4)
    same(slot(await inspect(name), 'previous').format, 4)
    same(await db.getRestorePoint(key), value('original')); same(await db.getImportMarker(key), 'import-1')
    let latest = value('imported')
    for (let i = 0; i < 6; i++) { latest = value(`edited-${i}`); await db.setItem(key, latest) }
    await db.close(); db = make(name)
    same(await db.getItem(key), latest); same(await db.getRestorePoint(key), value('original')); same(await db.getImportMarker(key), 'import-1')
    same(await db.rollbackRestore(key, 'rollback-1'), value('original'))
    same(slot(await inspect(name), 'head').format, 4)
    same(await db.getRestorePoint(key), latest); same(await db.getImportMarker(key), 'rollback-1')
    same(await db.rollbackRestore(key, 'undo-rollback'), latest)
    same(await db.getRestorePoint(key), value('original')); same(await db.getImportMarker(key), 'undo-rollback')
    await db.close()
  })
  await test('repeated import pins the immediately preceding workspace and marker without leaking retired rows', async (name) => {
    const db = await fixture(name)
    await db.commitRestore(key, value('second'), 'second-marker')
    await db.commitRestore(key, value('third'), 'third-marker')
    same(await db.getRestorePoint(key), value('second'))
    const rows = await inspect(name)
    same(slot(rows, 'restorePoint').marker, 'second-marker')
    assert(!rows.some((row) => row.value.kind === 'workspace-message' && row.value.value.text === 'original'), 'Unpinned original should be collected')
    same(await db.rollbackRestore(key, 'rollback-marker'), value('second'))
    same(await db.getImportMarker(key), 'rollback-marker'); await db.close()
  })
  await test('restore commit uses strict durability and abort preserves head, previous, marker, pin and every record', async (name) => {
    const db = await fixture(name); await db.commitRestore(key, value('second'), 'second-marker')
    const before = await inspect(name), put = IDBObjectStore.prototype.put
    let strict = false
    IDBObjectStore.prototype.put = function (data, id) {
      strict ||= this.transaction.durability === 'strict'
      const result = put.call(this, data, id)
      if (Array.isArray(id) && id[1] === 'head') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(db.commitRestore(key, value('third'), 'third-marker'), 'unavailable') }
    finally { IDBObjectStore.prototype.put = put }
    assert(strict); same(await inspect(name), before)
    await db.commitRestore(key, value('retry'), 'retry-marker'); same(await db.getRestorePoint(key), value('second')); await db.close()
  })
  await test('rollback abort preserves all records and retry returns the pinned snapshot', async (name) => {
    const db = await fixture(name); await db.commitRestore(key, value('imported'), 'import-marker')
    const before = await inspect(name), put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (data, id) {
      const result = put.call(this, data, id)
      if (Array.isArray(id) && id[1] === 'importMarker') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(db.rollbackRestore(key, 'rollback-marker'), 'unavailable') } finally { IDBObjectStore.prototype.put = put }
    same(await inspect(name), before); same(await db.rollbackRestore(key, 'retry-marker'), value('original')); await db.close()
  })
  await test('head and independent marker both participate in restore CAS', async (name) => {
    const db = await fixture(name), other = make(name)
    await other.getItem(key); await db.commitRestore(key, value('imported'), 'import-marker')
    await rejects(other.commitRestore(key, value('stale'), 'stale-marker'), 'conflict')
    await other.getItem(key)
    await inspect(name, (store) => store.put({ kind: 'workspace-import-marker', value: 'external-marker' }, [key, 'importMarker']))
    const before = await inspect(name)
    await rejects(other.setItem(key, value('stale')), 'conflict'); await rejects(other.rollbackRestore(key, 'stale-rollback'), 'conflict')
    same(await inspect(name), before); await close(db); await close(other)
  })
  await test('malformed restore point blocks save, remove, previous recovery and new import without altering records', async (name) => {
    const db = await fixture(name); await db.commitRestore(key, value('imported'), 'import-marker')
    await inspect(name, (store) => store.put({ kind: 'workspace-restore-point', head: 'broken' }, [key, 'restorePoint']))
    const before = await inspect(name)
    await rejects(db.setItem(key, value('lost')), 'corrupt'); await rejects(db.removeItem(key), 'uninitialized')
    await rejects(db.getRestorePoint(key), 'corrupt'); await rejects(db.recoverPrevious(key), 'corrupt')
    await rejects(db.commitRestore(key, value('lost'), 'next-marker'), 'uninitialized')
    same(await inspect(name), before); await close(db)
  })
  await test('missing pinned item fails hydration and explicit restore without discarding corrupt evidence', async (name) => {
    const db = await fixture(name); await db.commitRestore(key, value('imported'), 'import-marker')
    const rows = await inspect(name), pin = slot(rows, 'restorePoint')
    await inspect(name, (store) => store.delete([key, 'message', pin.head.teams[0].collections.messages[0].key]))
    const before = await inspect(name)
    await rejects(db.getRestorePoint(key), 'corrupt'); await rejects(db.rollbackRestore(key, 'rollback-marker'), 'uninitialized')
    await rejects(db.commitRestore(key, value('lost'), 'next-marker'), 'uninitialized')
    const reopened = make(name); await rejects(reopened.getItem(key), 'corrupt'); await rejects(reopened.setItem(key, value('lost')), 'uninitialized')
    same(await inspect(name), before); await close(db); await close(reopened)
  })
  await test('pinned 12 MiB history adds no body reads or writes to ordinary streaming commits', async (name) => {
    const db = make(name), old = value('original'); old.state.teams[0].messages[0].text = 'x'.repeat(12 * 1024 * 1024)
    await db.getItem(key); await db.setItem(key, old); await db.commitRestore(key, value('imported'), 'import-marker')
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put
    let bodyReads = 0, bytes = 0
    IDBObjectStore.prototype.get = function (id) { if (Array.isArray(id) && ['message', 'team', 'artifact', 'task'].includes(String(id[1]))) bodyReads++; return get.call(this, id) }
    IDBObjectStore.prototype.put = function (data, id) { bytes += JSON.stringify(data).length; return put.call(this, data, id) }
    try { for (let i = 0; i < 8; i++) await db.setItem(key, value(`chunk-${i}`)) }
    finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.put = put }
    same(bodyReads, 0); assert(bytes < 20000, `Streaming wrote ${bytes} bytes`)
    same(await db.getRestorePoint(key), old); await db.close()
  })
  await test('format 1 restore point remains complete through current import and rollback', async (name) => {
    const db = make(name); await db.getItem(key)
    const original = value('legacy')
    await inspect(name, (store) => {
      store.put({ kind: 'workspace-head', format: 1, revision: 'legacy', version: 2, meta: { drafts: {} }, teams: [{ id: 'legacy', key: 'legacy-team' }] }, [key, 'head'])
      store.put({ kind: 'workspace-team', value: original.state.teams[0] }, [key, 'team', 'legacy-team'])
    })
    await db.getItem(key); await db.commitRestore(key, value('imported'), 'import-marker')
    await db.setItem(key, value('edited')); same(await db.getRestorePoint(key), original)
    same(await db.rollbackRestore(key, 'rollback-marker'), original); await db.close()
  })
  await test('empty database, invalid markers and explicit removal preserve restore semantics', async (name) => {
    const db = make(name)
    await rejects(db.commitRestore(key, value('imported'), 'marker'), 'uninitialized')
    await db.getItem(key); same(await db.getRestorePoint(key), null); same(await db.getImportMarker(key), null)
    await rejects(db.commitRestore(key, value('imported'), '../invalid'), 'invalid')
    await db.commitRestore(key, value('imported'), 'first'); same(await db.getRestorePoint(key), null)
    await rejects(db.commitRestore(key, value('lost'), 'first'), 'invalid')
    await rejects(db.rollbackRestore(key, 'rollback-marker'), 'corrupt')
    await db.commitRestore(key, value('second'), 'second'); await db.removeItem(key)
    same(slot(await inspect(name), 'head').kind, 'workspace-tombstone-v4')
    same(slot(await inspect(name), 'head').restore, true)
    same(await db.getRestorePoint(key), value('imported')); same(await db.getImportMarker(key), 'second')
    same(await db.rollbackRestore(key, 'rollback-marker'), value('imported')); await db.close()
  })
  await test('portable controls cannot lose their marker or pin and previous recovery never downgrades the head', async (name) => {
    const db = await fixture(name); same(slot(await inspect(name), 'head').format, 4)
    await db.commitRestore(key, value('imported'), 'import-marker')
    await db.recoverPrevious(key); same(slot(await inspect(name), 'head').format, 4)
    await db.setItem(key, value('edited')); same(slot(await inspect(name), 'head').format, 4)
    await inspect(name, (store) => store.delete([key, 'importMarker']))
    const before = await inspect(name)
    await rejects(db.getItem(key), 'corrupt'); await rejects(db.setItem(key, value('lost')), 'uninitialized')
    same(await inspect(name), before); await close(db)
  })
  for (const missing of [['restorePoint'], ['importMarker'], ['restorePoint', 'importMarker']])
    await test(`missing portable controls ${missing.join('+')} gate hydration and previous recovery without mutating evidence`, async (name) => {
      let db = await fixture(name)
      await db.commitRestore(key, value('imported'), 'import-marker'); await db.setItem(key, value('edited'))
      await db.close()
      await inspect(name, store => { for (const slot of missing) store.delete([key, slot]) })
      const before = await inspect(name)
      db = make(name)
      await rejects(db.getItem(key), 'corrupt')
      await rejects(db.getPrevious(key), 'corrupt')
      await rejects(db.getRestorePoint(key), 'corrupt')
      await rejects(db.getImportMarker(key), 'corrupt')
      await rejects(db.recoverPrevious(key), 'corrupt')
      await rejects(db.setItem(key, value('lost')), 'uninitialized')
      same(await inspect(name), before); await close(db)
    })
  await test('a removed portable workspace retains its required-controls flag after both controls disappear', async (name) => {
    let db = await fixture(name)
    await db.commitRestore(key, value('imported'), 'import-marker'); await db.removeItem(key); await db.close()
    await inspect(name, store => { store.delete([key, 'restorePoint']); store.delete([key, 'importMarker']) })
    const before = await inspect(name)
    db = make(name)
    await rejects(db.getItem(key), 'corrupt'); await rejects(db.getImportMarker(key), 'corrupt')
    await rejects(db.setItem(key, value('lost')), 'uninitialized')
    same(await inspect(name), before); await close(db)
  })
  await test('batched drafts drain before portable commit and the post-restore render save cannot rotate the fixed pin', async (name) => {
    const db = await fixture(name), batch = batchedStorage(db, () => true)
    const first = value('original'), latest = { ...first, state: { ...first.state, drafts: { original: 'last typed draft' } } }
    batch.setItem(key, first); batch.setItem(key, latest)
    await batch.flush()
    const imported = value('imported')
    await db.commitRestore(key, imported, 'import-marker')
    batch.setItem(key, imported); await batch.flush()
    same(await db.getRestorePoint(key), latest); same(await db.getImportMarker(key), 'import-marker')
    await db.close()
    const reopened = make(name)
    same(await reopened.getItem(key), imported); same(await reopened.getRestorePoint(key), latest)
    await reopened.close()
  })
  await test('failed pre-restore batch flush retains the latest draft and retry pins it before replacing the workspace', async (name) => {
    const db = await fixture(name), batch = batchedStorage(db, () => true)
    const latest = value('draft-before-restore'), before = await inspect(name), put = IDBObjectStore.prototype.put
    batch.setItem(key, latest)
    IDBObjectStore.prototype.put = function (data, id) {
      const result = put.call(this, data, id)
      if (Array.isArray(id) && id[1] === 'head') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(batch.flush(), 'unavailable') } finally { IDBObjectStore.prototype.put = put }
    assert(batch.hasPending()); same(await inspect(name), before); same(await db.getImportMarker(key), null)
    await batch.flush(); assert(!batch.hasPending())
    await db.commitRestore(key, value('imported'), 'import-marker')
    same(await db.getRestorePoint(key), latest); await db.close()
  })
  return results
}
