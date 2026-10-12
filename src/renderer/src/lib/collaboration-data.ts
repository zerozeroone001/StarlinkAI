import { isAvatar, isWorkspaceAttachment, MAX_ATTACHMENTS, type WorkspaceAttachment } from '../../../shared/attachments.ts'
import { isAbsoluteDirectory } from '../../../shared/project-directory.ts'
import type { PermissionMode } from '../../../shared/types.ts'

export type Provider = 'claude' | 'codex' | 'grok' | 'gemini'
export type TaskState = 'ready' | 'working' | 'review' | 'done'
export type WorkspacePage = 'team' | 'overview' | 'solo' | 'connections' | 'library' | 'gallery'
export interface Member {
  avatar?: string
  model?: string
  effort?: string
  id: string
  name: string
  provider: Provider
  role: string
  persona: string
  personaSource?: string
  isLead: boolean
}
export interface TeamTask {
  dependencyError?: string
  managedRunId?: string
  managedStatus?: import('@shared/runtime').DelegatedTask['status']
  managedDependencies?: string[]
  reviewNote?: string
  resultRunId?: string
  acceptedRunId?: string
  id: string
  title: string
  description: string
  owner: string
  state: TaskState
  dependency: string | null
  acceptance: string
}
export interface TeamArtifact {
  id: string
  name: string
  description: string
  owner: string
  version: number
  content: string
  format: 'md' | 'txt' | 'json' | 'csv'
  sample: boolean
}
export interface TeamMessage {
  interaction?: 'conversation'
  private?: boolean
  toolPermission?: import('@shared/runtime').RunPermissionRecord
  authorName?: string
  provider?: Provider
  attachments?: WorkspaceAttachment[]
  sessionId?: string
  images?: import('@shared/types').ChatImage[]
  cwd?: string
  sourceMessageId?: string
  taskId?: string
  runId?: string
  runtimeReplyId?: string
  status?: import('@shared/runtime').RunStatus
  model?: string
  effort?: string
  error?: string
  id: string
  author: string
  text: string
  time: string
  to: string
  kind: 'message' | 'handoff' | 'decision'
  sample: boolean
  artifactId?: string
  receipt?: import('@shared/runtime').WorkReceipt
}
export interface Team {
  permissionMode?: PermissionMode
  directory?: string
  gallery?: { prompt: string; ratio: string; count: number; createdAt: string }
  deletedMessageIds?: string[]
  id: string
  kind: 'conversation' | 'project'
  parentId: string | null
  defaultProvider: Provider
  name: string
  goal: string
  sample: boolean
  paused: boolean
  members: Member[]
  tasks: TeamTask[]
  messages: TeamMessage[]
  artifacts: TeamArtifact[]
}
export const PROVIDERS: Record<
  Provider,
  { name: string; letter: string; tone: string; description: string; cli: string }
> = {
  claude: {
    name: 'Claude',
    letter: '✳',
    tone: 'clay',
    description: 'Claude Code / Agent SDK',
    cli: 'claude'
  },
  codex: { name: 'GPT', letter: '◈', tone: 'sage', description: 'Codex App Server', cli: 'codex' },
  grok: { name: 'Grok', letter: '𝕏', tone: 'stone', description: 'Grok CLI / ACP', cli: 'grok' },
  gemini: { name: 'Gemini', letter: '✦', tone: 'blue', description: 'Gemini CLI', cli: 'gemini' }
}
export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[]
export const TASK_STATES: Record<TaskState, { label: string; color: string }> = {
  ready: { label: '待开始', color: 'muted' },
  working: { label: '进行中', color: 'blue' },
  review: { label: '待评审', color: 'amber' },
  done: { label: '已完成', color: 'sage' }
}
export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export function hasDependencyCycle(
  tasks: TeamTask[],
  id: string,
  dependency: string | null,
  managedDependencies = tasks.find((task) => task.id === id)?.managedDependencies
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (current: string): boolean => {
    if (visiting.has(current)) return true
    if (visited.has(current)) return false
    visiting.add(current)
    const task = byId.get(current)
    const dependencies = current === id
      ? taskDependencies({ dependency, managedDependencies })
      : task ? taskDependencies(task) : []
    if (dependencies.some(visit)) return true
    visiting.delete(current)
    visited.add(current)
    return false
  }
  return visit(id)
}

export function taskDependencies(task: Pick<TeamTask, 'dependency' | 'managedDependencies'>): string[] {
  return [...new Set([...(task.managedDependencies || []), ...(task.dependency ? [task.dependency] : [])])]
}

export function recoverTaskGraph(team: Team): Team {
  const issues = new Map<string, string>()
  for (const task of team.tasks) {
    const missing = taskDependencies(task).filter((id) => !team.tasks.some((item) => item.id === id))
    if (missing.length) issues.set(task.id, `前置任务不存在：${missing.join('、')}`)
    else if (hasDependencyCycle(team.tasks, task.id, task.dependency)) issues.set(task.id, '前置任务形成循环')
  }
  if (!issues.size) return team
  // Accepted descendants also depend on the damaged graph and need a fresh review.
  for (let changed = true; changed;) {
    changed = false
    for (const task of team.tasks) if (!issues.has(task.id) && taskDependencies(task).some((id) => issues.has(id))) {
      issues.set(task.id, '前置任务的依赖配置需要重新确认')
      changed = true
    }
  }
  return { ...team, tasks: team.tasks.map((task) => {
    const reason = issues.get(task.id)
    if (!reason) return task
    const dependencyError = `${reason}。原前置任务：${taskDependencies(task).join('、') || '无'}。请编辑并确认依赖后继续。`
    return { ...task, dependency: null, managedDependencies: [], state: 'ready', resultRunId: undefined, acceptedRunId: undefined,
      dependencyError, reviewNote: [task.reviewNote, dependencyError].filter(Boolean).join('\n'),
      ...(task.managedRunId ? { managedStatus: 'failed' as const } : {}) }
  }) }
}

export function isValidTeam(value: unknown): value is Team
export function isValidTeam(value: unknown, validateGraph: boolean): value is Team
export function isValidTeam(value: unknown, validateGraph = true): value is Team {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)
  const provider = (v: unknown): v is Provider =>
    typeof v === 'string' && PROVIDER_IDS.includes(v as Provider)
  const strings = (v: Record<string, unknown>, keys: string[]) =>
    keys.every((k) => typeof v[k] === 'string')
  if (
    !record(value) ||
    !strings(value, ['id', 'name', 'goal']) ||
    !['conversation', 'project'].includes(String(value.kind)) ||
    !(value.parentId === null || typeof value.parentId === 'string') ||
    !provider(value.defaultProvider) ||
    typeof value.sample !== 'boolean' ||
    typeof value.paused !== 'boolean'
  )
    return false
  if (value.gallery !== undefined && (!record(value.gallery) || !strings(value.gallery, ['prompt', 'ratio', 'createdAt']) || ![1, 2, 4].includes(Number(value.gallery.count)))) return false
  if (value.directory !== undefined && !isAbsoluteDirectory(value.directory)) return false
  if (value.permissionMode !== undefined && (typeof value.permissionMode !== 'string' || !['ask', 'review', 'auto'].includes(value.permissionMode))) return false
  if (value.deletedMessageIds !== undefined && (!Array.isArray(value.deletedMessageIds) || !value.deletedMessageIds.every((id) => typeof id === 'string'))) return false
  if (
    !Array.isArray(value.members) ||
    !value.members.length ||
    !value.members.every(
      (m) =>
        record(m) &&
        strings(m, ['id', 'name', 'role', 'persona']) &&
        !!m.id &&
        !!String(m.name).trim() &&
        !['you', 'system', 'all'].includes(String(m.id)) &&
        provider(m.provider) &&
        (m.model === undefined || typeof m.model === 'string') &&
        (m.effort === undefined || typeof m.effort === 'string') &&
        (m.avatar === undefined || isAvatar(m.avatar)) &&
        typeof m.isLead === 'boolean' &&
        (m.personaSource === undefined || typeof m.personaSource === 'string')
    )
  )
    return false
  const memberIds = value.members.map((m) => m.id)
  if (new Set(memberIds).size !== memberIds.length) return false
  if (value.members.filter((m) => m.isLead).length !== 1) return false
  if (value.members.find((m) => m.isLead)?.provider !== value.defaultProvider) return false
  if (
    !Array.isArray(value.tasks) ||
    !value.tasks.every(
      (t) =>
        record(t) &&
        strings(t, ['id', 'title', 'description', 'acceptance']) &&
        ['resultRunId', 'acceptedRunId'].every((key) => t[key] === undefined || typeof t[key] === 'string') &&
        ['managedRunId', 'reviewNote', 'dependencyError'].every((key) => t[key] === undefined || typeof t[key] === 'string') &&
        (t.managedStatus === undefined || ['ready', 'working', 'review', 'completed', 'failed'].includes(String(t.managedStatus))) &&
        (t.managedDependencies === undefined || (Array.isArray(t.managedDependencies) && t.managedDependencies.every((id) => typeof id === 'string'))) &&
        memberIds.includes(t.owner) &&
        typeof t.state === 'string' &&
        Object.hasOwn(TASK_STATES, t.state) &&
        (t.dependency === null || typeof t.dependency === 'string')
    )
  )
    return false
  const tasks = value.tasks as TeamTask[]
  if (
    new Set(tasks.map((t) => t.id)).size !== tasks.length ||
    (validateGraph !== false && tasks.some(
      (t) =>
        taskDependencies(t).some((id) => !tasks.some((d) => d.id === id)) ||
        hasDependencyCycle(tasks, t.id, t.dependency)
    ))
  )
    return false
  if (
    !Array.isArray(value.messages) ||
    !value.messages.every(
      (m) =>
        record(m) &&
        strings(m, ['id', 'text', 'time']) &&
        (m.authorName === undefined || typeof m.authorName === 'string') &&
        (m.interaction === undefined || m.interaction === 'conversation') &&
        (m.private === undefined || typeof m.private === 'boolean') &&
        (m.provider === undefined || provider(m.provider)) &&
        (m.toolPermission === undefined || (record(m.toolPermission) && strings(m.toolPermission, ['id', 'employeeId', 'title', 'detail', 'createdAt']) &&
          ['pending', 'answered', 'cancelled'].includes(String(m.toolPermission.status)) && Array.isArray(m.toolPermission.options) &&
          m.toolPermission.options.every((option) => record(option) && strings(option, ['id', 'label'])))) &&
        (m.attachments === undefined || (Array.isArray(m.attachments) && m.attachments.length <= MAX_ATTACHMENTS && m.attachments.every(isWorkspaceAttachment))) &&
        (m.author === 'you' || m.author === 'system' || memberIds.includes(m.author)) &&
        (m.to === 'all' || memberIds.includes(m.to)) &&
        ['message', 'handoff', 'decision'].includes(String(m.kind)) &&
        typeof m.sample === 'boolean' &&
        ['runId', 'runtimeReplyId', 'model', 'effort', 'error', 'taskId', 'cwd', 'sessionId', 'sourceMessageId'].every(key => m[key] === undefined || typeof m[key] === 'string') &&
        (m.images === undefined || (Array.isArray(m.images) && m.images.every((image) => record(image) && ['path', 'dataUrl', 'alt', 'sourcePath'].every((key) => image[key] === undefined || typeof image[key] === 'string')))) &&
        (m.status === undefined || ['queued','running','needs_permission','completed','failed','cancelled'].includes(String(m.status))) &&
        (m.artifactId === undefined || typeof m.artifactId === 'string')
    )
  )
    return false
  if (
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(
      (a) =>
        record(a) &&
        strings(a, ['id', 'name', 'description', 'content']) &&
        (a.owner === 'you' || memberIds.includes(a.owner)) &&
        ['md', 'txt', 'json', 'csv'].includes(String(a.format)) &&
        typeof a.sample === 'boolean' &&
        Number.isInteger(a.version) &&
        Number(a.version) > 0
    )
  )
    return false
  return true
}
// A workspace owns its employees; provider identity is never used as employee identity.
export function createWorkspace(
  kind: Team['kind'],
  provider: Provider,
  name = '',
  goal = '',
  parent?: Team,
  directory?: string
): Team {
  const lead: Member = {
    id: makeId('employee'),
    name: '主 agent',
    provider,
    role: '作为管家理解需求，按员工职责分配工作，跟进执行、检查结果并安排返工，完成后向你汇总交付。',
    persona: '',
    isLead: true
  }
  return {
    id: makeId(kind),
    kind,
    parentId: parent?.id || null,
    directory: parent?.directory || directory,
    permissionMode: kind === 'conversation' && parent?.kind === 'project' ? parent.permissionMode ?? 'ask' : 'ask',
    name: name.trim() || (kind === 'project' ? '新项目' : '新对话'),
    goal: goal.trim(),
    defaultProvider: parent?.defaultProvider || provider,
    members: parent ? parent.members.map((m) => ({ ...m, id: makeId('employee') })) : [lead],
    sample: false,
    paused: false,
    tasks: [],
    messages: [],
    artifacts: []
  }
}

export function seedTeams(): Team[] {
  return [createWorkspace('conversation', 'grok')]
}

export function teamDirectory(teams: Team[], id: string): string | undefined {
  const team = teams.find((t) => t.id === id)
  const parent = teams.find((t) => t.id === team?.parentId && t.kind === 'project')
  return parent?.directory || team?.directory
}

export function employeeReferenced(workspace: Team, id: string): boolean {
  return (
    workspace.tasks.some((t) => t.owner === id) ||
    workspace.messages.some((m) => m.author === id || m.to === id) ||
    workspace.artifacts.some((a) => a.owner === id)
  )
}

export function parsePersonaFile(name: string, content: string): string {
  if (new TextEncoder().encode(content).length > 128 * 1024)
    throw new Error('人格文件不能超过 128 KB。')
  if (!/\.(md|txt|json)$/i.test(name)) throw new Error('支持 Markdown、TXT 或 JSON 文件。')
  let text = content.replace(/^\uFEFF/, '').trim()
  if (/\.json$/i.test(name)) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('JSON 格式无效，请检查文件内容。')
    }
    if (typeof value === 'string') text = value.trim()
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const labels: Record<string, string> = {
        persona: '人格',
        character: '参考角色',
        behavior: '行为方式',
        tone: '语气',
        boundaries: '边界'
      }
      const record = value as Record<string, unknown>
      const entries = Object.keys(labels).filter((key) => record[key] !== undefined)
      if (entries.some((key) => typeof record[key] !== 'string'))
        throw new Error('人格字段必须是文本：persona、character、behavior、tone、boundaries。')
      text = entries
        .filter((key) => String(record[key]).trim())
        .map((key) => `${labels[key]}：${record[key]}`)
        .join('\n\n')
    } else text = ''
  }
  if (!text) throw new Error('文件中没有可导入的人格描述。')
  if (text.length > 20000) throw new Error('人格描述最多 20,000 字，请精简后导入。')
  return text
}

// Read v1 snapshots defensively before translating provider-based ownership to employee IDs.
export function migrateLegacyTeam(value: unknown): Team | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const old = value as Record<string, unknown>
  if (!Array.isArray(old.members) || !old.members.length) return null
  const members: Member[] = []
  const ids = new Map<string, string>()
  for (const raw of old.members) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !PROVIDER_IDS.includes(raw.id) ||
      ids.has(raw.id) ||
      typeof raw.name !== 'string' ||
      typeof raw.role !== 'string'
    )
      return null
    const id = `${String(old.id)}:employee:${raw.id}`
    ids.set(raw.id, id)
    members.push({
      id,
      name: raw.name,
      provider: raw.id,
      role: raw.role,
      persona: '',
      isLead: members.length === 0
    })
  }
  if (
    ![old.tasks, old.messages, old.artifacts].every(
      (items) => Array.isArray(items) && items.every((item) => item && typeof item === 'object')
    )
  )
    return null
  const mapped = {
    ...old,
    kind: 'conversation',
    parentId: null,
    defaultProvider: members[0].provider,
    members,
    tasks: (old.tasks as Record<string, unknown>[]).map((t) => ({
      ...t,
      owner: ids.get(String(t.owner)) || t.owner
    })),
    messages: (old.messages as Record<string, unknown>[]).map((m) => ({
      ...m,
      author: ids.get(String(m.author)) || m.author,
      to: ids.get(String(m.to)) || m.to
    })),
    artifacts: (old.artifacts as Record<string, unknown>[]).map((a) => ({
      ...a,
      owner: ids.get(String(a.owner)) || a.owner
    }))
  }
  return isValidTeam(mapped) ? mapped : null
}
