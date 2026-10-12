import type { PortableCounts, PortableProgress } from '@shared/portable-backup'

export type PortableAction = 'export' | 'import' | 'rollback'
export const portableTitles: Record<PortableAction, string> = {
  export: '导出便携备份', import: '预览并恢复便携备份', rollback: '回退到替换前的工作区'
}
export function portableSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
export function portableCountRows(counts: PortableCounts): Array<[string, string]> {
  return [
    ['项目', String(counts.projects)], ['会话', String(counts.conversations)], ['消息', String(counts.messages)],
    ['草稿', String(counts.drafts)], ['助手资料', String(counts.assistants)], ['记忆', String(counts.memories)],
    ['提醒', String(counts.reminders)], ['附件引用', String(counts.attachments)], ['图片引用', String(counts.images)],
    ['已包含文件', `${counts.files} 个 · ${portableSize(counts.bytes)}`]
  ]
}
export function portableProgressLabel(phase: PortableProgress['phase']): string {
  return { idle: '正在准备…', collecting: '正在收集工作区、助手资料与引用文件…', validating: '正在校验备份内容…',
    preview: '备份预览已准备好', writing: '正在写入备份文件…', preparing: '正在准备恢复文件与回退点…',
    committing: '正在提交并保存工作区…', complete: '正在确认操作结果…', failed: '正在核对操作结果…' }[phase]
}
export function portableErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return '操作未完成，请重试。'
  return cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').split(/\r?\n/)[0].slice(0, 600) || '操作未完成，请重试。'
}
export function portableProgressValue(progress: PortableProgress): { value: number; max: number } | undefined {
  if (!Number.isFinite(progress.total) || progress.total <= 0 || !Number.isFinite(progress.done) || progress.done < 0) return undefined
  return { value: Math.min(progress.done, progress.total), max: progress.total }
}
