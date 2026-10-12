import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { Team } from '@/lib/collaboration-data'
import { isActive, useCollaboration } from '@/stores/collaboration'
import { WorkspaceDialog } from './WorkspaceDialogs'

export function ConversationActions({ team }: { team: Team }) {
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState(team.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useCollaboration((s) => Object.values(s.runs).some((r) => r.workspaceId === team.id && isActive(r.status)))
  if (team.kind !== 'conversation') return null
  const close = () => { if (!busy) { setMode(null); setError('') } }
  return (
    <div className="conversation-actions no-drag" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn" title="重命名对话" aria-label={`重命名对话：${team.name}`}
        onClick={() => { setName(team.name); setError(''); setMode('rename') }}><Pencil size={14} /></button>
      <button type="button" className="icon-btn" title="删除对话" aria-label={`删除对话：${team.name}`}
        onClick={() => { setError(''); setMode('delete') }}><Trash2 size={14} /></button>
      {mode && <WorkspaceDialog title={mode === 'rename' ? '重命名对话' : '删除对话'} close={close}>
        <form className="ws-form" onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          if (mode === 'rename') {
            if (useCollaboration.getState().renameConversation(team.id, name)) close()
            else setError('请输入 1–80 个字符的对话名称。')
          } else {
            setBusy(true)
            setError('')
            try {
              if (await useCollaboration.getState().deleteConversation(team.id)) setMode(null)
              else setError(useCollaboration.getState().runtimeError || '请等待停止完成后重试。')
            } finally { setBusy(false) }
          }
        }}>
          {mode === 'rename' ? <label>对话名称<input aria-label="对话名称" value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} /></label> :
            <p>删除「{team.name}」及其消息记录？{running ? '当前生成会先停止。' : ''}已保存的图片文件会保留。</p>}
          {error && <p className="ws-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="ws-button" disabled={busy} onClick={close}>取消</button>
            <button type="submit" className={mode === 'delete' ? 'ws-button danger' : 'ws-button primary'} disabled={busy || (mode === 'rename' && !name.trim())}>
              {busy ? '正在停止并删除…' : mode === 'rename' ? '保存名称' : running ? '停止并删除' : '删除对话'}
            </button>
          </footer>
        </form>
      </WorkspaceDialog>}
    </div>
  )
}
