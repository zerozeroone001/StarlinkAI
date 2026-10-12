import { Check, ChevronRight, CircleAlert, FileText, Terminal, X } from 'lucide-react'
import type { RunPermissionRecord, RunSnapshot, WorkReceipt } from '@shared/runtime'
import type { TeamMessage } from '@/lib/collaboration-data'
import { permissionDisplay, permissionOptionLabel } from '@/lib/permission-display'
import { PermissionMessage } from './PermissionMessage'
import './execution-details.css'

export function ExecutionDetails({ tools, receipt, runs, onAnswer }: {
  tools: TeamMessage[]
  receipt?: WorkReceipt
  runs: Record<string, RunSnapshot>
  onAnswer: (runId: string, permissionId: string, optionId: string) => Promise<void>
}) {
  const pending = (message: TeamMessage) => message.toolPermission?.status === 'pending' && !!message.runId &&
    ['running', 'queued', 'needs_permission'].includes(runs[message.runId]?.status) &&
    !!runs[message.runId]?.permissions.some((item) => item.id === message.toolPermission?.id && item.employeeId === message.author &&
      (!(item as RunPermissionRecord).replyId || !message.toolPermission.replyId || (item as RunPermissionRecord).replyId === message.toolPermission.replyId))
  const awaiting = tools.filter(pending)
  const history = tools.filter((message) => !pending(message))
  const commands = receipt?.commands || []
  const files = [...new Set(receipt?.filesModified || [])]
  const failed = commands.filter((command) => command.exitCode !== undefined && command.exitCode !== 0)
  const declined = history.filter((message) => message.toolPermission?.status === 'answered' &&
    permissionOptionLabel({ id: message.toolPermission.optionId || '', label: message.toolPermission.optionLabel || '' }) === '拒绝本次')
  if (!tools.length && !commands.length && !files.length) return null
  return <div className="execution-details">
    {awaiting.map((message) => <PermissionMessage key={message.id} permission={message.toolPermission!} pending
      onAnswer={(optionId) => onAnswer(message.runId!, message.toolPermission!.id, optionId)} />)}
    {!!(history.length || commands.length || files.length) && <details className="execution-history">
      <summary>
        <ChevronRight size={14} className="execution-chevron" />
        <span>执行过程</span>
        {!!history.length && <span>{history.length} 项工具审批</span>}
        {!!files.length && <span>修改 {files.length} 个文件</span>}
        {!!commands.length && <span>{commands.length} 条命令</span>}
        {!!failed.length && <span className="execution-warning"><CircleAlert size={12} />{failed.length} 条命令失败</span>}
        {!!declined.length && <span className="execution-warning">{declined.length} 项已拒绝</span>}
      </summary>
      <div className="execution-history-content">
        {history.map((message) => {
          const permission = message.toolPermission!
          const display = permissionDisplay(permission)
          const answer = permission.status === 'answered'
            ? permissionOptionLabel({ id: permission.optionId || '', label: permission.optionLabel || '' }) : '已取消'
          const allowed = answer === '允许本次'
          return <details className="execution-tool" key={message.id}>
            <summary>
              {allowed ? <Check size={13} /> : <X size={13} />}
              <span>{display.action}{display.path || display.url || display.command ? ' · ' : ''}
                <code>{display.path || display.url || display.command || display.title}</code></span>
              <span className="execution-tool-state">{allowed ? '已允许' : answer === '拒绝本次' ? '已拒绝' : answer}</span>
            </summary>
            <div className="execution-tool-raw"><p>{display.title}</p><pre>{permission.detail}</pre></div>
          </details>
        })}
        {files.map((file) => <div className="execution-file" key={file}><FileText size={13} /><code>{file}</code></div>)}
        {commands.map((command, index) => <details className={`execution-tool${command.exitCode !== undefined && command.exitCode !== 0 ? ' execution-command-failed' : ''}`} key={index}>
          <summary><Terminal size={13} /><code>{command.command}</code>
            {command.exitCode !== undefined && <span className="execution-tool-state">退出码 {command.exitCode}</span>}</summary>
          <pre>{command.summary || command.command}</pre>
        </details>)}
      </div>
    </details>}
  </div>
}
