import { createWorkspaceDatabase, WorkspaceDatabaseError } from '../src/renderer/src/lib/workspace-database'
import type { StorageValue } from 'zustand/middleware'
import { runStreamingTests } from './workspace-database-streaming-tests'
import { runRestoreTests } from './workspace-database-restore-tests'

type State = { teams: { id: string; text: string }[]; drafts: Record<string, string>; extra?: unknown }
type Value = StorageValue<State>
const results: { name: string; ok: boolean; error?: string }[] = []
function assert(condition: unknown, message = 'Assertion failed'): asserts condition { if (!condition) throw new Error(message) }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value
const same = (actual: unknown, expected: unknown) => assert(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const value = (text = 'original'): Value => ({ version: 2, state: { teams: [{ id: 'a', text }, { id: 'b', text: 'unchanged' }], drafts: {} } })
const valid = (v: Value) => !!v.state.drafts && v.state.teams.every((team) => typeof team.text === 'string')
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
async function rejects(promise: Promise<unknown>, code: string) {
  try { await promise } catch (error) { assert(error instanceof WorkspaceDatabaseError && error.code === code, `Expected ${code}, got ${String(error)} (${(error as WorkspaceDatabaseError)?.code})`); return }
  throw new Error(`Expected rejection: ${code}`)
}
async function inspect(name: string, write?: (store: IDBObjectStore) => void) {
  const db = await request(indexedDB.open(name, 1))
  try {
    const tx = db.transaction('records', write ? 'readwrite' : 'readonly')
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
    const store = tx.objectStore('records')
    write?.(store)
    const [keys, rows] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    await done
    return keys.map((key, i) => ({ key, value: rows[i] }))
  } finally { db.close() }
}
const head = (rows: Awaited<ReturnType<typeof inspect>>, namespace = 'workspace') => rows.find((row) => JSON.stringify(row.key) === JSON.stringify([namespace, 'head']))?.value
async function test(name: string, fn: (databaseName: string) => Promise<void>) {
  const databaseName = `workspace-tests-${crypto.randomUUID()}`
  try { await fn(databaseName); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.stack : String(error) }) }
}
function database(name: string, options: Partial<Parameters<typeof createWorkspaceDatabase<State>>[0]> = {}) {
  return createWorkspaceDatabase<State>({ factory: indexedDB, legacy: () => null, validate: valid, databaseName: name, ...options })
}
const quietlyClose = (db: ReturnType<typeof database>) => db.close().catch(() => {})

export async function run() {
  await test('a write before hydration cannot overwrite existing legacy data', async (name) => {
    const raw = JSON.stringify(value())
    localStorage.setItem(name, raw)
    const db = database(name, { legacy: () => localStorage })
    await rejects(db.setItem(name, value('bad')), 'uninitialized')
    same(localStorage.getItem(name), raw)
    await quietlyClose(db)
  })
  await test('empty initialization and native commit survive a new connection', async (name) => {
    const db = database(name)
    same(await db.getItem('workspace'), null)
    await db.setItem('workspace', value())
    await db.close()
    const reopened = database(name)
    same(await reopened.getItem('workspace'), value())
    await reopened.close()
  })
  for (const format of [2, 3]) await test(`format ${format} reads unchanged, then a metadata edit gates head and previous without rewriting teams`, async (name) => {
    let db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value('original'))
    if (format === 3) await db.commitRestore('workspace', value('imported'), 'legacy-import')
    const rows = await inspect(name), prior = head(rows)
    await inspect(name, (store) => {
      store.put({ ...prior, format }, ['workspace', 'head'])
      for (const row of rows) if (Array.isArray(row.key) && row.key[1] === 'restorePoint')
        store.put({ ...row.value, head: { ...row.value.head, format: 2 } }, row.key)
    })
    await db.close(); db = database(name)
    const before = await inspect(name), loaded = await db.getItem('workspace')
    same(await inspect(name), before)
    assert(loaded)
    const next = { ...loaded, state: { ...loaded.state, drafts: { a: 'managed attachment draft' } } }
    const put = IDBObjectStore.prototype.put; let teamWrites = 0
    IDBObjectStore.prototype.put = function (row, key) { if (row.kind === 'workspace-team') teamWrites++; return put.call(this, row, key) }
    try { await db.setItem('workspace', next) } finally { IDBObjectStore.prototype.put = put }
    same(teamWrites, 0)
    const after = await inspect(name)
    same(head(after).format, 4)
    same(after.find(row => Array.isArray(row.key) && row.key[1] === 'previous')?.value.format, 4)
    same(await db.getPrevious('workspace'), loaded)
    if (format === 3) {
      same(await db.getRestorePoint('workspace'), value('original'))
      same(after.find(row => Array.isArray(row.key) && row.key[1] === 'restorePoint')?.value.head.format, 2)
    }
    await db.close(); db = database(name); same(await db.getItem('workspace'), next); await db.close()
  })
  await test('recovering an older previous snapshot gates both readable slots instead of exposing a downgrade recovery path', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value('original')); await db.setItem('workspace', value('changed'))
    const rows = await inspect(name), previous = rows.find(row => Array.isArray(row.key) && row.key[1] === 'previous')!.value
    await inspect(name, store => {
      store.put({ ...head(rows), format: 999 }, ['workspace', 'head'])
      store.put({ ...previous, format: 2 }, ['workspace', 'previous'])
    })
    await rejects(db.getItem('workspace'), 'corrupt')
    same(await db.getPrevious('workspace'), value('original'))
    same(await db.recoverPrevious('workspace'), value('original'))
    const after = await inspect(name)
    same(head(after).format, 4)
    same(after.find(row => Array.isArray(row.key) && row.key[1] === 'previous')?.value.format, 4)
    await db.close()
  })
  await test('ordinary format 4 removal preserves a downgrade gate and never revives retained legacy data', async (name) => {
    localStorage.setItem(name, JSON.stringify(value('legacy')))
    const db = database(name, { legacy: () => localStorage })
    await db.getItem(name); await db.removeItem(name)
    same(head(await inspect(name), name).kind, 'workspace-tombstone-v4')
    same(await db.getItem(name), null)
    same(JSON.parse(localStorage.getItem(name)!), value('legacy'))
    await db.close()
  })
  await test('legacy migration normalizes version, commits atomically and preserves exact source', async (name) => {
    const legacy = { ...value('legacy'), version: 1 }, raw = JSON.stringify(legacy)
    localStorage.setItem(name, raw)
    const db = database(name, { legacy: () => localStorage, normalizeLegacy: (v) => ({ ...v, version: 2 }) })
    same(await db.getItem(name), { ...legacy, version: 2 })
    same(localStorage.getItem(name), raw)
    same((await inspect(name)).filter((row) => Array.isArray(row.key) && row.key[1] === 'team').length, 2)
    await db.close()
  })
  await test('malformed legacy is quarantined and cannot become empty persisted state', async (name) => {
    localStorage.setItem(name, '{"state":')
    const db = database(name, { legacy: () => localStorage })
    await rejects(db.getItem(name), 'corrupt')
    await rejects(db.setItem(name, value()), 'uninitialized')
    same(localStorage.getItem(name), '{"state":')
    same(await inspect(name), [])
    await quietlyClose(db)
  })
  await test('unavailable database or legacy access never authorizes initial writes', async (name) => {
    const broken = database(name, { factory: { open() { throw new DOMException('Denied', 'SecurityError') } } as unknown as IDBFactory })
    await rejects(broken.getItem('workspace'), 'unavailable')
    await rejects(broken.setItem('workspace', value()), 'uninitialized')
    await quietlyClose(broken)
    const inaccessibleLegacy = database(name, { legacy: () => { throw new DOMException('Denied', 'SecurityError') } })
    await rejects(inaccessibleLegacy.getItem('workspace'), 'unavailable')
    await rejects(inaccessibleLegacy.setItem('workspace', value()), 'uninitialized')
    await quietlyClose(inaccessibleLegacy)
  })
  await test('failed migration retains legacy source and leaves no partial team records', async (name) => {
    const raw = JSON.stringify(value())
    localStorage.setItem(name, raw)
    const db = database(name, { legacy: () => localStorage, normalizeLegacy: (v) => ({ ...v, state: { ...v.state, extra: () => 1 } }) })
    await rejects(db.getItem(name), 'unavailable')
    same(await inspect(name), [])
    same(localStorage.getItem(name), raw)
    await rejects(db.setItem(name, value()), 'uninitialized')
    await quietlyClose(db)
  })
  await test('native transactions are strict and successful writes await oncomplete', async (name) => {
    const db = database(name)
    await db.getItem('workspace')
    const original = IDBDatabase.prototype.transaction
    let complete = false, durability = ''
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args)
      durability = tx.durability
      tx.addEventListener('complete', () => { complete = true })
      return tx
    }
    try { await db.setItem('workspace', value()); assert(complete, 'write resolved before transaction completed'); same(durability, 'strict') }
    finally { IDBDatabase.prototype.transaction = original; await quietlyClose(db) }
  })
  await test('draft-only edits do not clone or rewrite team payloads', async (name) => {
    const db = database(name), original = value()
    await db.getItem('workspace'); await db.setItem('workspace', original)
    const put = IDBObjectStore.prototype.put
    let teamWrites = 0
    IDBObjectStore.prototype.put = function (data, key) { if (data.kind === 'workspace-team') teamWrites++; return put.call(this, data, key) }
    try {
      await db.setItem('workspace', { ...original, state: { ...original.state, drafts: { a: 'draft' } } })
      same(teamWrites, 0)
      const teams = [{ ...original.state.teams[0], text: 'changed' }, original.state.teams[1]]
      await db.setItem('workspace', { ...original, state: { ...original.state, teams } })
      same(teamWrites, 1)
    } finally { IDBObjectStore.prototype.put = put; await quietlyClose(db) }
  })
  await test('head and previous stay coherent while orphaned immutable teams are collected', async (name) => {
    const db = database(name), first = value('one')
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const second = { ...first, state: { ...first.state, teams: [{ id: 'a', text: 'two' }] } }
    await db.setItem('workspace', second)
    same(await db.getPrevious('workspace'), first)
    same((await inspect(name)).filter((row) => Array.isArray(row.key) && row.key[1] === 'team').length, 3)
    const third = { ...second, state: { ...second.state, drafts: { a: 'only meta' } } }
    await db.setItem('workspace', third)
    same(await db.getPrevious('workspace'), second)
    same((await inspect(name)).filter((row) => Array.isArray(row.key) && row.key[1] === 'team').length, 1)
    await db.close()
  })
  await test('a failed native commit keeps the last committed references and supports correct retry', async (name) => {
    const db = database(name), first = value()
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const before = await inspect(name)
    const teams = [{ id: 'a', text: 'replacement' }, first.state.teams[1]]
    await rejects(db.setItem('workspace', { ...first, state: { teams, drafts: {}, extra: () => 1 } }), 'unavailable')
    same(await inspect(name), before)
    await rejects(db.flush(), 'unavailable')
    const fixed = { ...first, state: { teams, drafts: {} } }
    await db.setItem('workspace', fixed)
    await db.flush()
    await db.close()
    const reopened = database(name)
    same(await reopened.getItem('workspace'), fixed)
    await reopened.close()
  })
  await test('request success followed by transaction abort does not acknowledge a commit', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value())
    const before = await inspect(name), put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (data, key) {
      const result = put.call(this, data, key)
      if (data.kind === 'workspace-head') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(db.setItem('workspace', value('abort')), 'unavailable') }
    finally { IDBObjectStore.prototype.put = put }
    same(await inspect(name), before)
    await db.setItem('workspace', value('retry'))
    same((await db.getItem('workspace'))?.state.teams[0].text, 'retry')
    await db.close()
  })
  await test('queued writes commit in order and retain only the final two snapshots', async (name) => {
    const db = database(name)
    await db.getItem('workspace')
    await Promise.all([db.setItem('workspace', value('one')), db.setItem('workspace', value('two')), db.setItem('workspace', value('three'))])
    same((await db.getItem('workspace'))?.state.teams[0].text, 'three')
    same((await db.getPrevious('workspace'))?.state.teams[0].text, 'two')
    same((await inspect(name)).filter((row) => Array.isArray(row.key) && row.key[1] === 'team').length, 4)
    await db.close()
  })
  await test('IDB wins over stale legacy data and stale writers fail compare-and-swap', async (name) => {
    const first = database(name), second = database(name, { legacy: () => localStorage })
    await first.getItem('workspace'); await first.setItem('workspace', value('current'))
    localStorage.setItem('workspace', JSON.stringify(value('stale legacy')))
    same((await second.getItem('workspace'))?.state.teams[0].text, 'current')
    await first.setItem('workspace', value('newest'))
    await rejects(second.setItem('workspace', value('stale writer')), 'conflict')
    same((await second.getItem('workspace'))?.state.teams[0].text, 'newest')
    await second.setItem('workspace', value('retry after reread'))
    same((await first.getItem('workspace'))?.state.teams[0].text, 'retry after reread')
    await first.close(); await second.close()
    localStorage.removeItem('workspace')
  })
  await test('corrupt head never falls back to legacy and explicit recovery preserves the good previous revision', async (name) => {
    const db = database(name, { legacy: () => localStorage })
    await db.getItem('workspace'); await db.setItem('workspace', value('good previous')); await db.setItem('workspace', value('bad current'))
    const rows = await inspect(name), current = head(rows)
    await inspect(name, (store) => store.delete(['workspace', 'team', current.teams[0].key]))
    localStorage.setItem('workspace', JSON.stringify(value('stale legacy')))
    await rejects(db.getItem('workspace'), 'corrupt')
    await rejects(db.setItem('workspace', value('overwrite')), 'uninitialized')
    same((await db.getPrevious('workspace'))?.state.teams[0].text, 'good previous')
    same((await db.recoverPrevious('workspace')).state.teams[0].text, 'good previous')
    same((await db.getPrevious('workspace'))?.state.teams[0].text, 'good previous')
    same((await db.getItem('workspace'))?.state.teams[0].text, 'good previous')
    await db.close(); localStorage.removeItem('workspace')
  })
  await test('a recovery preview cannot overwrite another writer that committed afterward', async (name) => {
    const first = database(name), second = database(name)
    await first.getItem('workspace'); await first.setItem('workspace', value('one')); await first.setItem('workspace', value('two'))
    await second.getPrevious('workspace')
    await first.setItem('workspace', value('three'))
    await rejects(second.recoverPrevious('workspace'), 'conflict')
    same((await first.getItem('workspace'))?.state.teams[0].text, 'three')
    await first.close(); await quietlyClose(second)
  })
  await test('corrupt previous data is not promoted and original records remain unchanged', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value()); await db.setItem('workspace', value('two'))
    await inspect(name, (store) => store.put({ broken: true }, ['workspace', 'previous']))
    const before = await inspect(name)
    await rejects(db.recoverPrevious('workspace'), 'corrupt')
    same(await inspect(name), before)
    await quietlyClose(db)
  })
  await test('explicit removal leaves a tombstone so retained legacy data cannot resurrect', async (name) => {
    localStorage.setItem('workspace', JSON.stringify(value('legacy')))
    const db = database(name, { legacy: () => localStorage })
    await db.getItem('workspace'); await db.removeItem('workspace'); await db.close()
    const reopened = database(name, { legacy: () => localStorage })
    same(await reopened.getItem('workspace'), null)
    same(await reopened.getPrevious('workspace'), null)
    same((await inspect(name)).length, 1)
    assert(localStorage.getItem('workspace'), 'legacy must remain intact')
    await reopened.close(); localStorage.removeItem('workspace')
  })
  await test('close drains accepted writes and refuses new operations', async (name) => {
    const db = database(name)
    await db.getItem('workspace')
    const write = db.setItem('workspace', value('last before close'))
    const closing = db.close()
    await rejects(db.setItem('workspace', value('after close')), 'closed')
    await write; await closing
    const reopened = database(name)
    same((await reopened.getItem('workspace'))?.state.teams[0].text, 'last before close')
    await reopened.close()
  })
  await test('namespaces are isolated even when teams share identifiers', async (name) => {
    const db = database(name)
    await db.getItem('left'); await db.getItem('right')
    await db.setItem('left', value('left')); await db.setItem('right', value('right'))
    await db.removeItem('left')
    same((await db.getItem('right'))?.state.teams[0].text, 'right')
    await db.close()
  })
  await test('invalid values do not replace a valid head', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value())
    const before = await inspect(name), bad = value()
    bad.state.teams[1].id = 'a'
    await rejects(db.setItem('workspace', bad), 'invalid')
    same(await inspect(name), before)
    await quietlyClose(db)
  })
  await test('previewing previous data cannot hide an uncommitted write from flush', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value('one')); await db.setItem('workspace', value('two'))
    await rejects(db.setItem('workspace', { ...value(), state: { ...value().state, extra: () => 1 } }), 'unavailable')
    same((await db.getPrevious('workspace'))?.state.teams[0].text, 'one')
    await rejects(db.flush(), 'unavailable')
    await quietlyClose(db)
  })
  await test('concurrent migrations preserve legacy and produce one coherent committed revision', async (name) => {
    localStorage.setItem(name, JSON.stringify(value('migration')))
    const first = database(name, { legacy: () => localStorage }), second = database(name, { legacy: () => localStorage })
    const outcomes = await Promise.allSettled([first.getItem(name), second.getItem(name)])
    assert(outcomes.some((item) => item.status === 'fulfilled'))
    for (const item of outcomes) if (item.status === 'rejected') assert(item.reason instanceof WorkspaceDatabaseError && item.reason.code === 'conflict')
    same((await first.getItem(name))?.state.teams[0].text, 'migration')
    const rows = await inspect(name)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[1] === 'team').length, 2)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[1] === 'previous').length, 0)
    same(localStorage.getItem(name), JSON.stringify(value('migration')))
    await first.close(); await quietlyClose(second)
  })
  await test('malformed external head insertion conflicts with a previously empty initialization', async (name) => {
    const db = database(name)
    await db.getItem('workspace')
    await inspect(name, (store) => store.put({ broken: true }, ['workspace', 'head']))
    await rejects(db.setItem('workspace', value()), 'conflict')
    same(head(await inspect(name)), { broken: true })
    await quietlyClose(db)
  })
  await test('versionchange releases the connection and incompatible versions fail safely', async (name) => {
    const db = database(name)
    await db.getItem('workspace'); await db.setItem('workspace', value())
    const upgraded = await request(indexedDB.open(name, 2))
    upgraded.close()
    await rejects(db.getItem('workspace'), 'unavailable')
    await rejects(db.setItem('workspace', value('overwritten')), 'uninitialized')
    await quietlyClose(db)
  })
  results.push(...await runStreamingTests())
  results.push(...await runRestoreTests())
  return { ok: results.every((result) => result.ok), engine: navigator.userAgent, results }
}
