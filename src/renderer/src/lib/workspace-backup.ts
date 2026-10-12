import type { ModelChoice, WorkReceipt } from '../../../shared/runtime'
import { isWorkspaceAttachment, MAX_ATTACHMENTS, type WorkspaceAttachment } from '../../../shared/attachments'
import { isValidTeam, PROVIDER_IDS, type Provider, type Team } from './collaboration-data'

export const MAX_WORKSPACE_BACKUP_BYTES = 20 * 1024 * 1024
export interface WorkspaceBackupState {
  teams: Team[]
  activeTeamId: string
  drafts: Record<string, string>
  attachmentDrafts: Record<string, WorkspaceAttachment[]>
  defaultProvider: Provider
  modelDefaults: Partial<Record<Provider, ModelChoice>>
  deletedGalleryKeys: string[]
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unsafe = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key)
const validId = (id: string) => !!id && id.length <= 200 && !unsafe(id) && !Object.hasOwn(Object.prototype, id)
const historyRunId = (id?: string) => id ? `restored-history:${id.replace(/^(?:restored-history:)+/, '')}` : undefined
export const isRestoredRunId = (id: string) => id.startsWith('restored-history:')
function validReceipt(value: unknown): value is WorkReceipt {
  return record(value) && ['filesRead', 'filesModified', 'gitChanges'].every((key) =>
    value[key] === undefined || (Array.isArray(value[key]) && value[key].every((item) => typeof item === 'string'))) &&
    (value.commands === undefined || (Array.isArray(value.commands) && value.commands.every((command) =>
      record(command) && typeof command.command === 'string' &&
      (command.summary === undefined || typeof command.summary === 'string') &&
      (command.exitCode === undefined || Number.isInteger(command.exitCode)))))
}

// Explicit field selection excludes other stores (accounts, preferences and the
// independent assistant memory), as well as unknown fields in an imported file.
function fields<T extends object>(source: T, keys: readonly string[]): T {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key as keyof T]])) as T
}
function portableTeam(team: Team, inlineImages = false): Team {
  return {
    ...fields(team, ['id', 'kind', 'parentId', 'directory', 'permissionMode', 'deletedMessageIds', 'defaultProvider', 'name', 'goal', 'sample', 'paused']),
    ...(team.gallery ? { gallery: fields(team.gallery, ['prompt', 'ratio', 'count', 'createdAt']) } : {}),
    members: team.members.map((member) => fields(member, ['id', 'name', 'provider', 'role', 'persona', 'personaSource', 'isLead', 'avatar', 'model', 'effort'])),
    tasks: team.tasks.map((task) => fields(task, ['id', 'title', 'description', 'owner', 'state', 'dependency', 'acceptance', 'managedDependencies', 'reviewNote', 'dependencyError', 'managedRunId', 'managedStatus', 'resultRunId', 'acceptedRunId'])),
    messages: team.messages.map((message) => ({
      ...fields(message, ['id', 'author', 'authorName', 'provider', 'text', 'time', 'to', 'kind', 'sample', 'interaction', 'private', 'sourceMessageId', 'taskId', 'runId', 'runtimeReplyId', 'status', 'model', 'effort', 'error', 'artifactId', 'cwd', 'sessionId']),
      ...(message.attachments ? { attachments: message.attachments.map((file) => fields(file, ['id', 'name', 'path', 'size', 'mime'])) } : {}),
      ...(message.images ? { images: message.images.map((image) => fields(image, ['path', 'sourcePath', 'alt', ...(inlineImages ? ['dataUrl'] : [])])) } : {}),
      ...(message.receipt ? { receipt: {
        ...fields(message.receipt, ['filesRead', 'filesModified', 'gitChanges']),
        ...(message.receipt.commands ? { commands: message.receipt.commands.map((command) => fields(command, ['command', 'exitCode', 'summary'])) } : {})
      } } : {}),
      ...(message.toolPermission ? { toolPermission: {
        ...fields(message.toolPermission, ['id', 'employeeId', 'title', 'detail', 'createdAt', 'resolvedAt', 'status', 'optionId', 'optionLabel', 'replyId']),
        options: message.toolPermission.options.map((option) => fields(option, ['id', 'label']))
      } } : {})
    })),
    artifacts: team.artifacts.map((artifact) => fields(artifact, ['id', 'name', 'description', 'owner', 'version', 'content', 'format', 'sample']))
  }
}
export function createWorkspaceBackup(source: WorkspaceBackupState, maxBytes = MAX_WORKSPACE_BACKUP_BYTES, inlineImages = false): string {
  const snapshot: WorkspaceBackupState = {
    teams: source.teams.map((team) => portableTeam(team, inlineImages)), activeTeamId: source.activeTeamId,
    drafts: { ...source.drafts },
    attachmentDrafts: Object.fromEntries(Object.entries(source.attachmentDrafts).map(([id, files]) =>
      [id, files.map((file) => fields(file, ['id', 'name', 'path', 'size', 'mime']))])),
    defaultProvider: source.defaultProvider,
    modelDefaults: Object.fromEntries(Object.entries(source.modelDefaults).map(([provider, choice]) => [provider, fields(choice!, ['model', 'effort'])])),
    deletedGalleryKeys: [...source.deletedGalleryKeys]
  }
  const text = JSON.stringify({ format: 'workspace-backup', version: 1, createdAt: new Date().toISOString(), state: snapshot }, null, 2)
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`工作区备份超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB，当前备份功能暂不支持此大小。`)
  return text
}

export function parseWorkspaceSnapshot(text: string, maxBytes = MAX_WORKSPACE_BACKUP_BYTES, inlineImages = false): WorkspaceBackupState {
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`备份文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB。`)
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('备份不是有效的 JSON 文件。') }
  let count = 0
  const inspect = (node: unknown, depth: number) => {
    if (++count > 300000 || depth > 30) throw new Error('备份结构过大或层级过深。')
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
      if (unsafe(key)) throw new Error('备份包含不安全的字段。')
      inspect(child, depth + 1)
    }
  }
  inspect(value, 0)
  if (!record(value) || value.format !== 'workspace-backup' || value.version !== 1 || !record(value.state))
    throw new Error('不支持此备份格式或版本。')
  const state = value.state
  if (!Array.isArray(state.teams) || !state.teams.length || state.teams.length > 500 ||
    state.teams.some((team) => !record(team) || !Array.isArray(team.tasks) || team.tasks.length > 500) ||
    !state.teams.every((team) => isValidTeam(team, false))) throw new Error('备份中的项目或会话结构无效。')
  const teams = state.teams as Team[]
  if (teams.some((team) => team.messages.some((message) =>
    (message.receipt !== undefined && !validReceipt(message.receipt)) ||
    (message.toolPermission && ['optionId', 'optionLabel', 'replyId', 'resolvedAt'].some((key) => {
      const field = message.toolPermission![key as keyof typeof message.toolPermission]
      return field !== undefined && typeof field !== 'string'
    }))))) throw new Error('备份中的执行记录或审批记录无效。')
  if (new Set(teams.map((team) => team.id)).size !== teams.length || teams.some((team) =>
    !validId(team.id) || !/^[\w-]{1,100}$/.test(team.id) || team.members.some((member) => !validId(member.id)) ||
    team.tasks.some((task) => !validId(task.id)) || team.messages.some((message) => !validId(message.id)) ||
    team.artifacts.some((artifact) => !validId(artifact.id)) || new Set(team.artifacts.map((artifact) => artifact.id)).size !== team.artifacts.length ||
    new Set(team.messages.map((message) => message.id)).size !== team.messages.length ||
    !isValidTeam(team) || (team.parentId !== null &&
      (team.kind !== 'conversation' || !teams.some((parent) => parent.id === team.parentId && parent.kind === 'project')))))
    throw new Error('备份存在重复标识、无效项目关系或任务依赖。')
  const ids = new Set(teams.map((team) => team.id))
  if (typeof state.activeTeamId !== 'string' || !ids.has(state.activeTeamId) ||
    typeof state.defaultProvider !== 'string' || !PROVIDER_IDS.includes(state.defaultProvider as Provider) ||
    !record(state.drafts) || Object.entries(state.drafts).some(([id, draft]) => !ids.has(id) || typeof draft !== 'string') ||
    !record(state.attachmentDrafts) || Object.entries(state.attachmentDrafts).some(([id, files]) =>
      !ids.has(id) || !Array.isArray(files) || files.length > MAX_ATTACHMENTS || !files.every(isWorkspaceAttachment)) ||
    !record(state.modelDefaults) || Object.entries(state.modelDefaults).some(([provider, choice]) =>
      !PROVIDER_IDS.includes(provider as Provider) || !record(choice) ||
      Object.entries(choice).some(([key, item]) => !['model', 'effort'].includes(key) || typeof item !== 'string')) ||
    !Array.isArray(state.deletedGalleryKeys) || !state.deletedGalleryKeys.every((key) => typeof key === 'string'))
    throw new Error('备份中的草稿或设置无效。')
  const safe = JSON.parse(createWorkspaceBackup(state as unknown as WorkspaceBackupState, maxBytes, inlineImages)).state as WorkspaceBackupState
  return safe
}

export function parseWorkspaceBackup(text: string, maxBytes = MAX_WORKSPACE_BACKUP_BYTES, inlineImages = false): WorkspaceBackupState {
  const safe = parseWorkspaceSnapshot(text, maxBytes, inlineImages)
  safe.teams = safe.teams.map((team) => ({ ...team, permissionMode: 'ask',
    tasks: team.tasks.map((task) => ({ ...task, state: task.state === 'working' ? 'ready' : task.state,
      managedRunId: undefined, managedStatus: undefined, resultRunId: historyRunId(task.resultRunId), acceptedRunId: historyRunId(task.acceptedRunId) })),
    messages: team.messages.map((message) => ({ ...message,
      status: message.status && ['queued', 'running', 'needs_permission'].includes(message.status) ? 'cancelled' : message.status,
      runId: historyRunId(message.runId), sessionId: undefined,
      ...(message.toolPermission ? { toolPermission: { ...message.toolPermission,
        status: message.toolPermission.status === 'pending' ? 'cancelled' : message.toolPermission.status } } : {})
    }))
  }))
  return safe
}

export function downloadWorkspaceBackup(text: string, prefix = 'workspace-backup'): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
