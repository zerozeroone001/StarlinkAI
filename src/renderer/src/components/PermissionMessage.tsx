import { useState } from 'react'
import { Check, FileText, ShieldCheck, X } from 'lucide-react'
import type { RunPermissionRecord } from '@shared/runtime'
import { permissionDisplay, permissionOptionLabel } from '@/lib/permission-display'

export function PermissionMessage({ permission, pending, onAnswer }: {
  permission: RunPermissionRecord
  pending: boolean
  onAnswer: (optionId: string) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const display = permissionDisplay(permission)
  const answer = permission.optionId ? permissionOptionLabel({ id: permission.optionId, label: permission.optionLabel || permission.optionId }) : ''
  const choose = async (id: string) => {
    if (submitting || !pending) return
    setSubmitting(true); setError('')
    try { await onAnswer(id) }
    catch (error) { setError(error instanceof Error ? error.message : '确认失败，请重试。') }
    finally { setSubmitting(false) }
  }
  return <section className={`permission-message${pending ? ' is-pending' : ''}`} aria-label={pending ? '工具操作等待确认' : '工具操作记录'}>
    <div className="permission-message-heading">
      {display.path ? <FileText size={16} /> : <ShieldCheck size={16} />}
      <strong>{display.action}</strong>
      <span className="permission-message-state">
        {pending ? '等待你确认' : permission.status === 'answered' ? <>{answer === '拒绝本次' ? <X size={13} /> : <Check size={13} />}{answer}</> : <><X size={13} />确认已取消</>}
      </span>
    </div>
    {display.path && <code className="permission-message-path">{display.path}</code>}
    {display.url && <code className="permission-message-path">{display.url}</code>}
    {display.command && <code className="permission-message-command">{display.command.length > 180 ? display.command.slice(0, 180) + '…' : display.command}</code>}
    {pending && <p>选择允许后继续执行。</p>}
    {display.content !== undefined && <details className="permission-message-details">
      <summary>查看写入内容</summary>
      <pre>{display.content}</pre>
    </details>}
    <details className="permission-message-details">
      <summary>查看完整操作详情</summary>
      <p>{display.title}</p>
      <pre>{permission.detail}</pre>
    </details>
    {error && <p className="ws-error" role="alert">{error}</p>}
    {pending && <div className="permission-message-actions">
      {permission.options.map((option) => <button type="button" className={`ws-button${permissionOptionLabel(option) === '允许本次' ? ' accent' : ''}`} key={option.id}
        disabled={submitting} onClick={() => void choose(option.id)}>{submitting ? '正在提交…' : permissionOptionLabel(option)}</button>)}
    </div>}
  </section>
}
