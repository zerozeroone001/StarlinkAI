import { hasPendingWorkspaceStorage, prepareWorkspaceClose, resumeWorkspace } from '@/stores/collaboration'
import { workspaceStorageStatus } from './workspace-storage-status'

// Installed once, before React mounts (StrictMode must not duplicate ACKs).
export function registerWorkspaceLifecycle(): void {
  const bridge = window.grok?.persistence
  if (bridge) {
    bridge.onPrepareClose((id) => {
      const operation = workspaceStorageStatus.getSnapshot().phase === 'ready'
        ? prepareWorkspaceClose() : Promise.resolve()
      void operation.then(() => bridge.respondClose(id, { ok: true }), (error) =>
        bridge.respondClose(id, { ok: false, error: error instanceof Error ? error.message : '保存失败，请保留窗口并导出备份。' }))
        .catch(() => resumeWorkspace())
    })
    bridge.onResume(resumeWorkspace)
    bridge.ready()
  }
  window.addEventListener('beforeunload', (event) => {
    if (!hasPendingWorkspaceStorage() || workspaceStorageStatus.getSnapshot().phase !== 'ready') return
    event.preventDefault()
    event.returnValue = ''
  })
}
