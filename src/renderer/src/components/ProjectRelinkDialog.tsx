import { useEffect, useRef, useState } from 'react'
import type { ProjectRelinkPreview } from '@shared/project-relink'
import { cancelProjectRelink, commitProjectRelink, prepareProjectRelink } from '@/stores/collaboration'
import { portableErrorMessage, portableSize } from '@/lib/portable-backup-display'
import { WorkspaceDialog } from './WorkspaceDialogs'
import './project-relink.css'

type Progress = { phase: 'idle' | 'preparing' | 'preview' | 'committing'; done: number; total: number; cancellable: boolean }

export function ProjectRelinkDialog({ projectId, projectName, directory, conversations, close, completed }: {
  projectId: string; projectName: string; directory: string; conversations: number
  close: () => void; completed: (message: string) => void
}) {
  const [preview, setPreview] = useState<ProjectRelinkPreview | null>(null)
  const [busy, setBusy] = useState(true)
  const [committing, setCommitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [allowIncomplete, setAllowIncomplete] = useState(false)
  const [warningPage, setWarningPage] = useState(0)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [progress, setProgress] = useState<Progress>({ phase: 'preparing', done: 0, total: 0, cancellable: true })
  const mounted = useRef(true), started = useRef(false), working = useRef(true)
  const cancelled = useRef(false), closing = useRef(false), committingRef = useRef(false)
  const previewRef = useRef<ProjectRelinkPreview | null>(null), progressRef = useRef(progress)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        const value = await prepareProjectRelink(projectId)
        if (!mounted.current || cancelled.current) {
          if (value) await cancelProjectRelink(value.token)
          return
        }
        if (!value) { close(); return }
        previewRef.current = value; setPreview(value)
      } catch (cause) {
        if (mounted.current && !cancelled.current) setError(portableErrorMessage(cause))
      } finally { working.current = false; if (mounted.current) setBusy(false) }
    })()
  }, [projectId, close])
  useEffect(() => {
    if (!busy) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const update = async () => {
      try {
        const value = await window.grok.projectRelink.status()
        if (active) { progressRef.current = value; setProgress(value); setStatusError('') }
      } catch { if (active) setStatusError('暂时无法读取进度，操作仍在进行，请等待操作结果。') }
      if (active) timer = setTimeout(() => void update(), 250)
    }
    void update()
    return () => { active = false; clearTimeout(timer) }
  }, [busy])
  const dismiss = async () => {
    if (closing.current || committingRef.current || (working.current && !progressRef.current.cancellable)) return
    closing.current = true; setCancelling(true); setError('')
    try {
      await cancelProjectRelink(previewRef.current?.token)
      cancelled.current = true
      if (mounted.current) close()
    } catch (cause) {
      closing.current = false
      if (mounted.current) { setCancelling(false); setError(portableErrorMessage(cause)) }
    }
  }
  const submit = async () => {
    if (working.current || closing.current || !preview || !confirmed || (preview.warnings.length > 0 && !allowIncomplete)) return
    working.current = true; committingRef.current = true
    setCommitting(true); setBusy(true); setError(''); setStatusError('')
    try {
      await commitProjectRelink(preview.token, allowIncomplete)
      if (mounted.current && !cancelled.current) completed(`项目目录已重新关联并保存。${preview.warnings.length ? `有 ${preview.warnings.length} 项历史资源未能保留，请按预览清单补齐。` : '历史资源与助手资料已保留。'}名称和目标的编辑仍需点击“保存更改”。`)
    } catch (cause) {
      if (mounted.current) { setError(portableErrorMessage(cause)); setPreview(null); previewRef.current = null; setConfirmed(false) }
    } finally {
      working.current = false; committingRef.current = false
      if (mounted.current) { setBusy(false); setCommitting(false) }
    }
  }
  const warnings = preview?.warnings || [], pages = Math.ceil(warnings.length / 100)
  const canCancel = !committing && (!busy || progress.cancellable)
  const determinate = Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.done) && progress.done >= 0
  return <WorkspaceDialog title="重新关联项目目录" close={() => void dismiss()} closeDisabled={!canCancel || cancelling}
    className="project-relink-dialog" wide>
    <div className="project-relink-body" aria-busy={busy || cancelling}>
      <h3>{projectName}</h3>
      {busy || cancelling ? <div className="project-relink-progress" role="status" aria-live="polite">
        <strong>{cancelling ? '正在取消，请稍候…' : committing ? '正在保存项目目录…' : '正在选择目录并保留历史资源…'}</strong>
        <progress aria-label="项目目录关联进度" {...(!committing && determinate ? { value: Math.min(progress.done, progress.total), max: progress.total } : {})} />
        {!committing && determinate && <span>已处理 {Math.min(progress.done, progress.total).toLocaleString()} / {progress.total.toLocaleString()} 项引用</span>}
        <p>{committing ? '正在完成保存，暂不能取消或关闭。保存完成前不会显示关联成功。' : '请选择项目源码所在目录；如历史文件需要访问旧目录，会再次询问。取消后原项目保持不变。'}</p>
        {statusError && <p>{statusError}</p>}
      </div> : preview && <>
        <dl className="project-relink-paths">
          <div><dt>当前目录</dt><dd>{directory}</dd></div>
          <div><dt>将关联到</dt><dd>{preview.directory}</dd></div>
          <div><dt>已保留的历史文件</dt><dd>{preview.files.toLocaleString()} 个 · {portableSize(preview.bytes)}</dd></div>
        </dl>
        {warnings.length > 0 && <section className="project-relink-warnings" aria-label="未保留的历史资源">
          <h4>{warnings.length} 项历史资源未能保留</h4>
          <p>历史消息会保留，但缺失的原文件不会被补全，也不会改为读取新目录中的同名文件。</p>
          <ul>{warnings.slice(warningPage * 100, (warningPage + 1) * 100).map((warning, index) => <li key={`${warningPage}-${index}`}><strong>{warning.name}</strong><span>{warning.reason}</span></li>)}</ul>
          {pages > 1 && <div className="project-relink-pages"><button type="button" className="ws-button" disabled={warningPage === 0} onClick={() => setWarningPage(page => page - 1)}>上一页</button>
            <span>第 {warningPage + 1} / {pages} 页</span><button type="button" className="ws-button" disabled={warningPage + 1 === pages} onClick={() => setWarningPage(page => page + 1)}>下一页</button></div>}
          <label><input type="checkbox" checked={allowIncomplete} onChange={event => setAllowIncomplete(event.target.checked)} />我已了解缺失资源，仍继续关联</label>
        </section>}
        <div className="project-relink-boundary">
          <p>项目及其 {conversations} 个现有子对话将在新目录中继续工作。不会向新目录复制资料或覆盖源码。</p>
          <p>历史消息、草稿、任务、助手身份与记忆保留；可读取的历史附件和图片独立保存在应用中。</p>
          <p>旧的执行连接会清除，下次发送消息后在新目录开始执行；不会自动执行任务或发送消息。</p>
          <p>新目录中的工具操作会重新逐次请求批准，不沿用原目录的自动许可。</p>
          <p>此操作仅保存目录关联，不保存编辑表单中尚未提交的名称和目标。</p>
          <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认将项目及其子对话关联到新目录</label>
        </div>
      </>}
      {error && <p className="ws-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" className="ws-button" disabled={!canCancel || cancelling} onClick={() => void dismiss()}>{busy ? '取消操作' : '返回编辑'}</button>
      {!busy && preview && <button type="button" className="ws-button accent" disabled={cancelling || !confirmed || (!!warnings.length && !allowIncomplete)} onClick={() => void submit()}>确认关联并保存</button>}
    </footer>
  </WorkspaceDialog>
}
