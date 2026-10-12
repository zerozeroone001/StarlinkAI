import type { PersistStorage, StorageValue } from 'zustand/middleware'

// Keep the newest value until its transaction commits. A write arriving during
// a commit is drained afterwards; failures retain the newest value for retry.
export function batchedStorage<T>(storage: PersistStorage<T>, defer: (state: T) => boolean,
  events: { pending?: (value: boolean) => void; error?: (error: unknown) => void; saved?: () => void } = {}) {
  const pending = new Map<string, StorageValue<T> | null>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (inFlight) return inFlight
    const drain = (): void | Promise<void> => {
      for (const [key, value] of pending) {
        const result = value === null ? storage.removeItem(key) : storage.setItem(key, value)
        if (result && typeof (result as Promise<unknown>).then === 'function')
          return Promise.resolve(result).then(() => {
            if (pending.get(key) === value) pending.delete(key)
            return drain()
          })
        if (pending.get(key) === value) pending.delete(key)
      }
      events.pending?.(false)
      events.saved?.()
    }
    try {
      const result = drain()
      if (!result) return Promise.resolve()
      let failed = false
      const operation: Promise<void> = result.catch((error) => { failed = true; events.error?.(error); throw error })
        .finally(() => {
          if (inFlight === operation) inFlight = undefined
          if (!failed && pending.size) return flush()
        })
      inFlight = operation
      // Zustand does not await action-triggered writes. Explicit flush callers
      // still receive the rejection while background writes cannot leak it.
      void operation.catch(() => {})
      return operation
    } catch (error) {
      events.error?.(error)
      const failed = Promise.reject<void>(error)
      void failed.catch(() => {})
      return failed
    }
  }
  const backgroundFlush = () => { void flush().catch(() => {}) }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', backgroundFlush)
    window.addEventListener('beforeunload', backgroundFlush)
    document.addEventListener('visibilitychange', () => { if (document.hidden) backgroundFlush() })
  }
  return {
    flush,
    hasPending: () => pending.size > 0 || !!inFlight,
    discardPending: () => {
      if (inFlight) throw new Error('Cannot discard a transaction that is still committing')
      clearTimeout(timer); timer = undefined; pending.clear(); events.pending?.(false)
    },
    getItem: (key: string) => pending.has(key) ? pending.get(key)! : storage.getItem(key),
    setItem: (key: string, value: StorageValue<T>) => {
      pending.set(key, value)
      events.pending?.(true)
      if (!defer(value.state)) return flush()
      if (!timer) timer = setTimeout(backgroundFlush, 500)
    },
    removeItem: (key: string) => {
      pending.set(key, null)
      events.pending?.(true)
      return flush()
    }
  }
}
