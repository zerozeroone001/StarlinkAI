import type {
  ProviderDiagnostic,
  ProviderId,
  UsageSnapshot,
  SkillInfo,
  SkillScope,
  CreateSkillResult
} from './types'
import type { ChatImage, FilePreview } from './types'

export interface ModelChoice {
  model?: string
  effort?: string
}
export interface RuntimeModel {
  id: string
  name: string
  description?: string
  resolvedModel?: string
  efforts: string[]
  defaultEffort?: string
  isDefault?: boolean
}
export interface RuntimeProvider extends ProviderDiagnostic {
  models: RuntimeModel[]
  usage: UsageSnapshot | null
  error?: string
  authSource?: string
  loginCommand: string
}
export interface RuntimeEmployee extends ModelChoice {
  id: string
  name: string
  provider: ProviderId
  role: string
  persona: string
}
export interface ContextRecord {
  id?: string
  runId?: string
  replyId?: string
  authorId?: string
  provider?: ProviderId
  author: string
  text: string
  kind?: 'message' | 'handoff' | 'decision'
  status?: RunStatus
  taskId?: string
  compressed?: boolean
}
export interface ContextReport {
  messages: number
  included: number
  compressed: number
  omitted: number
  artifactsOmitted: number
  inputCharacters?: number
  estimatedTokens?: number
  archivePath?: string
}
export interface RuntimeTask {
  id: string
  title: string
  description: string
  owner: string
  acceptance: string
  dependency: { id: string; state: string } | null
  dependencies?: { id: string; state: string; acceptedRunId?: string }[]
  review?: string
}
export interface RunRequest {
  permissionMode?: import('./types').PermissionMode
  assistantScopeId?: string
  assetScopeId?: string
  interaction?: 'conversation'
  privateContext?: ContextRecord[]
  coordination?: { leadId: string; previousTasks?: DelegatedTask[] }
  directory?: string
  queue?: boolean
  task?: RuntimeTask
  attachments?: import('./attachments').WorkspaceAttachment[]
  contextTrimmed?: boolean
  id: string
  workspaceId: string
  goal: string
  prompt: string
  employees: RuntimeEmployee[]
  context: ContextRecord[]
  artifacts: { name: string; content: string }[]
}
export type RunStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
export interface WorkReceipt {
  filesRead?: string[]
  filesModified?: string[]
  commands?: { command: string; exitCode?: number; summary?: string }[]
  gitChanges?: string[]
}
export interface SharedArtifactUpdate {
  name: string
  description: string
  owner: string
  format: 'md' | 'txt' | 'json' | 'csv'
  content: string
}
export interface RecruitedEmployee extends RuntimeEmployee {
  isLead?: boolean
}
export interface RunReply {
  id?: string
  taskId?: string
  kind?: 'message' | 'handoff' | 'decision'
  employeeName?: string
  sessionId?: string
  images?: ChatImage[]
  cwd?: string
  receipt?: WorkReceipt
  employeeId: string
  provider: ProviderId
  model: string
  effort?: string
  text: string
  status: RunStatus
  error?: string
}
export interface RunPermission {
  id: string
  employeeId: string
  title: string
  detail: string
  options: { id: string; label: string }[]
}
export interface RunPermissionRecord extends RunPermission {
  replyId?: string
  createdAt: string
  resolvedAt?: string
  status: 'pending' | 'answered' | 'cancelled'
  optionId?: string
  optionLabel?: string
}
export interface RunMetrics {
  modelCalls: number
  leadCalls: number
  workerCalls: number
  leadExecutionMs: number
  workerExecutionMs: number
  permissionWaitMs: number
  queueWaitMs: number
  contextCharacters: number
  contextEstimatedTokens: number
  archiveWrites: number
  archiveReuses: number
  fileScans: number
}
export interface RunSnapshot {
  permissionMode?: import('./types').PermissionMode
  metrics?: RunMetrics
  assistantScopeId?: string
  interaction?: 'conversation'
  assistantUpdated?: boolean
  permissionHistory?: RunPermissionRecord[]
  sharedArtifacts?: SharedArtifactUpdate[]
  coordination?: {
    leadId: string
    phase: 'planning' | 'executing' | 'reviewing' | 'completed' | 'blocked'
    tasks: DelegatedTask[]
    recruited?: RecruitedEmployee[]
  }
  taskId?: string
  contextReport?: ContextReport
  queuePosition?: number
  finishedAt?: string
  interrupted?: boolean
  revision?: number
  id: string
  workspaceId: string
  status: RunStatus
  replies: RunReply[]
  permissions: RunPermission[]
  createdAt: string
  error?: string
  contextTrimmed: boolean
}
export interface DelegatedTask {
  id: string
  title: string
  description: string
  acceptance: string
  owner: string
  dependencies: string[]
  status: 'ready' | 'working' | 'review' | 'completed' | 'failed'
  attempts: number
  replyId?: string
  review?: string
  error?: string
}
export interface LoginSnapshot {
  provider: ProviderId
  status: 'pending' | 'completed' | 'failed'
  url?: string
  message: string
}
export const RUN_EXPIRED_MESSAGE = '此执行已失效，请保留已有回复后重新发送。'
export interface RuntimeApi {
  assistant(scopeId: string): Promise<import('./assistant').AssistantSnapshot>
  updateAssistant(scopeId: string, patch: import('./assistant').AssistantProfilePatch): Promise<import('./assistant').AssistantSnapshot>
  saveMemory(scopeId: string, input: import('./assistant').AssistantMemoryInput): Promise<import('./assistant').AssistantSnapshot>
  forgetMemory(scopeId: string, memoryId: string): Promise<import('./assistant').AssistantSnapshot>
  saveCommitment(scopeId: string, input: import('./assistant').AssistantCommitmentInput): Promise<import('./assistant').AssistantSnapshot>
  deleteCommitment(scopeId: string, commitmentId: string): Promise<import('./assistant').AssistantSnapshot>
  clearAssistant(scopeId: string): Promise<import('./assistant').AssistantSnapshot>
  prepareDirectory(input: import('./project-directory').ProjectDirectoryInput): Promise<string>
  upload(workspaceId: string, input: { name: string; data: string }, directory?: string): Promise<import('./attachments').WorkspaceAttachment>
  media(workspaceId: string, source: string, directory?: string): Promise<FilePreview>
  skills(workspaceId: string, directory?: string): Promise<SkillInfo[]>
  readSkill(workspaceId: string, path: string, directory?: string): Promise<SkillInfo | null>
  createSkill(
    workspaceId: string,
    input: { name: string; description: string; scope: SkillScope },
    directory?: string
  ): Promise<CreateSkillResult>
  toggleSkill(workspaceId: string, name: string, disabled: boolean, directory?: string): Promise<SkillInfo[]>
  providers(refresh?: boolean, ids?: ProviderId[]): Promise<RuntimeProvider[]>
  start(request: RunRequest): Promise<RunSnapshot>
  run(id: string): Promise<RunSnapshot>
  cancel(id: string): Promise<RunSnapshot>
  permission(id: string, permissionId: string, option: string): Promise<void>
  login(provider: ProviderId): Promise<LoginSnapshot>
  loginStatus(provider: ProviderId): Promise<LoginSnapshot | null>
}
export const EFFORT_LABELS: Record<string, string> = {
  none: '无',
  minimal: '最小',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: '极高（自动委派）'
}
