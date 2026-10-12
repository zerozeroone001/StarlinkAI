import { randomUUID } from 'node:crypto'

export type WorkspaceExitAction = 'reload' | 'close' | 'quit'
export interface WorkspaceSaveResult { ok: boolean; error?: string }
const priority: Record<WorkspaceExitAction, number> = { reload: 0, close: 1, quit: 2 }

/** Coordinates a single document's save acknowledgement before leaving it. */
export function createWorkspaceLifecycle(options: {
  available(): boolean
  prepare(id: string): void
  resume(): void
  confirmDiscard(error: string, action: WorkspaceExitAction): Promise<boolean>
  perform(action: WorkspaceExitAction, force: boolean): Promise<void> | void
  timeoutMs?: number
}) {
  let ready = false
  let generation = 0
  let allowedToUnload = false
  let target: WorkspaceExitAction = 'close'
  let pending: Promise<boolean> | undefined
  let acknowledgement: { id: string; generation: number; resolve: (result: WorkspaceSaveResult) => void } | undefined

  function receive(id: unknown, result: unknown) {
    if (typeof id !== 'string' || !acknowledgement || id !== acknowledgement.id ||
        acknowledgement.generation !== generation) throw new Error('保存请求已失效。')
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        typeof (result as WorkspaceSaveResult).ok !== 'boolean' ||
        ((result as WorkspaceSaveResult).error !== undefined &&
          (typeof (result as WorkspaceSaveResult).error !== 'string' || (result as WorkspaceSaveResult).error!.length > 2000)))
      throw new Error('保存回执格式无效。')
    acknowledgement.resolve(result as WorkspaceSaveResult)
  }

  async function save(): Promise<WorkspaceSaveResult> {
    if (!ready || !options.available()) return { ok: true }
    return new Promise((resolve) => {
      const id = randomUUID()
      const finish = (result: WorkspaceSaveResult) => {
        if (acknowledgement?.id !== id) return
        clearTimeout(timer)
        acknowledgement = undefined
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, error: '页面未及时确认保存。当前窗口仍保留，请稍后重试。' }), options.timeoutMs ?? 15000)
      acknowledgement = { id, generation, resolve: finish }
      try { options.prepare(id) }
      catch { finish({ ok: false, error: '无法联系页面完成保存。' }) }
    })
  }

  function request(action: WorkspaceExitAction): Promise<boolean> {
    if (pending) {
      if (priority[action] > priority[target]) target = action
      return pending
    }
    target = action
    let completed = false
    const currentGeneration = generation
    const task = (async () => {
      const saved = await save()
      if (currentGeneration !== generation) return false
      if (!saved.ok && !await options.confirmDiscard(saved.error || '工作区保存失败，尚未保存的修改仍保留在当前窗口。', target)) return false
      if (currentGeneration !== generation) return false
      allowedToUnload = true
      try { await options.perform(target, false) }
      catch (error) {
        allowedToUnload = false
        if (!await options.confirmDiscard(error instanceof Error ? error.message : '后台记录未能完成保存。', target)) return false
        if (currentGeneration !== generation) return false
        allowedToUnload = true
        await options.perform(target, true)
      }
      completed = true
      return true
    })().catch(() => false).finally(() => {
      pending = undefined
      if (!completed) {
        allowedToUnload = false
        if (currentGeneration === generation && options.available()) options.resume()
      }
    })
    pending = task
    return task
  }

  return {
    ready() { ready = true },
    receive,
    request,
    get busy() { return !!pending },
    get canUnload() { return allowedToUnload },
    /** Called only after document commit/crash, never on an attempted navigation. */
    invalidate() {
      ready = false
      allowedToUnload = false
      generation++
      acknowledgement?.resolve({ ok: false, error: '页面已更换，原保存请求已取消。' })
    }
  }
}
