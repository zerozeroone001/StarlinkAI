import { createWorkspaceDatabase, WorkspaceDatabaseError } from '../src/renderer/src/lib/workspace-database'
import type { StorageValue } from 'zustand/middleware'

type Item = { id: string; text: string }
type Team = { id: string; name: string; messages: Item[]; tasks: Item[]; artifacts: Item[] }
type State = { teams: Team[]; drafts: Record<string, string> }
type Value = StorageValue<State>
const results: { name: string; ok: boolean; error?: string }[] = []
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const same = (a: unknown, b: unknown) => assert(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), 'Snapshots or record sets differ')
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
const source = (): Value => ({ version: 2, state: { teams: [{ id: 'a', name: 'streaming',
  messages: [{ id: 'history', text: 'x'.repeat(12 * 1024 * 1024) }, { id: 'live', text: 'initial' }],
  tasks: [{ id: 'task', text: 'waiting' }], artifacts: [{ id: 'artifact', text: 'y'.repeat(256 * 1024) }] }], drafts: {} } })
const make = (name: string) => createWorkspaceDatabase<State>({ factory: indexedDB, legacy: () => null, databaseName: name,
  validate: (v) => v.state.teams.every((t) => typeof t.name === 'string' && ['messages', 'tasks', 'artifacts'].every((field) => Array.isArray(t[field as keyof Team]))) })
async function inspect(name: string, mutate?: (store: IDBObjectStore) => void) {
  const db = await request(indexedDB.open(name, 1))
  try {
    const tx = db.transaction('records', mutate ? 'readwrite' : 'readonly')
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
    const store = tx.objectStore('records'); mutate?.(store)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    await done
    return keys.map((key, i) => ({ key, value: values[i] }))
  } finally { db.close() }
}
const slot = (rows: Awaited<ReturnType<typeof inspect>>, key = 'head') => rows.find((row) => JSON.stringify(row.key) === JSON.stringify(['workspace', key]))?.value
async function rejects(promise: Promise<unknown>, code: string) {
  try { await promise } catch (error) { assert(error instanceof WorkspaceDatabaseError && error.code === code, `Expected ${code}, got ${String(error)}`); return }
  throw Error(`Expected ${code}`)
}
async function test(name: string, body: (name: string) => Promise<void>) {
  try { await body(`streaming-tests-${crypto.randomUUID()}`); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.stack : String(error) }) }
}
export async function runStreamingTests() {
  await test('streaming shares 12 MiB immutable history and writes only changed message/task/artifact records', async (name) => {
    const db = make(name), first = source()
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const rows = await inspect(name), firstHead = slot(rows)
    assert(firstHead.format === 4, 'New writes must use the current asset-compatible incremental format')
    const put = IDBObjectStore.prototype.put, writes: { kind: string; bytes: number }[] = []
    IDBObjectStore.prototype.put = function (data, key) { writes.push({ kind: data.kind, bytes: JSON.stringify(data).length }); return put.call(this, data, key) }
    let latest = first
    try {
      for (let i = 1; i <= 12; i++) {
        const team = latest.state.teams[0]
        latest = { ...latest, state: { ...latest.state, teams: [{ ...team, messages: [team.messages[0], { ...team.messages[1], text: `chunk ${i}` }] }] } }
        await db.setItem('workspace', latest)
      }
    } finally { IDBObjectStore.prototype.put = put }
    assert(writes.filter((row) => row.kind === 'workspace-message').length === 12, 'Exactly one changed message per revision should be written')
    assert(!writes.some((row) => ['workspace-task', 'workspace-artifact'].includes(row.kind)), 'Unchanged task and artifact must be shared')
    assert(writes.reduce((sum, row) => sum + row.bytes, 0) < 100000, 'Streaming must not rewrite the 12 MiB historical body')
    const lastRows = await inspect(name), lastHead = slot(lastRows)
    same(lastHead.teams[0].collections.messages[0], firstHead.teams[0].collections.messages[0])
    same(lastRows.filter((row) => Array.isArray(row.key) && row.key[1] === 'message').length, 3)
    await db.close()
    const reopened = make(name); same(await reopened.getItem('workspace'), latest); await reopened.close()
  })
  await test('message/task/artifact reorder and deletion preserve a complete previous snapshot then collect only unreferenced rows', async (name) => {
    const db = make(name), first = source()
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const second = { ...first, state: { ...first.state, teams: [{ ...first.state.teams[0], messages: [...first.state.teams[0].messages].reverse(),
      tasks: [{ id: 'next-task', text: 'new' }], artifacts: [] }] } }
    await db.setItem('workspace', second); same(await db.getPrevious('workspace'), first)
    const third = { ...second, state: { ...second.state, teams: [{ ...second.state.teams[0], messages: [second.state.teams[0].messages[0]] }] } }
    await db.setItem('workspace', third); same(await db.getPrevious('workspace'), second)
    let rows = await inspect(name)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[1] === 'artifact').length, 0)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[1] === 'task').length, 1)
    await db.setItem('workspace', { ...third, state: { ...third.state, drafts: { a: 'draft' } } })
    rows = await inspect(name)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[1] === 'message').length, 1)
    await db.close()
  })
  await test('format 1 loads unchanged and migrates on commit while previous is preserved behind the format 4 gate', async (name) => {
    const db = make(name), original = source()
    await db.getItem('workspace')
    const legacyHead = { kind: 'workspace-head', format: 1, revision: 'legacy-revision', version: 2, meta: { drafts: {} }, teams: [{ id: 'a', key: 'legacy-team' }] }
    await inspect(name, (store) => {
      store.put(legacyHead, ['workspace', 'head'])
      store.put({ kind: 'workspace-team', value: original.state.teams[0] }, ['workspace', 'team', 'legacy-team'])
    })
    const before = await inspect(name)
    const loaded = await db.getItem('workspace'); same(loaded, original); same(await inspect(name), before)
    const next = { ...loaded!, state: { ...loaded!.state, teams: [{ ...loaded!.state.teams[0], name: 'migrated' }] } }
    await db.setItem('workspace', next)
    assert(slot(await inspect(name)).format === 4, 'First updated revision must use format 4')
    same(await db.getPrevious('workspace'), original)
    same(slot(await inspect(name), 'previous'), { ...legacyHead, format: 4 })
    await db.close(); const reopened = make(name); same(await reopened.getItem('workspace'), next); await reopened.close()
  })
  await test('migration abort leaves exact format 1 rows and retry creates no leaked incremental records', async (name) => {
    const db = make(name), original = source()
    await db.getItem('workspace')
    await inspect(name, (store) => {
      store.put({ kind: 'workspace-head', format: 1, revision: 'v1', version: 2, meta: { drafts: {} }, teams: [{ id: 'a', key: 'old' }] }, ['workspace', 'head'])
      store.put({ kind: 'workspace-team', value: original.state.teams[0] }, ['workspace', 'team', 'old'])
    })
    const loaded = await db.getItem('workspace'), before = await inspect(name), put = IDBObjectStore.prototype.put
    const next = { ...loaded!, state: { ...loaded!.state, teams: [{ ...loaded!.state.teams[0], name: 'changed' }] } }
    IDBObjectStore.prototype.put = function (data, key) {
      const result = put.call(this, data, key)
      if (data.kind === 'workspace-head') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(db.setItem('workspace', next), 'unavailable') } finally { IDBObjectStore.prototype.put = put }
    same(await inspect(name), before)
    await db.setItem('workspace', next); same(await db.getPrevious('workspace'), original)
    await db.close()
  })
  await test('missing incremental message gates hydration and explicit previous recovery retains its complete referenced history', async (name) => {
    const db = make(name), first = source()
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const second = { ...first, state: { ...first.state, teams: [{ ...first.state.teams[0], messages: [first.state.teams[0].messages[0], { id: 'live', text: 'new reply' }] }] } }
    await db.setItem('workspace', second)
    const current = slot(await inspect(name))
    assert(current.format === 4, 'Missing-record test requires incremental storage')
    await inspect(name, (store) => store.delete(['workspace', 'message', current.teams[0].collections.messages[1].key]))
    await rejects(db.getItem('workspace'), 'corrupt')
    const damaged = await inspect(name)
    await rejects(db.setItem('workspace', source()), 'uninitialized'); same(await inspect(name), damaged)
    same(await db.getPrevious('workspace'), first); same(await db.recoverPrevious('workspace'), first)
    same(await db.getPrevious('workspace'), first)
    await db.close(); const reopened = make(name); same(await reopened.getItem('workspace'), first); await reopened.close()
  })
  await test('duplicate collection ids retain their original inline semantics instead of dropping data', async (name) => {
    const db = make(name), first = source(); first.state.teams[0].messages.push({ id: 'live', text: 'second same-id message' })
    await db.getItem('workspace'); await db.setItem('workspace', first); await db.close()
    const reopened = make(name); same(await reopened.getItem('workspace'), first); await reopened.close()
  })
  await test('previously inline non-record entries can be replaced with valid incremental items without losing the previous snapshot', async (name) => {
    const db = make(name), first = source()
    first.state.teams[0].messages = [null, 'custom entry', { id: 'old', text: 'valid item' }] as unknown as Item[]
    await db.getItem('workspace'); await db.setItem('workspace', first)
    const second = { ...first, state: { ...first.state, teams: [{ ...first.state.teams[0], messages: [{ id: 'new', text: 'normalized' }] }] } }
    await db.setItem('workspace', second); same(await db.getPrevious('workspace'), first)
    await db.close(); const reopened = make(name); same(await reopened.getItem('workspace'), second); await reopened.close()
  })
  await test('incremental task and artifact edits each write one item while previous retains original content', async (name) => {
    const db = make(name), first = source(); await db.getItem('workspace'); await db.setItem('workspace', first)
    const team = first.state.teams[0], next = { ...first, state: { ...first.state, teams: [{ ...team,
      tasks: [{ ...team.tasks[0], text: 'done' }], artifacts: [{ ...team.artifacts[0], text: 'new content' }] }] } }
    const put = IDBObjectStore.prototype.put, writes: string[] = []
    IDBObjectStore.prototype.put = function (data, key) { writes.push(data.kind); return put.call(this, data, key) }
    try { await db.setItem('workspace', next) } finally { IDBObjectStore.prototype.put = put }
    same(writes.filter((kind) => kind === 'workspace-task').length, 1)
    same(writes.filter((kind) => kind === 'workspace-artifact').length, 1)
    same(writes.filter((kind) => kind === 'workspace-message').length, 0)
    same(await db.getPrevious('workspace'), first)
    await db.close(); const reopened = make(name); same(await reopened.getItem('workspace'), next); await reopened.close()
  })
  await test('incremental stale-writer CAS and transaction abort leave all shared rows and previous intact', async (name) => {
    const first = make(name), stale = make(name), original = source()
    await first.getItem('workspace'); await first.setItem('workspace', original); await stale.getItem('workspace')
    const team = original.state.teams[0], next = { ...original, state: { ...original.state, teams: [{ ...team, messages: [team.messages[0], { ...team.messages[1], text: 'new' }] }] } }
    await first.setItem('workspace', next)
    const before = await inspect(name)
    await rejects(stale.setItem('workspace', original), 'conflict'); same(await inspect(name), before)
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (data, key) {
      const result = put.call(this, data, key)
      if (data.kind === 'workspace-message') result.addEventListener('success', () => this.transaction.abort())
      return result
    }
    try { await rejects(first.setItem('workspace', original), 'unavailable') } finally { IDBObjectStore.prototype.put = put }
    same(await inspect(name), before); same(await first.getPrevious('workspace'), original)
    await first.close().catch(() => {}); await stale.close().catch(() => {})
  })
  await test('incremental malformed refs and missing artifact rows gate reads without rewriting damaged data', async (name) => {
    const db = make(name), original = source(); await db.getItem('workspace'); await db.setItem('workspace', original)
    const current = slot(await inspect(name))
    await inspect(name, (store) => store.put({ ...current, teams: [{ ...current.teams[0], collections: { ...current.teams[0].collections,
      messages: [current.teams[0].collections.messages[0], current.teams[0].collections.messages[0]] } }] }, ['workspace', 'head']))
    let damaged = await inspect(name)
    await rejects(db.getItem('workspace'), 'corrupt'); await rejects(db.setItem('workspace', original), 'uninitialized'); same(await inspect(name), damaged)
    await inspect(name, (store) => { store.put(current, ['workspace', 'head']); store.delete(['workspace', 'artifact', current.teams[0].collections.artifacts[0].key]) })
    damaged = await inspect(name)
    await rejects(db.getItem('workspace'), 'corrupt'); same(await inspect(name), damaged)
    await db.close().catch(() => {})
  })
  await test('incremental namespaces and same-id items in separate teams remain isolated during garbage collection', async (name) => {
    const db = make(name), first = source()
    first.state.teams.push({ ...first.state.teams[0], id: 'b', messages: [{ id: 'live', text: 'other team' }] })
    await db.getItem('workspace'); await db.getItem('other')
    await db.setItem('workspace', first); await db.setItem('other', first)
    await db.setItem('workspace', { ...first, state: { ...first.state, teams: [first.state.teams[1]] } })
    await db.setItem('workspace', { ...first, state: { ...first.state, teams: [first.state.teams[1]], drafts: { b: 'retire old revision' } } })
    same((await db.getItem('workspace'))?.state.teams[0].messages, first.state.teams[1].messages)
    same(await db.getItem('other'), first)
    await db.removeItem('workspace'); same(await db.getItem('other'), first)
    const rows = await inspect(name)
    same(rows.filter((row) => Array.isArray(row.key) && row.key[0] === 'workspace').length, 1)
    await db.close()
  })
  return results
}
