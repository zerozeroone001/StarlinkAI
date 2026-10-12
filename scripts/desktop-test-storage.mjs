// Test-only access to isolated Playwright profiles. Nothing here is imported by
// the application or exposed through its preload bridge.
export const WORKSPACE_STORAGE_KEY = 'grok-desktop-collaboration-ui-v1'
export const WORKSPACE_DATABASE_NAME = 'grok-desktop-workspace-v1'
export const workspaceStorageNames = { key: WORKSPACE_STORAGE_KEY, database: WORKSPACE_DATABASE_NAME }

// Self-contained so crash-recovery tests can also execute it through WebContents
// when Playwright still considers the recovered page crashed.
export async function readWorkspaceInRenderer({ key, database }) {
  const legacy = () => JSON.parse(localStorage.getItem(key) || 'null')
  if (!(await indexedDB.databases()).some((entry) => entry.name === database)) return legacy()
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(database)
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Workspace database disappeared while reading')) }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Workspace database read was blocked'))
    request.onsuccess = () => resolve(request.result)
  })
  try {
    const tx = db.transaction('records', 'readonly')
    const completed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error || new Error('Workspace read transaction aborted'))
    })
    void completed.catch(() => {})
    const store = tx.objectStore('records')
    const request = (operation) => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const head = await request(store.get([key, 'head']))
    if (head === undefined) { await completed; return legacy() }
    if (['workspace-tombstone', 'workspace-tombstone-v3', 'workspace-tombstone-v4'].includes(head?.kind)) { await completed; return null }
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
    const collections = { messages: 'message', tasks: 'task', artifacts: 'artifact' }
    const validRefs = (refs) => Array.isArray(refs) && refs.every((ref) => record(ref) && typeof ref.id === 'string' && ref.id && typeof ref.key === 'string' && ref.key) &&
      new Set(refs.map((ref) => ref.id)).size === refs.length && new Set(refs.map((ref) => ref.key)).size === refs.length
    if (head?.kind !== 'workspace-head' || ![1, 2, 3, 4].includes(head.format) || typeof head.revision !== 'string' || !head.revision ||
        !record(head.meta) || Object.hasOwn(head.meta, 'teams') || !Array.isArray(head.teams) ||
        !validRefs(head.teams) || head.teams.some((ref) => ref.collections !== undefined && (![2, 3, 4].includes(head.format) || !record(ref.collections) ||
          Object.entries(ref.collections).some(([field, refs]) => !Object.hasOwn(collections, field) || !validRefs(refs)))))
      throw new Error('Invalid persisted workspace head')
    const rows = await Promise.all(head.teams.map((ref) => request(store.get([key, 'team', ref.key]))))
    const teams = await Promise.all(rows.map(async (row, index) => {
      if (row?.kind !== 'workspace-team' || !record(row.value) || row.value.id !== head.teams[index].id)
        throw new Error(`Missing or invalid persisted workspace team: ${head.teams[index].id}`)
      const team = { ...row.value }
      await Promise.all(Object.entries(head.teams[index].collections || {}).map(async ([field, refs]) => {
        if (Object.hasOwn(team, field)) throw new Error(`Duplicate inline/incremental workspace collection: ${field}`)
        const items = await Promise.all(refs.map((ref) => request(store.get([key, collections[field], ref.key]))))
        team[field] = items.map((item, i) => {
          if (item?.kind !== `workspace-${collections[field]}` || !record(item.value) || item.value.id !== refs[i].id)
            throw new Error(`Missing or invalid persisted workspace ${collections[field]}: ${refs[i].id}`)
          return item.value
        })
      }))
      return team
    }))
    await completed
    return { state: { ...head.meta, teams }, ...(head.version === undefined ? {} : { version: head.version }) }
  } finally { db.close() }
}

export const readWorkspace = (page) => page.evaluate(readWorkspaceInRenderer, workspaceStorageNames)

export async function waitForWorkspace(page, predicate, { timeout = 10000, label = 'expected workspace state' } = {}) {
  const deadline = Date.now() + timeout
  do {
    const value = await readWorkspace(page)
    if (await predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

export async function seedWorkspace(page, value) {
  const url = page.url()
  if (!/^(file:|https?:)/.test(url)) throw new Error('Workspace seeding requires the application origin')
  const session = await page.context().newCDPSession(page)
  try {
    const { frameTree } = await session.send('Page.getFrameTree')
    const { storageKey } = await session.send('Storage.getStorageKeyForFrame', { frameId: frameTree.frame.id })
    // Reload without application scripts first: the old store is unloaded and
    // cannot race deletion or overwrite the fixture during its pagehide flush.
    // Keep the origin's frame alive because CDP DOMStorage requires it.
    await session.send('Emulation.setScriptExecutionDisabled', { value: true })
    await page.reload()
    await session.send('Storage.clearDataForStorageKey', { storageKey, storageTypes: 'indexeddb' })
    await session.send('DOMStorage.setDOMStorageItem', {
      storageId: { storageKey, isLocalStorage: true }, key: WORKSPACE_STORAGE_KEY, value: JSON.stringify(value)
    })
    await session.send('Emulation.setScriptExecutionDisabled', { value: false })
    await page.reload()
    await page.locator('textarea[aria-label="对话消息"], .workspace-startup-error[role="alert"]').first().waitFor({ timeout: 15000 })
    const failed = page.locator('.workspace-startup-error[role="alert"]')
    if (await failed.isVisible()) throw new Error(`Seeded workspace failed to hydrate: ${await failed.innerText()}`)
  } finally {
    await session.send('Emulation.setScriptExecutionDisabled', { value: false })
    await session.detach()
  }
}

// Fail real write transactions while leaving reads and the previous committed
// snapshot intact. Restore this after testing the visible retry path.
export async function failWorkspaceWrites(page) {
  await page.evaluate((database) => {
    if (window.__restoreWorkspaceWrites) throw new Error('Workspace write failure is already installed')
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (this.name === database && args[1] === 'readwrite') queueMicrotask(() => tx.abort())
      return tx
    }
    window.__restoreWorkspaceWrites = () => {
      IDBDatabase.prototype.transaction = transaction
      delete window.__restoreWorkspaceWrites
    }
  }, WORKSPACE_DATABASE_NAME)
}

export async function restoreWorkspaceWrites(page) {
  await page.evaluate(() => {
    if (!window.__restoreWorkspaceWrites) throw new Error('Workspace write failure is not installed')
    window.__restoreWorkspaceWrites()
  })
}
