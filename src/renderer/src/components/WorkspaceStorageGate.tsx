import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { recoverPreviousWorkspace, retryWorkspaceLoad } from '@/stores/collaboration'
import { workspaceStorageStatus } from '@/lib/workspace-storage-status'

export function WorkspaceStorageGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(workspaceStorageStatus.subscribe, workspaceStorageStatus.getSnapshot)
  const [confirmed, setConfirmed] = useState(false)
  if (state.phase !== 'ready') return <main className="workspace-storage-gate">
    <div className={state.phase === 'error' ? 'workspace-startup-error' : 'workspace-startup-loading'} role={state.phase === 'error' ? 'alert' : 'status'}>
      <h1>{state.phase === 'error' ? '暂时无法打开工作区' : '正在打开工作区…'}</h1>
      {state.phase === 'loading' ? <p>正在读取并验证本机保存的会话和草稿。</p> : <>
        <p>{state.error}</p>
        <p>已有内容不会被空白工作区覆盖。请先重试读取；若仍失败，请保留本机数据以便恢复。</p>
        <button type="button" className="ws-button" onClick={() => { setConfirmed(false); void retryWorkspaceLoad() }}>重新读取工作区</button>
        {state.previousAvailable && <div className="workspace-recovery-choice">
          <p>检测到一份可用的上一份快照。恢复后可能缺少最近一次保存的修改。</p>
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认恢复上一份可用快照</label>
          <button type="button" className="ws-button" disabled={!confirmed} onClick={() => { setConfirmed(false); void recoverPreviousWorkspace() }}>恢复上一份快照</button>
        </div>}
      </>}
    </div>
  </main>
  return <>
    <div className="workspace-ready-content" inert={state.closing || undefined}>{children}</div>
    {state.closing && <div className="workspace-save-overlay" role="status" aria-live="polite">正在保存工作区，请稍候…</div>}
  </>
}
