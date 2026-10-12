import { ChevronDown, Gauge } from 'lucide-react'
import type { RunSnapshot } from '@shared/runtime'
import './run-metrics.css'

export function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`
  const seconds = Math.round(value / 1000)
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function count(value: number): string {
  return Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString('zh-CN') : '-'
}

export function RunMetricsPanel({ run }: { run: RunSnapshot }) {
  const metrics = run.metrics
  if (!metrics) return null
  const items = [
    ['主助手调用', `${count(metrics.leadCalls)} 次`],
    ['员工调用', `${count(metrics.workerCalls)} 次`],
    ['主助手执行', formatDuration(metrics.leadExecutionMs)],
    ['员工执行（累计）', formatDuration(metrics.workerExecutionMs)],
    ['等待确认（累计）', formatDuration(metrics.permissionWaitMs)],
    ['排队等待', formatDuration(metrics.queueWaitMs)],
    ['输入字符（累计）', count(metrics.contextCharacters)],
    ['输入 token 估算（累计）', count(metrics.contextEstimatedTokens)],
    ['存档写入 / 复用', `${count(metrics.archiveWrites)} / ${count(metrics.archiveReuses)}`],
    ['目录扫描', `${count(metrics.fileScans)} 次`]
  ]
  return <details className="run-metrics">
    <summary aria-label="执行统计">
      <Gauge size={14} aria-hidden="true" />
      <span>执行统计</span>
      <span className="run-metrics-summary">{count(metrics.modelCalls)} 次调用 · 累计 {formatDuration(metrics.leadExecutionMs + metrics.workerExecutionMs)}</span>
      <ChevronDown size={13} className="run-metrics-chevron" aria-hidden="true" />
    </summary>
    <dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </details>
}
