import { create } from 'zustand'
import type { AssistantSnapshot, AssistantProfilePatch, AssistantMemoryInput, AssistantCommitmentInput } from '@shared/assistant'
import { runtimeClient } from '@/lib/runtime-client'

export type { AssistantProfilePatch } from '@shared/assistant'
export type MemoryInput = AssistantMemoryInput
export type CommitmentInput = AssistantCommitmentInput
type Result = Promise<AssistantSnapshot | undefined>

interface AssistantState {
  snapshots: Record<string, AssistantSnapshot>
  loading: Record<string, boolean>
  saving: Record<string, number>
  errors: Record<string, string | undefined>
  applySnapshot: (snapshot: AssistantSnapshot) => void
  refresh: (scopeId: string) => Result
  updateProfile: (scopeId: string, patch: AssistantProfilePatch) => Result
  saveMemory: (scopeId: string, input: MemoryInput) => Result
  forgetMemory: (scopeId: string, id: string) => Result
  saveCommitment: (scopeId: string, input: CommitmentInput) => Result
  deleteCommitment: (scopeId: string, id: string) => Result
  clearScope: (scopeId: string) => Result
}

const reads = new Map<string, Result>()
const writes = new Map<string, Result>()
const operations = new Map<string, number>()

function nextOperation(scopeId: string) {
  const operation = (operations.get(scopeId) || 0) + 1
  operations.set(scopeId, operation)
  return operation
}

function receive(scopeId: string, snapshot: AssistantSnapshot): AssistantSnapshot {
  if (snapshot.profile.scopeId !== scopeId) throw new Error('主 agent 资料所属项目不匹配。')
  useAssistant.getState().applySnapshot(snapshot)
  return useAssistant.getState().snapshots[scopeId]
}

function reportError(scopeId: string, operation: number, error: unknown) {
  if (operations.get(scopeId) !== operation) return
  useAssistant.setState((state) => ({ errors: { ...state.errors,
    [scopeId]: error instanceof Error ? error.message : '主 agent 资料保存失败，请重试。' } }))
}

function mutate(scopeId: string, request: () => Promise<AssistantSnapshot>): Result {
  const previous = writes.get(scopeId)
  const operation = nextOperation(scopeId)
  useAssistant.setState((state) => ({ saving: { ...state.saving, [scopeId]: (state.saving[scopeId] || 0) + 1 },
    errors: { ...state.errors, [scopeId]: undefined } }))
  const pending = (async () => {
    await previous
    try { return receive(scopeId, await request()) }
    catch (error) { reportError(scopeId, operation, error); return undefined }
    finally {
      useAssistant.setState((state) => ({ saving: { ...state.saving, [scopeId]: Math.max(0, (state.saving[scopeId] || 1) - 1) } }))
    }
  })()
  writes.set(scopeId, pending)
  void pending.finally(() => { if (writes.get(scopeId) === pending) writes.delete(scopeId) })
  return pending
}

export const useAssistant = create<AssistantState>((set, get) => ({
  snapshots: {},
  loading: {},
  saving: {},
  errors: {},
  applySnapshot: (snapshot) => {
    const scopeId = snapshot.profile.scopeId
    if (get().snapshots[scopeId] && get().snapshots[scopeId].revision > snapshot.revision) return
    set((state) => ({ snapshots: { ...state.snapshots, [scopeId]: snapshot } }))
  },
  refresh: (scopeId): Result => {
    const existing = reads.get(scopeId)
    if (existing) return existing
    const operation = nextOperation(scopeId)
    set((state) => ({ loading: { ...state.loading, [scopeId]: true }, errors: { ...state.errors, [scopeId]: undefined } }))
    const pending = (async () => {
      try {
        await writes.get(scopeId)
        return receive(scopeId, await runtimeClient.assistant(scopeId))
      } catch (error) { reportError(scopeId, operation, error); return undefined }
      finally { set((state) => ({ loading: { ...state.loading, [scopeId]: false } })) }
    })()
    reads.set(scopeId, pending)
    void pending.finally(() => { if (reads.get(scopeId) === pending) reads.delete(scopeId) })
    return pending
  },
  updateProfile: (scopeId, patch) => mutate(scopeId, () => runtimeClient.updateAssistant(scopeId, patch)),
  saveMemory: (scopeId, input) => mutate(scopeId, () => runtimeClient.saveMemory(scopeId, input)),
  forgetMemory: (scopeId, id) => mutate(scopeId, () => runtimeClient.forgetMemory(scopeId, id)),
  saveCommitment: (scopeId, input) => mutate(scopeId, () => runtimeClient.saveCommitment(scopeId, input)),
  deleteCommitment: (scopeId, id) => mutate(scopeId, () => runtimeClient.deleteCommitment(scopeId, id)),
  clearScope: (scopeId) => mutate(scopeId, () => runtimeClient.clearAssistant(scopeId))
}))
