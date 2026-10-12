export interface WorkspaceStorageStatus {
  phase: 'loading' | 'ready' | 'error'
  pending: boolean
  closing: boolean
  error: string | null
  previousAvailable: boolean
}
let state: WorkspaceStorageStatus = { phase: 'loading', pending: false, closing: false, error: null, previousAvailable: false }
const listeners = new Set<() => void>()
export const workspaceStorageStatus = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  update: (patch: Partial<WorkspaceStorageStatus>) => {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof WorkspaceStorageStatus] === value)) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
}
