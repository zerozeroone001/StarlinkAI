import assert from 'node:assert/strict'
import test from 'node:test'
import { batchedStorage } from '../src/renderer/src/lib/batched-storage'

const deferred = () => {
  let resolve!: () => void, reject!: (cause: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const value = (text: string) => ({ state: { text } })

test('flush waits for commits and drains the newest edit arriving during an in-flight commit', async () => {
  const first = deferred(), second = deferred(), writes: string[] = []
  const storage = batchedStorage<{ text: string }>({ getItem: () => null, removeItem: () => {},
    setItem: (_key, item) => { writes.push(item.state.text); return writes.length === 1 ? first.promise : second.promise }
  }, () => false)
  storage.setItem('workspace', value('first'))
  const flushed = storage.flush()
  storage.setItem('workspace', value('superseded'))
  storage.setItem('workspace', value('latest'))
  let finished = false
  void flushed.then(() => { finished = true })
  first.resolve()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(finished, false)
  assert.deepEqual(writes, ['first', 'latest'])
  second.resolve(); await flushed
  assert.equal(storage.hasPending(), false)
})

test('failed transactions retain the latest value, do not retry in a loop, and explicitly retry successfully', async () => {
  const first = deferred(), writes: string[] = [], errors: unknown[] = []
  const storage = batchedStorage<{ text: string }>({ getItem: () => null, removeItem: () => {},
    setItem: (_key, item) => { writes.push(item.state.text); return writes.length === 1 ? first.promise : Promise.resolve() }
  }, () => false, { error: (error) => errors.push(error) })
  storage.setItem('workspace', value('first'))
  const failed = storage.flush()
  storage.setItem('workspace', value('latest'))
  first.reject(new Error('disk failure'))
  await assert.rejects(failed, /disk failure/)
  assert.equal(errors.length, 1)
  assert.equal(storage.hasPending(), true)
  assert.deepEqual(writes, ['first'])
  assert.deepEqual(storage.getItem('workspace'), value('latest'))
  await storage.flush()
  assert.deepEqual(writes, ['first', 'latest'])
  assert.equal(storage.hasPending(), false)
})

test('remove during a commit does not resurrect data and a later edit survives the queued remove', async () => {
  for (const laterEdit of [false, true]) {
    const first = deferred(), disk = new Map<string, string>()
    let writes = 0
    const storage = batchedStorage<{ text: string }>({ getItem: () => null,
      removeItem: (key) => { disk.delete(key) },
      setItem: (key, item) => ++writes === 1 ? first.promise.then(() => { disk.set(key, item.state.text) }) : void disk.set(key, item.state.text)
    }, () => false)
    storage.setItem('workspace', value('old'))
    const removed = storage.removeItem('workspace')
    assert.equal(storage.getItem('workspace'), null)
    if (laterEdit) storage.setItem('workspace', value('new'))
    first.resolve(); await removed; await storage.flush()
    assert.equal(disk.get('workspace'), laterEdit ? 'new' : undefined)
    assert.equal(storage.hasPending(), false)
  }
})

test('an edit queued by the successful-save observer belongs to the same flush barrier', async () => {
  const writes: string[] = []
  let notified = false
  const storage = batchedStorage<{ text: string }>({ getItem: () => null, removeItem: () => {},
    setItem: async (_key, item) => { writes.push(item.state.text) }
  }, () => false, { saved: () => {
    if (!notified) { notified = true; queueMicrotask(() => storage.setItem('workspace', value('observer edit'))) }
  } })
  storage.setItem('workspace', value('initial'))
  await storage.flush()
  assert.deepEqual(writes, ['initial', 'observer edit'])
  assert.equal(storage.hasPending(), false)
})
