export type Theme = 'dark' | 'light'

export type Locale = 'en' | 'zh-CN'

export type RunMode = 'local' | 'worktree'

// Keep the existing `auto` value for full access in saved preferences.
export type PermissionMode = 'ask' | 'review' | 'auto'

export type RightTab = 'review' | 'files' | 'plan' | 'terminal'

export type SettingsTab = 'providers' | 'basics' | 'skills' | 'pets'

export type ProviderId = 'claude' | 'codex' | 'grok' | 'gemini'
export interface ProviderDiagnostic {
  id: ProviderId
  cli: { state: 'installed' | 'not_found' | 'error'; version: string | null; path: string | null }
  auth: AuthInfo | null
  checkedAt: string
}

export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export type ThreadStatus = 'idle' | 'running' | 'needs_input' | 'error'

export interface AuthInfo {
  email: string | null
  name: string | null
  userId: string | null
  signedIn: boolean
}

export type UsageWindowKind = 'weekly' | 'monthly' | 'unknown'

export interface UsageWindow {
  id: string
  label: string
  kind: UsageWindowKind
  usedPercent: number | null
  used: number | null
  limit: number | null
  remaining: number | null
  resetsAt: string | null
  unit?: string
}

export interface UsageSnapshot {
  plan: string | null
  fetchedAt: string
  windows: UsageWindow[]
  error?: string
}

export interface Project {
  id: string
  name: string
  path: string
  branch?: string
  lastActiveAt?: string
}

export interface ThreadMeta {
  id: string
  title: string
  cwd: string
  projectName: string
  updatedAt: string
  createdAt?: string
  model?: string
  effort?: string
  status: ThreadStatus
  pinned?: boolean
  unread?: boolean
  messageCount?: number
}

export interface GitFile {
  path: string
  status: string
  staged: boolean
}

export interface GitState {
  branch: string
  ahead: number
  behind: number
  dirty: boolean
  files: GitFile[]
  diff: string
  missing?: boolean
}

export interface FileNode {
  name: string
  path: string
  dir: boolean
  children?: FileNode[]
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'text' | 'markdown' | 'json' | 'pdf' | 'binary'

export interface FilePreview {
  path: string
  name: string
  ext: string
  size: number
  kind: PreviewKind
  mime: string
  language?: string
  text?: string
  dataUrl?: string
  truncated?: boolean
  error?: string
}

export interface PlanItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: string
}

export interface DiffHunk {
  header: string
  lines: { type: 'ctx' | 'add' | 'del'; text: string }[]
}

export type MessageKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'system'
  | 'plan'
  | 'error'

export interface ChatImage {
  sourcePath?: string
  path?: string
  dataUrl?: string
  alt?: string
}

export interface ToolCallState {
  id: string
  name: string
  kind?: string
  title?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  input?: unknown
  output?: string
  path?: string
  diff?: string
  command?: string
  images?: ChatImage[]
}

export interface ChatMessage {
  id: string
  kind: MessageKind
  text: string
  createdAt: string
  tool?: ToolCallState
  streaming?: boolean
  attachments?: PromptAttachment[]
  images?: ChatImage[]
}

export interface HistoryCursor {
  before: number
  intraOffset?: number
  groupEnd?: number
}

export interface HistoryPage {
  messages: ChatMessage[]
  nextCursor: HistoryCursor | null
  hasMore: boolean
}

export interface PermissionRequest {
  requestId: number | string
  sessionId: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
  }
  options: { optionId: string; name: string; kind?: string }[]
}

export type SkillSource = 'local' | 'repo' | 'user' | 'bundled' | 'compat'

export interface SkillInfo {
  name: string
  description: string
  descriptionZh?: string
  path: string
  dir: string
  source: SkillSource
  userInvocable: boolean
  disabled: boolean
  argumentHint?: string
  body?: string
}

export type SkillScope = 'user' | 'project'

export type CreateSkillError = 'invalid_name' | 'exists' | 'no_project' | 'write_failed'

export type CreateSkillResult =
  | { ok: true; skill: SkillInfo; skills: SkillInfo[] }
  | { ok: false; error: CreateSkillError }

export type PetKind = 'builtin' | 'custom'

export type PetMood = 'idle' | 'running' | 'waiting' | 'review' | 'failed' | 'waving' | 'jumping'

export type PetMotion =
  | 'idle'
  | 'wave'
  | 'jump'
  | 'dance'
  | 'sleep'
  | 'spin'
  | 'cheer'
  | 'run'
  | 'sit'
  | 'shy'

export interface PetRiveConfig {
  file: string
  artboard?: string
  stateMachine: string
  moodInput: string
  motionInput: string
  triggers?: Partial<Record<PetMotion, string>>
}

export interface PetAtlas {
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  /** A single action, read left-to-right then top-to-bottom. Absent for legacy state sheets. */
  frames?: number
  frameDurationMs?: number
  states?: Record<string, { row: number; frames: number }>
}

export interface PetAction {
  id: string
  name: string
  nameZh?: string
  motion?: PetMotion
  file?: string
  mediaType?: 'image' | 'video' | 'sheet'
  atlas?: PetAtlas
  durationMs?: number
  custom?: boolean
  prompt?: string
  /** Previous sprite files are retained when an action is upgraded. */
  history?: Array<{ file: string; atlas: PetAtlas; durationMs: number }>
}

export type PetDefaultAction = 'work' | 'report' | 'rest' | 'play'

export type PetDefaultActions = Partial<Record<PetDefaultAction, string>>

export interface PetInfo {
  id: string
  name: string
  description: string
  kind: PetKind
  atlas?: PetAtlas
  portrait?: boolean
  actions?: PetAction[]
  defaultActions?: PetDefaultActions
  deletable?: boolean
  rive?: boolean
  visualVersion?: number
}

export interface PetDraft {
  id?: string
  name: string
  description?: string
  imagePath?: string | null
  rivePath?: string | null
  defaultActions?: PetDefaultActions
}

export interface PetActionDraft {
  name: string
  motion?: PetMotion
  imagePath?: string | null
  videoPath?: string | null
  spritesheetPath?: string | null
  atlas?: PetAtlas
  durationMs?: number
  prompt?: string
  replaceActionId?: string
  generationJobId?: string
}

export type PetFrameCount = 16 | 32 | 48 | 108

export interface PetSubjectExtractionOptions {
  forceRegenerate?: boolean
}

export interface PetActionGenerationOptions {
  frameCount?: PetFrameCount
  requestId?: string
  sourceActionId?: string
  /** Regenerate an existing action from scratch, keeping its identity when saved. */
  replaceActionId?: string
  resumeJobId?: string
}

export interface PetActionProgress {
  requestId: string
  jobId: string
  petId: string
  prompt: string
  sourceActionId?: string
  replaceActionId?: string
  targetFrames: PetFrameCount
  completedFrames: number
  state: 'running' | 'paused' | 'failed' | 'complete'
  error?: string
  /** Contains only durable, validated frames, in timeline order. */
  media?: PetGeneratedMedia
}

export interface PetVisual {
  type: 'portrait' | 'sheet' | 'video' | 'rive'
  dataUrl: string
  atlas?: PetAtlas
  file?: string
  fallbackDataUrl?: string
  rive?: PetRiveConfig
  frameDurationsMs?: number[]
}

export type PetTransparency = 'native-alpha' | 'local-key' | 'mixed'

export interface PetGeneratedMedia {
  path: string
  dataUrl: string
  mime: string
  motion?: PetMotion
  atlas?: PetAtlas
  durationMs?: number
  jobId?: string
  complete?: boolean
  /** Timeline indices represented by the packed preview cells. Missing slots are not duplicates. */
  frameIndices?: number[]
  frameDurationsMs?: number[]
  /** Measured from the provider output, never inferred from the final PNG extension. */
  transparency?: PetTransparency
}

export interface PetActionEvent {
  id: string
  petId: string
  motion?: PetMotion
  durationMs?: number
  visual?: PetVisual | null
  /** Compatibility with older renderers. */
  dataUrl?: string | null
}

export const DEFAULT_PET_ID = 'ragdoll'

export interface PetLiveStatus {
  mood: PetMood
  title: string
  hint: string
  threadId: string | null
  runningCount: number
  needsInput: boolean
}

export interface PetSnapshot {
  awake: boolean
  petId: string
  pets: PetInfo[]
  theme: Theme
  locale: Locale
  status: PetLiveStatus
}

export interface AppSnapshot {
  desktopStateHealth?: { status: 'new' | 'ready' | 'recovered' | 'partial' | 'damaged'; message?: string; path: string; backupPath: string }
  auth: AuthInfo
  grokPath: string | null
  grokVersion: string | null
  connected: boolean
  theme: Theme
  locale: Locale
  projects: Project[]
  threads: ThreadMeta[]
  model: string
  effort: Effort
  runMode: RunMode
  permissionMode: PermissionMode
  wallpaper: { name: string; opacity: number } | null
  skills: SkillInfo[]
  pet: { awake: boolean; petId: string; pets: PetInfo[] }
}

export interface UiPrefs {
  theme: Theme
  locale: Locale
  permissionMode: PermissionMode
  model?: string
  effort?: Effort
  wallpaperFile: string | null
  wallpaperName: string | null
  wallpaperOpacity: number
  disabledSkills: string[]
  petAwake: boolean
  petId: string
  petX: number | null
  petY: number | null
}

export const BUILTIN_PETS: PetInfo[] = [
  {
    id: 'ragdoll',
    name: '布偶猫',
    description: '会陪着长任务发呆的蓝重点布偶猫。',
    kind: 'builtin',
    portrait: true
  },
  {
    id: 'shiba',
    name: '柴犬',
    description: 'StarlinkAI 开工就会竖起耳朵的柴犬。',
    kind: 'builtin',
    portrait: true
  },
  {
    id: 'imp',
    name: '小恶魔',
    description: '会为合并欢呼、也会吐槽失败的小恶魔。',
    kind: 'builtin',
    portrait: true
  },
  {
    id: 'elf',
    name: '精灵',
    description: '审查 diff 时守着你的森林精灵。',
    kind: 'builtin',
    portrait: true
  },
  {
    id: 'xiaomei',
    name: '小美',
    description: '会为每一条绿灯测试加油的中国小女孩。',
    kind: 'builtin',
    portrait: true
  },
  {
    id: 'secretary',
    name: '秘书',
    description: '把桌面收拾得井井有条的时尚秘书。',
    kind: 'builtin',
    portrait: true
  }
]

export const LEGACY_PET_IDS: Record<string, string> = {
  spark: 'ragdoll',
  nova: 'shiba',
  comet: 'imp',
  byte: 'elf',
  echo: 'xiaomei',
  pebble: 'secretary'
}

export const DEFAULT_PET_ATLAS: PetAtlas = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208
}

export const PET_STATE_ROWS: Record<string, number> = {
  idle: 0,
  'running-right': 1,
  'running-left': 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8
}

export const PET_STATE_FRAMES: Record<string, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6
}

export interface PromptAttachment {
  path: string
  name: string
  mime?: string
  dataUrl?: string
}

export const MODELS = [
  { id: 'grok-4.6', label: 'Grok 4.6', hint: 'Best coding' },
  { id: 'grok-4.5', label: 'Grok 4.5', hint: 'Balanced' },
  { id: 'grok-4.3', label: 'Grok 4.3', hint: 'Fast' },
  { id: 'grok-build', label: 'Grok Build', hint: 'Agent default' }
] as const

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
]
