import type { RunPermission, RunPermissionRecord } from '@shared/runtime'

export function permissionOptionLabel(option: RunPermission['options'][number]) {
  const value = `${option.id} ${option.label}`
  if (/deny|decline|reject|\bno\b|cancel|拒绝|取消|不同意/i.test(value)) return '拒绝本次'
  if (/allow|accept|approve|\byes\b|允许|同意|批准/i.test(value)) return '允许本次'
  return option.label
}

export function permissionDisplay(permission: RunPermission) {
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(permission.detail)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
  } catch { /* The full original request remains available in the details disclosure. */ }
  const path = [args.file_path, args.filePath, args.path, args.target_file].find((value) => typeof value === 'string') as string | undefined ||
    /['"]([A-Za-z]:[\\/][^'"]+)['"]/.exec(permission.title)?.[1]
  const command = typeof args.command === 'string' ? args.command : undefined
  const tool = `${permission.title} ${typeof args.variant === 'string' ? args.variant : ''} ${typeof args.name === 'string' ? args.name : ''}`
  const url = typeof args.url === 'string' ? args.url : undefined
  const write = /\b(write|edit|apply_patch|fileChange)\b|写入|修改文件/i.test(tool)
  const read = /\b(read|file_read)\b|读取/i.test(tool)
  const fetch = /\b(WebFetch|Fetch|web_fetch)\b/i.test(tool)
  const search = /\b(WebSearch|Search|Grep|Glob)\b|搜索/i.test(tool)
  const action = write ? '写入或修改文件' : read ? '读取文件' : fetch ? '浏览网页' : search ? '搜索资料' : command ? '执行命令' : '执行工具操作'
  const content = typeof args.content === 'string' ? args.content : typeof args.new_string === 'string' ? args.new_string : undefined
  return { action, path, url, command, content, title: permission.title }
}

export function permissionSummary(permission: RunPermissionRecord) {
  const display = permissionDisplay(permission)
  const answer = permission.optionId ? permissionOptionLabel({ id: permission.optionId, label: permission.optionLabel || permission.optionId }) : ''
  const status = permission.status === 'pending' ? '等待确认' : permission.status === 'cancelled' ? '操作确认已取消' : `已选择：${answer}`
  return `${display.action}${display.path ? `：${display.path}` : ''} · ${status}`
}
