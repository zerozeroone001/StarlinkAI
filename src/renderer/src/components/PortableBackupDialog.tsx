import { useEffect, useRef, useState } from 'react'
import type { PortablePreview, PortableProgress } from '@shared/portable-backup'
import { beginPortableExport, cancelPortableBackup, inspectPortableImport, restorePortableBackup, rollbackPortableBackup, writePortableExport } from '@/stores/collaboration'
import { portableCountRows, portableErrorMessage, portableProgressLabel, portableProgressValue, portableTitles, type PortableAction } from '@/lib/portable-backup-display'
import { WorkspaceDialog } from './WorkspaceDialogs'
import './portable-backup.css'

export function PortableBackupDialog({ mode, close, completed }: {
  mode: PortableAction; close: () => void; completed: (message: string) => void
}) {
  const [preview, setPreview] = useState<PortablePreview | null>(null)
  const [busy, setBusy] = useState(mode !== 'rollback')
  const [confirmed, setConfirmed] = useState(false)
  const [allowIncomplete, setAllowIncomplete] = useState(false)
  const [warningPage, setWarningPage] = useState(0)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<PortableProgress>({ phase: mode === 'export' ? 'collecting' : 'validating', done: 0, total: 0, cancellable: true })
  const working = useRef(mode !== 'rollback'), started = useRef(false), mounted = useRef(true), cancelled = useRef(false), closing = useRef(false)
  const previewRef = useRef<PortablePreview | null>(null)
  const progressRef = useRef(progress)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (started.current || mode === 'rollback') return
    started.current = true
    void (async () => {
      try {
        const result = mode === 'export' ? await beginPortableExport() : await inspectPortableImport()
        if (!mounted.current || cancelled.current) return
        if (!result) { close(); return }
        previewRef.current = result; setPreview(result)
      } catch (cause) { if (mounted.current && !cancelled.current) setError(portableErrorMessage(cause)) }
      finally { working.current = false; if (mounted.current) setBusy(false) }
    })()
  }, [mode, close])
  useEffect(() => {
    if (!busy) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const update = async () => {
      try {
        const value = await window.grok?.backup?.status()
        if (active && value) { progressRef.current = value; setProgress(value); setStatusError('') }
      } catch { if (active) setStatusError('暂时无法读取进度，操作仍在进行；请等待操作结果。') }
      if (active) timer = setTimeout(() => void update(), 250)
    }
    void update()
    return () => { active = false; clearTimeout(timer) }
  }, [busy])
  const dismiss = async () => {
    if (closing.current || (working.current && !progressRef.current.cancellable)) return
    closing.current = true; setCancelling(true); setError('')
    try { await cancelPortableBackup(previewRef.current?.token); cancelled.current = true; if (mounted.current) close() }
    catch (cause) { closing.current = false; if (mounted.current) { setError(portableErrorMessage(cause)); setCancelling(false) } }
  }
  const submit = async () => {
    if (working.current || cancelling || (mode !== 'export' && !confirmed) || (preview?.warnings.length && !allowIncomplete)) return
    if (mode !== 'rollback' && !preview) return
    working.current = true; setBusy(true); setError(''); setStatusError('')
    const initial: PortableProgress = { phase: mode === 'export' ? 'writing' : 'preparing', done: 0, total: 0, cancellable: true }
    progressRef.current = initial; setProgress(initial)
    try {
      if (mode === 'export') {
        const saved = await writePortableExport(preview!.token, allowIncomplete)
        if (!mounted.current || cancelled.current) return
        if (!saved) { close(); return }
        completed(`便携备份已保存为“${saved.name}”。${preview!.warnings.length ? `有 ${preview!.warnings.length} 项文件未包含，请保留原文件。` : ''}`)
      } else {
        if (mode === 'rollback') await rollbackPortableBackup()
        else await restorePortableBackup(preview!.token, allowIncomplete)
        if (!mounted.current || cancelled.current) return
        completed(mode === 'rollback' ? '已回退并保存替换前的工作区。' :
          `便携备份已恢复并保存。提醒通知已暂停，可在助手“承诺与提醒”中恢复通知。${preview!.warnings.length ? `有 ${preview!.warnings.length} 项文件缺失，请按预览清单补齐。` : ''}`)
      }
    } catch (cause) {
      if (mounted.current && !cancelled.current) { setError(portableErrorMessage(cause)); setPreview(null); previewRef.current = null; setConfirmed(false) }
    } finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  const progressValue = portableProgressValue(progress)
  const canCancel = !busy || progress.cancellable
  const warnings = preview?.warnings || [], pages = Math.ceil(warnings.length / 100)
  return <WorkspaceDialog title={portableTitles[mode]} close={() => void dismiss()} closeDisabled={!canCancel || cancelling} className="portable-backup-dialog" wide>
    <div className="portable-backup-body" aria-busy={busy || cancelling}>
      {busy || cancelling ? <div className="portable-backup-progress" role="status" aria-live="polite">
        <strong>{cancelling ? '正在取消，请稍候…' : portableProgressLabel(progress.phase)}</strong>
        <progress aria-label="便携备份操作进度" {...progressValue} />
        {progressValue && <span>{progressValue.value.toLocaleString()} / {progressValue.max.toLocaleString()}</span>}
        <p>{canCancel ? '提交前可以取消，取消不会替换当前工作区。' : '正在完成提交，暂不能取消或关闭；请等待保存结果。'}</p>
        {statusError && <p>{statusError}</p>}
      </div> : <>
        {preview && <>
          <h3 className="portable-backup-name">{preview.name}</h3>
          <p className="portable-backup-meta">备份时间：{Number.isFinite(Date.parse(preview.createdAt)) ? new Date(preview.createdAt).toLocaleString() : '未知'}</p>
          <dl className="portable-backup-counts">{portableCountRows(preview.counts).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {warnings.length > 0 && <section className="portable-backup-warnings" aria-label="未包含的文件">
            <h3>{warnings.length} 项文件未包含</h3>
            <p>缺失或无法读取的文件不会被补全。保留的消息和文件引用不代表原文件已恢复。</p>
            <ul>{warnings.slice(warningPage * 100, (warningPage + 1) * 100).map((warning, index) => <li key={`${warningPage}-${index}`}><strong>{warning.name}</strong><span>{warning.reason}</span></li>)}</ul>
            {pages > 1 && <div className="portable-warning-pages"><button className="ws-button" disabled={warningPage === 0} onClick={() => setWarningPage((page) => page - 1)}>上一页</button>
              <span>第 {warningPage + 1} / {pages} 页</span><button className="ws-button" disabled={warningPage + 1 === pages} onClick={() => setWarningPage((page) => page + 1)}>下一页</button></div>}
            <label><input type="checkbox" checked={allowIncomplete} onChange={(event) => setAllowIncomplete(event.target.checked)} />我已了解缺失文件，仍继续{mode === 'export' ? '导出' : '恢复'}</label>
          </section>}
        </>}
        {(preview || mode === 'rollback') && <div className="portable-backup-boundary">
          {mode === 'rollback' ? <p>将用最近一次替换前的完整回退点替换当前工作区及助手资料，之后的编辑将不再显示。回退点保存在本机，关闭应用不会清除；普通编辑不会更新它。</p> : <>
            <p>包含工作区、助手身份、记忆、提醒及可读取的引用附件和图片。不含账号凭据，也不会自动打包项目源码；消息中保存的敏感内容仍会保留，请妥善保管备份。</p>
            {mode === 'import' && <p>恢复后使用新的托管目录，项目目录仅含备份中的引用文件。原项目代码需自行复制入新目录；不会重新授权访问旧目录。</p>}
          </>}
          {mode !== 'export' && <>
            <p>所有执行保持停止，工具权限恢复为逐次询问，不会自动发出模型请求。{mode === 'import' ? '导入的提醒通知默认暂停，需要在助手面板手动恢复。' : '提醒通知按回退点中保存的状态恢复。'}</p>
            {mode === 'import' && <p>提交前会保留当前工作区与助手资料的持久回退点，只保留最近一次替换前的状态。</p>}
            <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{mode === 'rollback' ? '我确认回退并替换当前工作区及助手资料' : '我确认用此备份替换工作区及助手资料'}</label>
          </>}
        </div>}
      </>}
      {error && <p className="ws-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" className="ws-button" disabled={!canCancel || cancelling} onClick={() => void dismiss()}>{busy ? '取消操作' : '关闭'}</button>
      {!busy && (preview || mode === 'rollback') && <button type="button" className="ws-button accent"
        disabled={cancelling || (mode !== 'export' && !confirmed) || (!!warnings.length && !allowIncomplete)} onClick={() => void submit()}>
        {mode === 'export' ? '选择位置并导出 ZIP' : mode === 'rollback' ? '确认回退' : '确认替换并恢复便携备份'}
      </button>}
    </footer>
  </WorkspaceDialog>
}
