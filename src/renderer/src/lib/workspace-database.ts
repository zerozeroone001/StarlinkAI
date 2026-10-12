import type { PersistStorage, StorageValue } from 'zustand/middleware'

type Workspace = { teams: { id: string }[] }
type ErrorCode = 'unavailable' | 'corrupt' | 'conflict' | 'uninitialized' | 'invalid' | 'closed'
export class WorkspaceDatabaseError extends Error {
  constructor(public readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceDatabaseError'
  }
}
export interface WorkspaceDatabaseOptions<T extends Workspace> {
  factory: IDBFactory
  legacy: () => Storage | null
  validate: (value: StorageValue<T>) => boolean
  normalizeLegacy?: (value: StorageValue<T>) => StorageValue<T>
  databaseName?: string
}
export interface WorkspaceDatabase<T extends Workspace> extends PersistStorage<T, Promise<void>> {
  getItem(name: string): Promise<StorageValue<T> | null>
  getPrevious(name: string): Promise<StorageValue<T> | null>
  recoverPrevious(name: string): Promise<StorageValue<T>>
  getRestorePoint(name: string): Promise<StorageValue<T> | null>
  getImportMarker(name: string): Promise<string | null>
  commitRestore(name: string, value: StorageValue<T>, marker: string): Promise<void>
  rollbackRestore(name: string, marker: string): Promise<StorageValue<T>>
  flush(): Promise<void>
  close(): Promise<void>
}
interface Head {
  kind: 'workspace-head'
  format: 1 | 2 | 3 | 4
  restore?: true
  revision: string
  version?: number
  meta: Record<string, unknown>
  teams: TeamRef[]
}
type ItemRef = { id: string; key: string }
type Collection = 'messages' | 'tasks' | 'artifacts'
type TeamRef = ItemRef & { collections?: Partial<Record<Collection, ItemRef[]>> }
const collections = { messages: 'message', tasks: 'task', artifacts: 'artifact' } as const
interface Tombstone { kind: 'workspace-tombstone' | 'workspace-tombstone-v3' | 'workspace-tombstone-v4'; revision: string; restore?: true }
interface RestorePoint { kind: 'workspace-restore-point'; revision: string; head: Head | Tombstone | null; marker: string | null }
interface Snapshot<T> { head: Head | Tombstone | undefined; value: StorageValue<T> | null; marker?: string | null; restorePoint?: RestorePoint }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const headKey = (name: string, slot = 'head'): IDBValidKey => [name, slot]
const teamKey = (name: string, key: string): IDBValidKey => [name, 'team', key]
const itemKey = (name: string, field: Collection, key: string): IDBValidKey => [name, collections[field], key]
const validRefs = (value: unknown): value is ItemRef[] => Array.isArray(value) && value.every((ref) =>
  isRecord(ref) && typeof ref.id === 'string' && !!ref.id && typeof ref.key === 'string' && !!ref.key) &&
  new Set(value.map((ref) => ref.id)).size === value.length && new Set(value.map((ref) => ref.key)).size === value.length
function validHead(raw: unknown): raw is Head {
  if (!isRecord(raw) || raw.kind !== 'workspace-head' || typeof raw.format !== 'number' || ![1, 2, 3, 4].includes(raw.format) ||
    (raw.restore !== undefined && raw.restore !== true) ||
    typeof raw.revision !== 'string' || !raw.revision || !isRecord(raw.meta) || Object.hasOwn(raw.meta, 'teams') || !validRefs(raw.teams)) return false
  return raw.teams.every((ref: TeamRef) => ref.collections === undefined || ([2, 3, 4].includes(raw.format as number) && isRecord(ref.collections) &&
    Object.entries(ref.collections).every(([field, refs]) => Object.hasOwn(collections, field) && validRefs(refs))))
}
const token = (head: unknown): unknown => head === undefined ? 'absent'
  : isRecord(head) && typeof head.revision === 'string' ? `revision:${head.revision}` : `invalid:${JSON.stringify(head)}`
const unavailable = (cause: unknown) => cause instanceof WorkspaceDatabaseError ? cause
  : new WorkspaceDatabaseError('unavailable', '工作区数据库读写失败；原有数据已保留，请重试或导出当前工作区。', { cause })

// Head and previous reference immutable records. Format 1 whole teams remain
// readable; changed teams migrate to format 2 inside their first commit. Format
// 3 gates clients that would GC restore pins. Format 4 also gates clients whose
// asset resolver/exporter cannot preserve host-owned files outside source cwd.
// Every new commit uses 4, without rewriting unchanged immutable records. The
// caller must use immutable updates, including nested messages/tasks/artifacts,
// and must not mutate an accepted value while its asynchronous write is pending.
// Draft edits write only metadata; streaming edits share unchanged history.
export function createWorkspaceDatabase<T extends Workspace>(options: WorkspaceDatabaseOptions<T>): WorkspaceDatabase<T> {
  const snapshots = new Map<string, Snapshot<T>>()
  const observed = new Map<string, unknown>()
  const observedMarkers = new Map<string, string | null>()
  let connection: Promise<IDBDatabase> | undefined
  let live: IDBDatabase | undefined
  let queue: Promise<void> = Promise.resolve()
  let lastFailure: unknown
  let closing = false
  const corrupt = () => new WorkspaceDatabaseError('corrupt', '工作区数据不完整或已损坏；已停止保存以保留原数据，请检查上一份快照。')
  const validMarker = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
  const tombstone = (value: unknown): value is Tombstone => isRecord(value) && ['workspace-tombstone', 'workspace-tombstone-v3', 'workspace-tombstone-v4'].includes(String(value.kind)) && typeof value.revision === 'string' && !!value.revision && (value.restore === undefined || value.restore === true)
  const requiresControls = (value: unknown) => isRecord(value) && (value.restore === true ||
    (value.kind === 'workspace-head' && value.format === 3) || value.kind === 'workspace-tombstone-v3')
  const protectedHead = (head: Head, restore: boolean): Head => ({ ...head, format: 4,
    ...(restore || requiresControls(head) ? { restore: true } : {}) })
  function assertRequiredControls(name: string, head: unknown, control: Pick<Snapshot<T>, 'marker' | 'restorePoint'>) {
    if (requiresControls(head) && (control.marker == null || !control.restorePoint)) {
      snapshots.delete(name)
      throw corrupt()
    }
  }
  function markerValue(raw: unknown): string | null {
    if (raw === undefined) return null
    if (!isRecord(raw) || raw.kind !== 'workspace-import-marker' || !validMarker(raw.value)) throw corrupt()
    return raw.value
  }
  function restorePointValue(raw: unknown): RestorePoint | undefined {
    if (raw === undefined) return undefined
    if (!isRecord(raw) || raw.kind !== 'workspace-restore-point' || typeof raw.revision !== 'string' || !raw.revision ||
      (raw.head !== null && !validHead(raw.head) && !tombstone(raw.head)) || (raw.marker !== null && !validMarker(raw.marker))) throw corrupt()
    return raw as unknown as RestorePoint
  }
  async function controls(store: IDBObjectStore, name: string) {
    const [marker, point] = await Promise.all([request(store.get(headKey(name, 'importMarker'))), request(store.get(headKey(name, 'restorePoint')))])
    try {
      const control = { marker: markerValue(marker), restorePoint: restorePointValue(point) }
      if ((control.marker !== null) !== (control.restorePoint !== undefined)) throw corrupt()
      return control
    }
    catch (error) { snapshots.delete(name); throw error }
  }
  async function loadRestorePoint(store: IDBObjectStore, name: string, point: RestorePoint | undefined) {
    try { return await load(store, name, point?.head ?? undefined) }
    catch (error) { snapshots.delete(name); throw error }
  }
  function assertControls(current: Pick<Snapshot<T>, 'marker' | 'restorePoint'>, expected: Snapshot<T>) {
    if (current.marker !== (expected.marker ?? null) || token(current.restorePoint) !== token(expected.restorePoint))
      throw new WorkspaceDatabaseError('conflict', '工作区恢复状态已被另一个窗口更新；请重新载入后重试。')
  }
  function checkMarker(marker: string) {
    if (!validMarker(marker)) throw new WorkspaceDatabaseError('invalid', '工作区恢复操作编号无效。')
  }
  const valid = (value: unknown): value is StorageValue<T> => {
    if (!isRecord(value) || !isRecord(value.state) || !Array.isArray(value.state.teams) ||
      value.state.teams.some((team) => !isRecord(team) || typeof team.id !== 'string' || !team.id) ||
      new Set(value.state.teams.map((team) => team.id)).size !== value.state.teams.length ||
      (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 0))) return false
    try { return options.validate(value as StorageValue<T>) } catch { return false }
  }
  function open(): Promise<IDBDatabase> {
    if (connection) return connection
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let rejected = false
      const request = options.factory.open(options.databaseName || 'grok-desktop-workspace-v1', 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records') }
      request.onerror = () => { rejected = true; reject(unavailable(request.error)) }
      request.onblocked = () => { rejected = true; reject(new WorkspaceDatabaseError('unavailable', '另一个窗口正在使用工作区数据库；请关闭该窗口后重试。')) }
      request.onsuccess = () => {
        const db = request.result
        if (rejected) { db.close(); return }
        live = db
        db.onversionchange = () => { db.close(); if (live === db) { live = undefined; connection = undefined } }
        db.onclose = () => { if (live === db) { live = undefined; connection = undefined } }
        resolve(db)
      }
    })
    connection = pending
    void pending.catch(() => { if (connection === pending) connection = undefined })
    return pending
  }
  const request = <R>(operation: IDBRequest<R>): Promise<R> => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error)
  })
  async function transaction<R>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => Promise<R>): Promise<R> {
    let tx: IDBTransaction
    try {
      const db = await open()
      tx = db.transaction('records', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
    } catch (error) { throw unavailable(error) }
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
      tx.onerror = () => { /* onabort determines the final outcome */ }
    })
    // A failed request may reject before body finishes unwinding.
    void completed.catch(() => {})
    try {
      const result = await body(tx.objectStore('records'))
      await completed
      return result
    } catch (error) {
      try { tx.abort() } catch { /* transaction already ended */ }
      await completed.catch(() => {})
      throw unavailable(error)
    }
  }
  function enqueue<R>(operation: () => Promise<R>, clearFailure = true): Promise<R> {
    if (closing) return Promise.reject(new WorkspaceDatabaseError('closed', '工作区数据库已关闭。'))
    const result = queue.then(operation)
    queue = result.then(() => { if (clearFailure) lastFailure = undefined }, (error) => { lastFailure = error })
    return result
  }
  async function load(store: IDBObjectStore, name: string, raw: unknown): Promise<Snapshot<T>> {
    if (raw === undefined) return { head: undefined, value: null }
    if (tombstone(raw))
      return { head: raw as unknown as Tombstone, value: null }
    if (!validHead(raw)) throw corrupt()
    const head = raw
    const records = await Promise.all(head.teams.map((ref) => request(store.get(teamKey(name, ref.key)))))
    const teams = await Promise.all(records.map(async (row, index) => {
      if (!isRecord(row) || row.kind !== 'workspace-team' || !isRecord(row.value) || row.value.id !== head.teams[index].id) throw corrupt()
      const team = { ...row.value }
      await Promise.all(Object.entries(head.teams[index].collections || {}).map(async ([field, refs]) => {
        if (Object.hasOwn(team, field)) throw corrupt()
        const rows = await Promise.all(refs.map((ref: ItemRef) => request(store.get(itemKey(name, field as Collection, ref.key)))))
        team[field] = rows.map((item, i) => {
          if (!isRecord(item) || item.kind !== `workspace-${collections[field as Collection]}` || !isRecord(item.value) || item.value.id !== refs[i].id) throw corrupt()
          return item.value
        })
      }))
      return team
    }))
    const value = { state: { ...head.meta, teams }, ...(head.version === undefined ? {} : { version: head.version }) }
    if (!valid(value)) throw corrupt()
    return { head, value }
  }
  function assertCurrent(raw: unknown, expected: unknown): void {
    if (token(raw) !== expected) throw new WorkspaceDatabaseError('conflict', '工作区已被另一个窗口更新；请重新载入，避免覆盖较新的数据。')
  }
  function referencedKeys(name: string, heads: (Head | Tombstone | undefined)[]): Map<string, IDBValidKey> {
    const keys = new Map<string, IDBValidKey>()
    for (const head of heads) if (head?.kind === 'workspace-head') for (const ref of head.teams) {
      keys.set(`team\0${ref.key}`, teamKey(name, ref.key))
      for (const [field, refs] of Object.entries(ref.collections || {})) for (const item of refs)
        keys.set(`${collections[field as Collection]}\0${item.key}`, itemKey(name, field as Collection, item.key))
    }
    return keys
  }
  async function collect(store: IDBObjectStore, name: string, heads: (Head | Tombstone | undefined)[], obsolete?: unknown): Promise<void> {
    const keep = referencedKeys(name, heads)
    if (obsolete !== undefined) {
      // Normal commits only retire the old previous revision. There is no need
      // to traverse every historical message on each streaming update.
      if (validHead(obsolete)) for (const [id, key] of referencedKeys(name, [obsolete])) if (!keep.has(id)) store.delete(key)
      return
    }
    // Explicit recovery/removal also collects unreferenced rows from a damaged
    // head whose complete reference list may no longer be readable.
    await new Promise<void>((resolve, reject) => {
      const cursor = store.openKeyCursor()
      cursor.onerror = () => reject(cursor.error)
      cursor.onsuccess = () => {
        const item = cursor.result
        if (!item) { resolve(); return }
        const key = item.key
        if (Array.isArray(key) && key[0] === name && ['team', ...Object.values(collections)].includes(String(key[1])) &&
          !keep.has(`${key[1]}\0${key[2]}`)) store.delete(key)
        item.continue()
      }
    })
  }
  async function commit(name: string, value: StorageValue<T>, previous: Snapshot<T>, importMarker?: string): Promise<Snapshot<T>> {
    if (!valid(value)) throw new WorkspaceDatabaseError('invalid', '工作区快照格式无效，未写入数据库。')
    if (importMarker !== undefined) checkMarker(importMarker)
    const revision = crypto.randomUUID()
    const { teams, ...meta } = value.state
    const oldRefs = previous.head?.kind === 'workspace-head' ? previous.head.teams : []
    const oldTeams = new Map(previous.value?.state.teams.map((team, index) => [team.id, { team, ref: oldRefs[index] }]) || [])
    const changed: { key: IDBValidKey; value: unknown }[] = []
    const refs = teams.map((team, index) => {
      const old = oldTeams.get(team.id)
      if (old?.team === team && old.ref) return old.ref
      const key = `${revision}:${index}`
      const body = { ...team } as Record<string, unknown>
      const ref: TeamRef = { id: team.id, key }
      for (const field of Object.keys(collections) as Collection[]) {
        const items = body[field]
        // Preserve older/custom payloads with duplicate or non-record entries
        // inline. Splitting must never silently deduplicate previously valid data.
        if (!Array.isArray(items) || items.some((item) => !isRecord(item) || typeof item.id !== 'string' || !item.id) ||
          new Set(items.map((item) => item.id)).size !== items.length) continue
        const oldItems = (old?.team as Record<string, unknown> | undefined)?.[field]
        const oldItemRefs = old?.ref.collections?.[field]
        const oldById = new Map(Array.isArray(oldItems) ? oldItems.flatMap((item, i) =>
          isRecord(item) && typeof item.id === 'string' ? [[item.id, { item, ref: oldItemRefs?.[i] }] as const] : []) : [])
        const itemRefs = items.map((item, itemIndex) => {
          const previous = oldById.get(item.id)
          if (previous && previous.item === item && previous.ref) return previous.ref
          const itemRef = { id: item.id, key: `${revision}:${index}:${itemIndex}` }
          changed.push({ key: itemKey(name, field, itemRef.key), value: { kind: `workspace-${collections[field]}`, value: item } })
          return itemRef
        })
        ;(ref.collections ||= {})[field] = itemRefs
        delete body[field]
      }
      changed.push({ key: teamKey(name, key), value: { kind: 'workspace-team', value: body } })
      return ref
    })
    const restore = importMarker !== undefined || previous.marker != null || previous.restorePoint !== undefined || requiresControls(previous.head)
    const head: Head = { kind: 'workspace-head', format: 4, ...(restore ? { restore: true } : {}), revision, meta, teams: refs,
      ...(value.version === undefined ? {} : { version: value.version }) }
    const control = await transaction('readwrite', async (store) => {
      const [current, retired, control] = await Promise.all([request(store.get(headKey(name))), request(store.get(headKey(name, 'previous'))), controls(store, name)])
      assertCurrent(current, token(previous.head))
      assertControls(control, previous)
      let point = control.restorePoint
      if (importMarker !== undefined) {
        // Replacing a pin must never discard the only copy of a damaged restore point.
        if (importMarker === control.marker || importMarker === point?.marker) throw new WorkspaceDatabaseError('invalid', '请为每次工作区恢复使用新的操作编号。')
        if (point) await loadRestorePoint(store, name, point)
        point = { kind: 'workspace-restore-point', revision: crypto.randomUUID(), head: previous.head ?? null, marker: control.marker }
        store.put(point, headKey(name, 'restorePoint'))
        store.put({ kind: 'workspace-import-marker', value: importMarker }, headKey(name, 'importMarker'))
      }
      for (const entry of changed) store.put(entry.value, entry.key)
      store.put(head, headKey(name))
      if (previous.head?.kind === 'workspace-head') store.put(protectedHead(previous.head, restore), headKey(name, 'previous'))
      else store.delete(headKey(name, 'previous'))
      const keep = [head, previous.head, point?.head ?? undefined]
      await collect(store, name, keep, retired ?? null)
      if (importMarker !== undefined) await collect(store, name, keep, control.restorePoint?.head ?? null)
      return { marker: importMarker ?? control.marker, restorePoint: point }
    })
    return { head, value, ...control }
  }
  function ready(name: string): Snapshot<T> {
    const previous = snapshots.get(name)
    if (!previous) throw new WorkspaceDatabaseError('uninitialized', '工作区尚未成功读取，已阻止保存以保护原有数据。')
    return previous
  }
  return {
    getItem: (name) => enqueue(async () => {
      snapshots.delete(name)
      const current = await transaction('readonly', async (store) => {
        const [raw, control] = await Promise.all([request(store.get(headKey(name))), controls(store, name)])
        observed.set(name, token(raw))
        observedMarkers.set(name, control.marker)
        if (raw === undefined && (control.marker !== null || control.restorePoint)) throw corrupt()
        assertRequiredControls(name, raw, control)
        // Validate pinned records once during hydration, not on each streaming
        // write. Immutable pinned rows are retained until an explicit restore.
        if (control.restorePoint) await loadRestorePoint(store, name, control.restorePoint)
        return { ...await load(store, name, raw), ...control }
      })
      if (current.head !== undefined) { snapshots.set(name, current); return current.value }
      // Only an absent head may migrate. Read/parse/validation failure never
      // masquerades as an empty workspace and never deletes the source key.
      let raw: string | null
      try { raw = options.legacy()?.getItem(name) ?? null } catch (error) { throw unavailable(error) }
      if (raw !== null) {
        let value: StorageValue<T>
        try {
          value = JSON.parse(raw)
          if (options.normalizeLegacy) value = options.normalizeLegacy(value)
        } catch (error) { throw new WorkspaceDatabaseError('corrupt', '旧版工作区无法读取；已保留原数据并停止迁移。', { cause: error }) }
        if (!valid(value)) throw corrupt()
        const migrated = await commit(name, value, current)
        snapshots.set(name, migrated)
        observed.set(name, token(migrated.head))
        return value
      }
      snapshots.set(name, current)
      return null
    }),
    setItem: (name, value) => enqueue(async () => {
      const saved = await commit(name, value, ready(name))
      snapshots.set(name, saved)
      observed.set(name, token(saved.head))
    }),
    removeItem: (name) => enqueue(async () => {
      const previous = ready(name)
      const tombstone: Tombstone = { kind: 'workspace-tombstone-v4', revision: crypto.randomUUID(),
        ...(previous.restorePoint || previous.marker != null || requiresControls(previous.head) ? { restore: true } : {}) }
      await transaction('readwrite', async (store) => {
        assertCurrent(await request(store.get(headKey(name))), token(previous.head))
        const control = await controls(store, name)
        assertControls(control, previous)
        store.put(tombstone, headKey(name)); store.delete(headKey(name, 'previous'))
        await collect(store, name, [control.restorePoint?.head ?? undefined])
      })
      snapshots.set(name, { ...previous, head: tombstone, value: null })
      observed.set(name, token(tombstone))
    }),
    getPrevious: (name) => enqueue(() => transaction('readonly', async (store) => {
      const current = await request(store.get(headKey(name)))
      const control = await controls(store, name)
      assertRequiredControls(name, current, control)
      observed.set(name, token(current))
      observedMarkers.set(name, control.marker)
      const previous = await request(store.get(headKey(name, 'previous')))
      assertRequiredControls(name, previous, control)
      return (await load(store, name, previous)).value
    }), false),
    recoverPrevious: (name) => enqueue(async () => {
      const recovered = await transaction('readwrite', async (store) => {
        const raw = await request(store.get(headKey(name)))
        const control = await controls(store, name)
        assertRequiredControls(name, raw, control)
        if (observed.has(name)) assertCurrent(raw, observed.get(name))
        if (observedMarkers.has(name) && observedMarkers.get(name) !== control.marker) throw new WorkspaceDatabaseError('conflict', '工作区恢复状态已变化，请重新读取。')
        if (control.restorePoint) await loadRestorePoint(store, name, control.restorePoint)
        const previous = await load(store, name, await request(store.get(headKey(name, 'previous'))))
        assertRequiredControls(name, previous.head, control)
        if (!previous.value || previous.head?.kind !== 'workspace-head') throw new WorkspaceDatabaseError('corrupt', '没有可用的上一份工作区快照；原数据已保留。')
        const head: Head = { ...protectedHead(previous.head, !!control.restorePoint), revision: crypto.randomUUID() }
        store.put(head, headKey(name))
        store.put(protectedHead(previous.head, !!control.restorePoint), headKey(name, 'previous'))
        // Do not rotate the damaged head over the last known good revision.
        await collect(store, name, [head, previous.head, control.restorePoint?.head ?? undefined])
        return { head, value: previous.value, ...control }
      })
      snapshots.set(name, recovered)
      observed.set(name, token(recovered.head))
      return recovered.value
    }),
    getRestorePoint: (name) => enqueue(() => transaction('readonly', async (store) => {
      const control = await controls(store, name), { restorePoint } = control
      assertRequiredControls(name, await request(store.get(headKey(name))), control)
      return restorePoint ? (await loadRestorePoint(store, name, restorePoint)).value : null
    }), false),
    getImportMarker: (name) => enqueue(() => transaction('readonly', async (store) => {
      const control = await controls(store, name)
      assertRequiredControls(name, await request(store.get(headKey(name))), control)
      return control.marker
    }), false),
    commitRestore: (name, value, marker) => enqueue(async () => {
      const saved = await commit(name, value, ready(name), marker)
      snapshots.set(name, saved)
      observed.set(name, token(saved.head)); observedMarkers.set(name, saved.marker ?? null)
    }),
    rollbackRestore: (name, marker) => enqueue(async () => {
      checkMarker(marker)
      const current = ready(name)
      const recovered = await transaction('readwrite', async (store) => {
        const [raw, control] = await Promise.all([request(store.get(headKey(name))), controls(store, name)])
        assertCurrent(raw, token(current.head)); assertControls(control, current)
        if (marker === control.marker || marker === control.restorePoint?.marker) throw new WorkspaceDatabaseError('invalid', '请为每次工作区恢复使用新的操作编号。')
        const pinned = await loadRestorePoint(store, name, control.restorePoint)
        if (!pinned.value || pinned.head?.kind !== 'workspace-head') throw new WorkspaceDatabaseError('corrupt', '没有可用的导入前工作区快照；原数据已保留。')
        const head: Head = { ...protectedHead(pinned.head, true), revision: crypto.randomUUID() }
        const restorePoint: RestorePoint = { kind: 'workspace-restore-point', revision: crypto.randomUUID(), head: current.head ?? null, marker: control.marker }
        store.put(head, headKey(name)); store.put(restorePoint, headKey(name, 'restorePoint'))
        store.put({ kind: 'workspace-import-marker', value: marker }, headKey(name, 'importMarker'))
        if (current.head?.kind === 'workspace-head') store.put(protectedHead(current.head, true), headKey(name, 'previous'))
        else store.delete(headKey(name, 'previous'))
        await collect(store, name, [head, current.head])
        return { head, value: pinned.value, marker, restorePoint }
      })
      snapshots.set(name, recovered)
      observed.set(name, token(recovered.head)); observedMarkers.set(name, marker)
      return recovered.value
    }),
    flush: async () => {
      let draining: Promise<void>
      do { draining = queue; await draining } while (draining !== queue)
      if (lastFailure) throw lastFailure
    },
    close: async () => {
      closing = true
      await queue
      live?.close(); live = undefined; connection = undefined
      if (lastFailure) throw lastFailure
    }
  }
}
