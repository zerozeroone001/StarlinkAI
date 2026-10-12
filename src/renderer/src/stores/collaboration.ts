import { create } from 'zustand'
import { createJSONStorage, persist, type StorageValue, type PersistStorage } from 'zustand/middleware'
import type { ModelChoice, RunSnapshot, RunStatus } from '@shared/runtime'
import type { PermissionMode } from '@shared/types'
import { RUN_EXPIRED_MESSAGE } from '@shared/runtime'
import { runtimeClient } from '@/lib/runtime-client'
import { useAssistant } from '@/stores/assistant'
import { useProviders } from '@/stores/providers'
import { getProviderReadiness } from '@/lib/provider-account'
import { collaborationContext, historyForRetry } from '@/lib/collaboration-context'
import { assistantScopeId, separateAssistantContext, isAssistantPrivateMessage, isStopWorkMessage } from '@/lib/assistant-context'
import { permissionSummary } from '@/lib/permission-display'
import { affectedTasks, invalidateTaskResults, selectScheduledTask, taskPrompt, type TaskSchedule } from '@/lib/task-scheduler'
import { batchedStorage } from '@/lib/batched-storage'
import { createWorkspaceDatabase } from '@/lib/workspace-database'
import { workspaceStorageStatus } from '@/lib/workspace-storage-status'
import { galleryImageData, type GalleryImage } from '@/lib/gallery'
import { isWorkspaceAttachment, MAX_ATTACHMENTS, type WorkspaceAttachment } from '@shared/attachments'
import { isAbsoluteDirectory } from '@shared/project-directory'
import { createWorkspaceBackup, isRestoredRunId, parseWorkspaceBackup, parseWorkspaceSnapshot } from '@/lib/workspace-backup'
import { PORTABLE_LIMITS, type PortablePreview } from '@shared/portable-backup'
import type { ProjectRelinkPreview } from '@shared/project-relink'
import {
  isValidTeam, hasDependencyCycle, taskDependencies, recoverTaskGraph,
  createWorkspace,
  migrateLegacyTeam,
  employeeReferenced,
  PROVIDER_IDS,
  makeId,
  seedTeams,
  teamDirectory,
  type Team,
  type TeamTask,
  type TeamArtifact,
  type Member,
  type Provider,
  type WorkspacePage
} from '@/lib/collaboration-data'

interface CollaborationState {
  surface: 'workspace' | 'legacy'
  page: WorkspacePage
  activeTeamId: string
  teams: Team[]
  drafts: Record<string, string>
  attachmentDrafts: Record<string, WorkspaceAttachment[]>
  addAttachments: (teamId: string, files: WorkspaceAttachment[]) => void
  removeAttachment: (teamId: string, id: string) => void
  storageError: boolean
  retryStorage: () => void
  previousWorkspaceBackup: string | null
  restoreWorkspaceBackup: (text: string) => void
  deletedGalleryKeys: string[]
  deleteGalleryImages: (items: GalleryImage[]) => void
  restoreGalleryImages: (keys: string[]) => void
  defaultProvider: Provider
  creatingProject: boolean
  modelDefaults: Partial<Record<Provider, ModelChoice>>
  runs: Record<string, RunSnapshot>
  runtimeError: string | null
  connectionErrors: Record<string, string>
  stoppingRuns: Record<string, boolean>
  taskSchedules: Record<string, TaskSchedule>
  startTaskSchedule: (teamId: string) => void
  pauseTaskSchedule: (teamId: string) => Promise<void>
  executeTask: (teamId: string, taskId: string) => Promise<string | undefined>
  renameConversation: (id: string, name: string) => boolean
  deleteConversation: (id: string) => Promise<boolean>
  setModelDefault: (provider: Provider, choice: ModelChoice) => void
  applyRun: (snapshot: RunSnapshot) => void
  send: (teamId: string, to: string, taskId?: string, retry?: { sourceId: string; replyId?: string; editedText?: string }, taskInput?: string, interaction?: 'conversation') => Promise<string | undefined>
  editMessage: (teamId: string, messageId: string, text: string) => Promise<void>
  deleteMessage: (teamId: string, messageId: string) => void
  retryMessage: (teamId: string, messageId: string) => Promise<void>
  stop: (runId: string) => Promise<void>
  answerPermission: (runId: string, permissionId: string, option: string) => Promise<void>
  setCreatingProject: (open: boolean) => void
  setDefaultProvider: (provider: Provider) => void
  createWorkspace: (kind: Team['kind'], name?: string, goal?: string, parentId?: string, directory?: string) => string
  generateImages: (prompt: string, provider: Provider, ratio: string, count: number, reference?: GalleryImage) => Promise<void>
  saveEmployee: (workspaceId: string, employee: Member) => void
  removeEmployee: (workspaceId: string, employeeId: string) => void
  setSurface: (surface: CollaborationState['surface']) => void
  navigate: (page: WorkspacePage, teamId?: string) => void
  setDraft: (teamId: string, value: string) => void
  setPermissionMode: (teamId: string, mode: PermissionMode) => void
  updateTeam: (id: string, name: string, goal: string, members: Member[], directory?: string) => void
  togglePause: (teamId: string) => void
  saveMessage: (teamId: string, to: string, taskInput?: string) => void
  saveTask: (teamId: string, task: TeamTask) => boolean
  addArtifact: (teamId: string, artifact: Omit<TeamArtifact, 'id'>) => void
}

function invalidateDeliveries(state: CollaborationState, teamId: string, roots: Iterable<string>): Partial<CollaborationState> {
  const team = state.teams.find((t) => t.id === teamId)
  if (!team) return {}
  const affected = affectedTasks(team, roots)
  if (!affected.size) return {}
  const schedule = state.taskSchedules[teamId]
  return {
    teams: state.teams.map((t) => t.id === teamId ? { ...t, tasks: invalidateTaskResults(t, affected) } : t),
    ...(schedule ? { taskSchedules: { ...state.taskSchedules, [teamId]: { ...schedule, status: 'paused',
      remaining: [...new Set([...schedule.remaining, ...affected])] } } } : {})
  }
}

const initialTeams = seedTeams()
let workspaceEpoch = 0
export const currentWorkspaceGeneration = () => workspaceEpoch
let storageWriteFailed = false
function reportStorageWrite(failed: boolean): void {
  storageWriteFailed = failed
  queueMicrotask(() => {
    if (useCollaboration.getState().storageError !== storageWriteFailed)
      useCollaboration.setState({ storageError: storageWriteFailed })
  })
}
type SavedCollaboration = Pick<CollaborationState, 'teams' | 'drafts' | 'attachmentDrafts' | 'activeTeamId' | 'defaultProvider' | 'modelDefaults' | 'taskSchedules' | 'deletedGalleryKeys'>
export const WORKSPACE_STORAGE_KEY = 'grok-desktop-collaboration-ui-v1'
const validTeams = new WeakSet<Team>()
function validWorkspace(value: StorageValue<SavedCollaboration>): boolean {
  const state = value?.state
  if (value?.version !== 2 || !state || !Array.isArray(state.teams) || !state.teams.length) return false
  const ids = new Set<string>()
  for (const team of state.teams) {
    if (!team || ids.has(team.id)) return false
    if (!validTeams.has(team)) {
      if (!isValidTeam(team, false)) return false
      validTeams.add(team)
    }
    ids.add(team.id)
  }
  return state.teams.every((team) => team.parentId === null || (team.kind === 'conversation' &&
    state.teams.some((parent) => parent.id === team.parentId && parent.kind === 'project')))
}
function migrateWorkspace(saved: unknown, version: number): SavedCollaboration {
  if (version !== 1 || !saved || typeof saved !== 'object') return saved as SavedCollaboration
  const value = saved as Record<string, unknown>
  if (!Array.isArray(value.teams)) return saved as SavedCollaboration
  const teams = value.teams.map(migrateLegacyTeam)
  return (teams.every(Boolean) ? { ...value, teams, defaultProvider: 'grok' } : saved) as SavedCollaboration
}
// Node-only store tests retain their synchronous adapter. Desktop and browser
// renderers must open their database successfully before any workspace UI runs.
const browserWorkspace = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function'
function databaseFactory(): IDBFactory {
  try { if (typeof indexedDB !== 'undefined') return indexedDB } catch { /* error is reported by hydration below */ }
  return { open: () => { throw new Error('当前环境无法打开工作区数据库，请重新启动应用后重试。') } } as unknown as IDBFactory
}
const workspaceDatabase = browserWorkspace
  ? createWorkspaceDatabase<SavedCollaboration>({ factory: databaseFactory(), legacy: () => localStorage,
    validate: validWorkspace,
    normalizeLegacy: (value) => value?.version === 1 ? { state: migrateWorkspace(value.state, 1), version: 2 } : value })
  : null
const fallbackStorage = createJSONStorage<SavedCollaboration>(() => ({
  getItem: (key) => { try { return localStorage.getItem(key) } catch { return null } },
  setItem: (key, value) => { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value) },
  removeItem: (key) => { if (typeof localStorage !== 'undefined') localStorage.removeItem(key) }
}))!
let lastSavedValue: StorageValue<SavedCollaboration> | undefined
const sameSavedFields = (value: StorageValue<SavedCollaboration>) => !!lastSavedValue && lastSavedValue.version === value.version &&
  Object.keys(value.state).every((key) => value.state[key as keyof SavedCollaboration] === lastSavedValue!.state[key as keyof SavedCollaboration])
const storageAdapter: PersistStorage<SavedCollaboration> = {
  getItem: (key) => (workspaceDatabase || fallbackStorage).getItem(key),
  setItem: (key, value) => {
    if (sameSavedFields(value)) return workspaceDatabase ? reconcilePortableWorkspace(value.state) : undefined
    const result = (workspaceDatabase || fallbackStorage).setItem(key, value)
    if (result && typeof (result as Promise<unknown>).then === 'function')
      return Promise.resolve(result).then(async () => { lastSavedValue = value; await reconcilePortableWorkspace(value.state) })
    lastSavedValue = value
  },
  removeItem: (key) => { lastSavedValue = undefined; return (workspaceDatabase || fallbackStorage).removeItem(key) }
}
const workspaceStorage = batchedStorage(storageAdapter,
  (state) => state.teams.some((team) => team.messages.some((message) => message.status === 'running')), {
    pending: (pending) => workspaceStorageStatus.update({ pending }),
    error: (error) => { reportStorageWrite(true); workspaceStorageStatus.update({ error: error instanceof Error ? error.message : '工作区保存失败，请导出备份并重试。' }) },
    saved: () => { reportStorageWrite(false); workspaceStorageStatus.update({ error: null }) }
  })
export const flushWorkspaceStorage = () => workspaceStorage.flush()
export const hasPendingWorkspaceStorage = () => workspaceStorage.hasPending() || !!portableInFlight
const heldRunUpdates = new Map<string, RunSnapshot>()
let portableInFlight: Promise<unknown> | undefined
let portablePreviewGeneration: number | undefined
let synchronizedScopes = ''
let relinkPrepared: { token: string; projectId: string; generation: number; before: SavedCollaboration } | undefined
const savedWorkspace = (state: CollaborationState): SavedCollaboration => ({ teams: state.teams, drafts: state.drafts,
  attachmentDrafts: state.attachmentDrafts, activeTeamId: state.activeTeamId, defaultProvider: state.defaultProvider,
  modelDefaults: state.modelDefaults, taskSchedules: state.taskSchedules, deletedGalleryKeys: state.deletedGalleryKeys })
function portableBridge() {
  if (typeof window === 'undefined' || !window.grok?.backup || !workspaceDatabase) throw new Error('便携备份需要使用桌面应用。')
  return window.grok.backup
}
function assertPortableIdle() {
  const state = useCollaboration.getState()
  if (workspaceStorageStatus.getSnapshot().phase !== 'ready' || workspaceStorageStatus.getSnapshot().closing)
    throw new Error('请等待工作区读取或保存完成后重试。')
  if (state.creatingProject || Object.values(state.runs).some((run) => isActive(run.status)) ||
    Object.values(state.taskSchedules).some((schedule) => ['running', 'waiting_review'].includes(schedule.status)) ||
    state.teams.some((team) => team.messages.some((message) => message.status && isActive(message.status))) ||
    Object.values(useAssistant.getState().saving).some((value) => value > 0))
    throw new Error('请等待所有执行、任务计划和助手保存完成，再进行便携备份。')
}
function portableTask<T>(operation: () => Promise<T>): Promise<T> {
  if (portableInFlight) return Promise.reject(new Error('备份操作正在进行，请等待完成。'))
  const promise = Promise.resolve().then(operation)
  portableInFlight = promise
  void promise.finally(() => { if (portableInFlight === promise) portableInFlight = undefined }).catch(() => {})
  return promise
}
async function reconcilePortableWorkspace(state: SavedCollaboration, force = false): Promise<void> {
  if (typeof window === 'undefined' || !window.grok?.backup || !workspaceDatabase) return
  const scopes = [...new Set(state.teams.map((team) => team.parentId || team.id))].sort()
  const key = JSON.stringify(scopes)
  if (!force && synchronizedScopes === key) return
  await window.grok.backup.reconcile(await workspaceDatabase.getImportMarker(WORKSPACE_STORAGE_KEY), scopes)
  synchronizedScopes = key
}
export const beginPortableExport = (): Promise<PortablePreview> => portableTask(async () => {
  assertPortableIdle(); await flushWorkspaceStorage().catch(() => {}); assertPortableIdle()
  const generation = workspaceEpoch
  const result = await portableBridge().beginExport(createWorkspaceBackup(useCollaboration.getState(), PORTABLE_LIMITS.manifestBytes, true))
  if (generation !== workspaceEpoch) { await portableBridge().cancel(result.token); throw new Error('工作区已变化，请重新导出。') }
  portablePreviewGeneration = generation
  return result
})
export const inspectPortableImport = (): Promise<PortablePreview | null> => portableTask(async () => {
  assertPortableIdle(); await flushWorkspaceStorage(); assertPortableIdle()
  const generation = workspaceEpoch, result = await portableBridge().inspectImport()
  if (generation !== workspaceEpoch) { if (result) await portableBridge().cancel(result.token); throw new Error('工作区已变化，请重新选择备份。') }
  portablePreviewGeneration = generation
  return result
})
export const cancelPortableBackup = async (token?: string): Promise<void> => {
  const pending = portableInFlight
  await portableBridge().cancel(token)
  await pending?.catch(() => {})
  portablePreviewGeneration = undefined
}
export const writePortableExport = (token: string, allowIncomplete: boolean) => portableTask(async () => {
  if (portablePreviewGeneration !== workspaceEpoch) throw new Error('工作区已变化，请关闭预览后重新导出。')
  return portableBridge().writeExport(token, allowIncomplete)
})
export const hasPortableRestorePoint = async (): Promise<boolean> => !!(workspaceDatabase && await workspaceDatabase.getRestorePoint(WORKSPACE_STORAGE_KEY))
function showRestoredWorkspace(restored: SavedCollaboration): void {
  workspaceEpoch++
  heldRunUpdates.clear()
  lastSavedValue = { state: restored, version: 2 }
  useCollaboration.setState({ ...restored, previousWorkspaceBackup: null, runs: {}, connectionErrors: {}, stoppingRuns: {},
    runtimeError: null, creatingProject: false, surface: 'workspace',
    page: restored.teams.find((team) => team.id === restored.activeTeamId)?.gallery ? 'gallery' : 'team' })
  useAssistant.setState({ snapshots: {}, loading: {}, saving: {}, errors: {} })
}
async function commitPortableRestore(prepare: () => Promise<{ operationId: string; restored: SavedCollaboration }>): Promise<void> {
  assertPortableIdle(); await flushWorkspaceStorage(); assertPortableIdle()
  const before = savedWorkspace(useCollaboration.getState()), generation = workspaceEpoch
  let committed = false
  try {
    const plan = await prepare()
    const now = savedWorkspace(useCollaboration.getState())
    if (generation !== workspaceEpoch || Object.keys(before).some((key) => before[key as keyof SavedCollaboration] !== now[key as keyof SavedCollaboration]))
      throw new Error('准备期间工作区发生变化，未替换原数据；请重新选择备份。')
    assertPortableIdle()
    workspaceStorageStatus.update({ closing: true })
    await flushWorkspaceStorage()
    await workspaceDatabase!.commitRestore(WORKSPACE_STORAGE_KEY, { state: plan.restored, version: 2 }, plan.operationId)
    committed = true
    showRestoredWorkspace(plan.restored)
    await flushWorkspaceStorage()
    await reconcilePortableWorkspace(plan.restored, true)
  } catch (error) {
    if (!committed) {
      try { await flushWorkspaceStorage(); await reconcilePortableWorkspace(savedWorkspace(useCollaboration.getState()), true) }
      catch { workspaceStorageStatus.update({ phase: 'error', error: '原工作区未替换，但恢复收尾未确认；请重新读取工作区。' }) }
    }
    if (committed) {
      const message = '数据已写入，恢复收尾尚未确认；请重新读取工作区，不要重复导入。'
      workspaceStorageStatus.update({ phase: 'error', error: message }); throw new Error(message, { cause: error })
    }
    throw error
  } finally { portablePreviewGeneration = undefined; resumeWorkspace() }
}
export const restorePortableBackup = (token: string, allowIncomplete: boolean): Promise<void> => portableTask(async () => {
  if (portablePreviewGeneration !== workspaceEpoch) throw new Error('工作区已变化，请重新选择备份。')
  await commitPortableRestore(async () => {
    const plan = await portableBridge().prepareRestore(token, allowIncomplete)
    const restored = parseWorkspaceBackup(plan.workspaceText, PORTABLE_LIMITS.manifestBytes, true)
    return { operationId: plan.operationId, restored: { ...restored, taskSchedules: {} } }
  })
})
export const rollbackPortableBackup = (): Promise<void> => portableTask(async () => {
  await commitPortableRestore(async () => {
    const point = await workspaceDatabase!.getRestorePoint(WORKSPACE_STORAGE_KEY)
    if (!point) throw new Error('没有可用的持久回退点。')
    const restored = parseWorkspaceBackup(createWorkspaceBackup(point.state, PORTABLE_LIMITS.manifestBytes, true), PORTABLE_LIMITS.manifestBytes, true)
    return { operationId: await portableBridge().prepareRollback(), restored: { ...restored, taskSchedules: {} } }
  })
})
function relinkBridge() {
  if (typeof window === 'undefined' || !window.grok?.projectRelink || !workspaceDatabase) throw new Error('重新关联目录需要使用桌面应用。')
  return window.grok.projectRelink
}
export const prepareProjectRelink = (projectId: string): Promise<ProjectRelinkPreview | null> => portableTask(async () => {
  assertPortableIdle(); await flushWorkspaceStorage(); assertPortableIdle()
  const before = savedWorkspace(useCollaboration.getState()), generation = workspaceEpoch
  const result = await relinkBridge().prepare(createWorkspaceBackup(before, PORTABLE_LIMITS.manifestBytes, true), projectId)
  if (generation !== workspaceEpoch) {
    if (result) await relinkBridge().cancel(result.token)
    throw new Error('工作区已变化，请重新选择目录。')
  }
  relinkPrepared = result ? { token: result.token, projectId, generation, before } : undefined
  return result
})
export const cancelProjectRelink = async (token?: string): Promise<void> => {
  const pending = portableInFlight
  await relinkBridge().cancel(token)
  await pending?.catch(() => {})
  relinkPrepared = undefined
}
export const commitProjectRelink = (token: string, allowIncomplete: boolean): Promise<void> => portableTask(async () => {
  const prepared = relinkPrepared
  if (!prepared || prepared.token !== token || prepared.generation !== workspaceEpoch) throw new Error('工作区已变化，请重新选择目录。')
  assertPortableIdle(); await flushWorkspaceStorage(); assertPortableIdle()
  const unchanged = () => {
    const now = savedWorkspace(useCollaboration.getState())
    if (prepared.generation !== workspaceEpoch || Object.keys(prepared.before).some((key) =>
      prepared.before[key as keyof SavedCollaboration] !== now[key as keyof SavedCollaboration]))
      throw new Error('准备期间工作区发生变化，尚未关联目录；请重新选择。')
  }
  unchanged()
  let published = false, committed = false
  try {
    const plan = await relinkBridge().commit(token, allowIncomplete)
    published = true
    unchanged(); assertPortableIdle()
    const mapped = parseWorkspaceSnapshot(plan.workspaceText, PORTABLE_LIMITS.manifestBytes, true)
    const related = new Set(prepared.before.teams.filter((team) => team.id === prepared.projectId || team.parentId === prepared.projectId).map((team) => team.id))
    const teams = new Map(mapped.teams.filter((team) => related.has(team.id)).map((team) => [team.id, team]))
    if (teams.size !== related.size || !teams.get(prepared.projectId)?.directory) throw new Error('目录关联结果不完整，原项目已保留。')
    const next: SavedCollaboration = { ...prepared.before,
      teams: prepared.before.teams.map((team) => teams.get(team.id) || team),
      drafts: { ...prepared.before.drafts }, attachmentDrafts: { ...prepared.before.attachmentDrafts },
      deletedGalleryKeys: mapped.deletedGalleryKeys,
      taskSchedules: Object.fromEntries(Object.entries(prepared.before.taskSchedules).filter(([id]) => !related.has(id))) }
    for (const id of related) {
      if (Object.hasOwn(mapped.drafts, id)) next.drafts[id] = mapped.drafts[id]
      if (Object.hasOwn(mapped.attachmentDrafts, id)) next.attachmentDrafts[id] = mapped.attachmentDrafts[id]
    }
    workspaceStorageStatus.update({ closing: true })
    await flushWorkspaceStorage()
    await workspaceDatabase!.setItem(WORKSPACE_STORAGE_KEY, { state: next, version: 2 })
    committed = true
    workspaceEpoch++; heldRunUpdates.clear()
    lastSavedValue = { state: next, version: 2 }
    useCollaboration.setState((state) => ({ ...next,
      runs: Object.fromEntries(Object.entries(state.runs).filter(([, run]) => !related.has(run.workspaceId))), runtimeError: null }))
    await flushWorkspaceStorage()
    await relinkBridge().finish(token)
    relinkPrepared = undefined
  } catch (error) {
    if (!published) {
      // The host may have published its plan before the IPC response was lost.
      // Releasing that lease retains every file copy and is safe before our DB
      // commit; a preview-phase rejection intentionally leaves cancel available.
      try { await relinkBridge().finish(token); relinkPrepared = undefined } catch { /* No published host plan. */ }
    }
    if (published) {
      try { await relinkBridge().finish(token) } catch {
        workspaceStorageStatus.update({ phase: 'error', error: '目录关联收尾未确认，请重新读取工作区；引用文件已保留。' })
      }
      relinkPrepared = undefined
    }
    if (committed) {
      const message = '目录已写入，收尾尚未确认；请重新读取工作区，不要重复关联。'
      workspaceStorageStatus.update({ phase: 'error', error: message }); throw new Error(message, { cause: error })
    }
    throw error
  } finally { resumeWorkspace() }
})
export async function prepareWorkspaceClose(): Promise<void> {
  if (portableInFlight) await portableInFlight
  if (typeof window !== 'undefined' && window.grok?.backup) await window.grok.backup.cancel()
  if (typeof window !== 'undefined' && window.grok?.projectRelink) await window.grok.projectRelink.cancel()
  relinkPrepared = undefined
  workspaceStorageStatus.update({ closing: true })
  await workspaceStorage.flush()
}
export function resumeWorkspace(): void {
  workspaceStorageStatus.update({ closing: false })
  for (const snapshot of heldRunUpdates.values()) useCollaboration.getState().applyRun(snapshot)
  heldRunUpdates.clear()
  requestTaskPump()
}
export async function recoverPreviousWorkspace(): Promise<void> {
  if (!workspaceDatabase) throw new Error('当前环境不支持快照恢复。')
  workspaceStorageStatus.update({ phase: 'loading', error: null })
  try {
    await workspaceDatabase.recoverPrevious(WORKSPACE_STORAGE_KEY)
    await useCollaboration.persist.rehydrate()
  } catch (error) {
    workspaceStorageStatus.update({ phase: 'error', error: error instanceof Error ? error.message : '恢复失败，原数据已保留。' })
  }
}
export async function retryWorkspaceLoad(): Promise<void> {
  workspaceStorageStatus.update({ phase: 'loading', error: null, previousAvailable: false })
  // This action is available only behind the startup gate, before user edits.
  // Do not let a failed startup normalization mask a fresh disk read.
  await workspaceStorage.flush().catch(() => {})
  workspaceStorage.discardPending()
  lastSavedValue = undefined
  await useCollaboration.persist.rehydrate()
}
function retainRuns(runs: Record<string, RunSnapshot>) {
  const completed = Object.keys(runs).filter((id) => !isActive(runs[id].status))
  for (const id of completed.slice(0, Math.max(0, completed.length - 100))) delete runs[id]
  return runs
}
export const useCollaboration = create<CollaborationState>()(
  persist(
    (set, get) => ({
      surface: 'workspace',
      page: 'team',
      activeTeamId: initialTeams[0].id,
      teams: initialTeams,
      drafts: {},
      attachmentDrafts: {},
      addAttachments: (teamId, files) => set((s) => s.teams.some((t) => t.id === teamId) ? ({ attachmentDrafts: { ...s.attachmentDrafts,
        [teamId]: [...(s.attachmentDrafts[teamId] || []), ...files.filter(isWorkspaceAttachment)].slice(0, MAX_ATTACHMENTS) } }) : s),
      removeAttachment: (teamId, id) => set((s) => ({ attachmentDrafts: { ...s.attachmentDrafts,
        [teamId]: (s.attachmentDrafts[teamId] || []).filter((a) => a.id !== id) } })),
      storageError: false,
      previousWorkspaceBackup: null,
      restoreWorkspaceBackup: (text) => {
        const state = get()
        if (Object.values(state.runs).some((run) => isActive(run.status)) ||
          Object.values(state.taskSchedules).some((schedule) => schedule.status === 'running') ||
          state.teams.some((team) => team.messages.some((message) => message.status && isActive(message.status))))
          throw new Error('请先停止所有执行和任务计划，再恢复备份。')
        const restored = parseWorkspaceBackup(text)
        const previousWorkspaceBackup = createWorkspaceBackup(state)
        workspaceEpoch++
        set({ ...restored, previousWorkspaceBackup, runs: {}, taskSchedules: {}, connectionErrors: {},
          stoppingRuns: {}, runtimeError: null, creatingProject: false, surface: 'workspace',
          page: restored.teams.find((team) => team.id === restored.activeTeamId)?.gallery ? 'gallery' : 'team' })
      },
      retryStorage: () => {
        // Re-save the current in-memory state, including a draft that failed to
        // persist. Streaming normally defers writes, so explicitly flush it.
        set({})
        const storage = useCollaboration.persist.getOptions().storage as { flush?: () => Promise<void> } | undefined
        void storage?.flush?.().catch(() => {})
      },
      deletedGalleryKeys: [],
      deleteGalleryImages: (items) => set((s) => ({ deletedGalleryKeys: [...new Set([...s.deletedGalleryKeys, ...items.flatMap((item) => item.keys)])] })),
      restoreGalleryImages: (keys) => set((s) => ({ deletedGalleryKeys: s.deletedGalleryKeys.filter((key) => !keys.includes(key)) })),
      defaultProvider: 'grok',
      creatingProject: false,
      modelDefaults: {},
      runs: {},
      runtimeError: null,
      connectionErrors: {},
      stoppingRuns: {},
      taskSchedules: {},
      startTaskSchedule: (teamId) => {
        const team = get().teams.find((item) => item.id === teamId)
        const parent = get().teams.find((item) => item.id === team?.parentId)
        if (!team || !isValidTeam(team) || team.paused || parent?.paused) {
          set({ runtimeError: '项目或对话已暂停，或任务配置无效。' }); return
        }
        const previous = get().taskSchedules[teamId]
        const continuing = previous && previous.status !== 'completed'
        const run = previous?.runId ? get().runs[previous.runId] : undefined
        const keepRun = continuing && previous.runId && (!run || isActive(run.status))
        const schedule: TaskSchedule = { remaining: continuing ? previous.remaining : team.tasks.filter((task) => task.state === 'ready').map((task) => task.id),
          status: 'running', runId: keepRun ? previous.runId : undefined, taskId: keepRun ? previous.taskId : undefined }
        set((s) => ({ taskSchedules: { ...s.taskSchedules, [teamId]: schedule }, runtimeError: null }))
        if (keepRun) reconnectRun(previous.runId!)
        requestTaskPump()
      },
      pauseTaskSchedule: async (teamId) => {
        const schedule = get().taskSchedules[teamId]
        if (!schedule) return
        set((s) => ({ taskSchedules: { ...s.taskSchedules, [teamId]: { ...schedule, status: 'paused' } } }))
        if (schedule.runId && isActive(get().runs[schedule.runId]?.status)) await get().stop(schedule.runId)
      },
      executeTask: async (teamId, taskId) => {
        const task = get().teams.find((team) => team.id === teamId)?.tasks.find((task) => task.id === taskId)
        if (!task) return
        return get().send(teamId, task.owner, taskId, undefined, taskPrompt(task))
      },
      renameConversation: (id, name) => {
        const title = name.trim()
        if (!title || title.length > 80 || !get().teams.some((t) => t.id === id && t.kind === 'conversation')) return false
        set((s) => ({ teams: s.teams.map((t) => t.id === id ? { ...t, name: title } : t) }))
        return true
      },
      deleteConversation: async (id) => {
        const generation = workspaceEpoch
        const conversation = get().teams.find((t) => t.id === id && t.kind === 'conversation')
        if (!conversation) return false
        if (get().taskSchedules[id]) await get().pauseTaskSchedule(id)
        if (generation !== workspaceEpoch) return false
        // Preserve the conversation if cancellation fails; never hide a running job.
        for (const run of Object.values(get().runs).filter((r) => r.workspaceId === id && isActive(r.status))) {
          await get().stop(run.id)
          if (generation !== workspaceEpoch) return false
        }
        if (Object.values(get().runs).some((r) => r.workspaceId === id && isActive(r.status))) return false
        const cleared = conversation.parentId || await useAssistant.getState().clearScope(id)
        if (generation !== workspaceEpoch) return false
        if (!cleared) {
          set({ runtimeError: '助手资料和提醒未能清理，对话已保留，请重试。' })
          return false
        }
        set((s) => {
          const teams = s.teams.filter((t) => t.id !== id)
          if (!teams.some((team) => !team.gallery)) {
            const empty = createWorkspace('conversation', s.defaultProvider)
            empty.members = empty.members.map((m) => ({ ...m, ...s.modelDefaults[m.provider] }))
            teams.push(empty)
          }
          const drafts = { ...s.drafts }, attachmentDrafts = { ...s.attachmentDrafts }
          delete drafts[id]
          delete attachmentDrafts[id]
          const removedRuns = new Set(Object.values(s.runs).filter((r) => r.workspaceId === id).map((r) => r.id))
          return {
            teams, drafts, attachmentDrafts,
            taskSchedules: Object.fromEntries(Object.entries(s.taskSchedules).filter(([key]) => key !== id)),
            activeTeamId: s.activeTeamId === id ? teams.find((team) => !team.gallery)!.id : s.activeTeamId,
            runs: Object.fromEntries(Object.entries(s.runs).filter(([key]) => !removedRuns.has(key))),
            connectionErrors: Object.fromEntries(Object.entries(s.connectionErrors).filter(([key]) => !removedRuns.has(key))),
            runtimeError: null
          }
        })
        return true
      },
      setModelDefault: (provider, choice) =>
        set((s) => ({ modelDefaults: { ...s.modelDefaults, [provider]: choice } })),
      applyRun: (snapshot) => {
        if (workspaceStorageStatus.getSnapshot().closing) { heldRunUpdates.set(snapshot.id, snapshot); return }
        if (!get().teams.some((t) => t.id === snapshot.workspaceId)) return
        const previous = get().runs[snapshot.id]
        if (previous?.revision !== undefined && snapshot.revision !== undefined && snapshot.revision <= previous.revision) return
        if (previous && !isActive(previous.status) && isActive(snapshot.status)) return
        if (snapshot.revision === undefined && JSON.stringify(previous) === JSON.stringify(snapshot)) return
        if (snapshot.assistantUpdated && !isActive(snapshot.status) && (!previous || isActive(previous.status))) {
          const team = get().teams.find((item) => item.id === snapshot.workspaceId)!
          void useAssistant.getState().refresh(assistantScopeId(team))
        }
        set((s) => ({
          runs: retainRuns({ ...s.runs, [snapshot.id]: snapshot }),
          teams: s.teams.map((t) => {
            if (t.id !== snapshot.workspaceId) return t
            const members = [...t.members]
            for (const recruited of snapshot.coordination?.recruited || []) {
              if (!members.some((m) => m.id === recruited.id)) {
                members.push({
                  id: recruited.id,
                  name: recruited.name,
                  provider: recruited.provider,
                  role: recruited.role,
                  persona: recruited.persona,
                  ...(recruited.model ? { model: recruited.model } : s.modelDefaults[recruited.provider] || {}),
                  ...(recruited.effort ? { effort: recruited.effort } : {}),
                  isLead: false
                })
              }
            }
            const artifacts = [...t.artifacts]
            for (const shared of snapshot.sharedArtifacts || []) {
              const owner = members.some((m) => m.id === shared.owner) ? shared.owner : (members.find((m) => m.isLead)?.id || members[0].id)
              const existingIndex = artifacts.findIndex((a) => !a.sample && a.name === shared.name)
              if (existingIndex >= 0) {
                const existing = artifacts[existingIndex]
                if (existing.content !== shared.content || existing.description !== shared.description) {
                  artifacts[existingIndex] = {
                    ...existing,
                    description: shared.description,
                    owner,
                    format: shared.format,
                    content: shared.content,
                    version: existing.version + 1
                  }
                }
              } else {
                artifacts.push({
                  id: makeId('artifact'),
                  name: shared.name,
                  description: shared.description,
                  owner,
                  version: 1,
                  content: shared.content,
                  format: shared.format,
                  sample: false
                })
              }
            }
            const messages = t.messages.map((m) =>
              m.runId === snapshot.id && (m.author === 'you' || !snapshot.replies.some((r) => r.employeeId === m.author))
                ? { ...m, status: snapshot.status, error: snapshot.error }
                : m
            )
            for (const reply of snapshot.replies) {
              const generatedId = reply.id || `${snapshot.id}-${reply.employeeId}`
              if (t.deletedMessageIds?.includes(generatedId)) continue
              const previous = (reply.id ? messages.find((m) => m.runId === snapshot.id && (m.id === reply.id || m.runtimeReplyId === reply.id)) : undefined) ||
                messages.find((m) => m.runId === snapshot.id && m.author === reply.employeeId &&
                  (!reply.id || (m.status === 'queued' && !m.text && !!m.sourceMessageId && !m.toolPermission)))
              const id = previous?.id || generatedId
              if (t.deletedMessageIds?.includes(id)) continue
              const value = {
                ...previous,
                id,
                author: reply.employeeId,
                authorName: reply.employeeName || members.find((member) => member.id === reply.employeeId)?.name,
                receipt: reply.receipt,
                provider: reply.provider,
                taskId: reply.taskId || snapshot.taskId,
                text: reply.text,
                time: new Date(snapshot.createdAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit'
                }),
                to: 'all',
                kind: reply.kind || 'message' as const,
                sample: false,
                runId: snapshot.id,
                runtimeReplyId: reply.id || previous?.runtimeReplyId,
                status: reply.status,
                model: reply.model,
                effort: reply.effort,
                error: reply.error,
                images: reply.images,
                cwd: reply.cwd,
                sessionId: reply.sessionId,
                interaction: snapshot.interaction || previous?.interaction,
                private: !!(previous && isAssistantPrivateMessage(previous, members.find((member) => member.isLead)?.id)) ||
                  snapshot.interaction === 'conversation' || !!(snapshot.coordination && reply.employeeId === snapshot.coordination.leadId),
                sourceMessageId: previous?.sourceMessageId || messages.find((m) => m.runId === snapshot.id && m.author === 'you')?.id
              }
              const index = messages.findIndex((m) => m.id === id)
              if (index < 0) messages.push(value)
              else messages[index] = value
            }
            const permissionHistory = snapshot.permissionHistory || snapshot.permissions.map((permission) => ({ ...permission,
              createdAt: snapshot.createdAt, status: 'pending' as const,
              replyId: snapshot.replies.filter((reply) => reply.employeeId === permission.employeeId).at(-1)?.id || `${snapshot.id}-${permission.employeeId}` }))
            for (const permission of permissionHistory) {
              const id = `${snapshot.id}-permission-${permission.id}`
              if (t.deletedMessageIds?.includes(id)) continue
              const replyId = permission.replyId || snapshot.replies.filter((item) => item.employeeId === permission.employeeId).at(-1)?.id || `${snapshot.id}-${permission.employeeId}`
              const reply = snapshot.replies.find((item) => (item.id || `${snapshot.id}-${item.employeeId}`) === replyId)
              const value = { id, author: permission.employeeId, authorName: reply?.employeeName || members.find((member) => member.id === permission.employeeId)?.name,
                provider: reply?.provider || members.find((member) => member.id === permission.employeeId)?.provider,
                text: permissionSummary(permission), toolPermission: { ...permission, replyId },
                time: new Date(permission.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                to: 'all', kind: 'decision' as const, sample: false, runId: snapshot.id,
                status: permission.status === 'pending' ? snapshot.status : 'completed' as const }
              const index = messages.findIndex((message) => message.id === id)
              if (index >= 0) messages[index] = value
              else {
                let position = messages.findIndex((message) => message.id === replyId || message.runtimeReplyId === replyId)
                if (position < 0) position = messages.length - 1
                while (messages[position + 1]?.toolPermission?.replyId === replyId) position++
                messages.splice(position + 1, 0, value)
              }
            }
            // Old clients may have no history; keep their inline record after the pending request disappears.
            for (let index = 0; index < messages.length; index++) {
              const message = messages[index]
              if (message.runId === snapshot.id && message.toolPermission?.status === 'pending' &&
                !snapshot.permissions.some((permission) => permission.id === message.toolPermission!.id)) {
                const permission = { ...message.toolPermission, status: 'cancelled' as const }
                messages[index] = { ...message, toolPermission: permission, text: permissionSummary(permission), status: 'completed' }
              }
            }
            const taskId = snapshot.taskId || messages.find(
              (m) => m.runId === snapshot.id && m.author === 'you'
            )?.taskId || messages.find((m) => m.id === messages.find((reply) => reply.runId === snapshot.id && reply.sourceMessageId)?.sourceMessageId)?.taskId
            const newerTaskRun = taskId && Object.values(s.runs).some((run) =>
              run.id !== snapshot.id && run.workspaceId === t.id && isActive(run.status) &&
              messages.some((m) => m.runId === run.id && (m.taskId === taskId ||
                messages.some((source) => source.id === m.sourceMessageId && source.taskId === taskId))))
            const tasks = [...t.tasks]
            for (const delegated of snapshot.coordination?.tasks || []) {
              const index = tasks.findIndex((task) => task.id === delegated.id)
              const existing = index >= 0 ? tasks[index] : undefined
              const resultRunId = snapshot.replies.some((reply) => reply.id === delegated.replyId) ? snapshot.id : existing?.resultRunId
              const value = {
                ...existing, id: delegated.id, title: delegated.title, description: delegated.description,
                acceptance: delegated.acceptance, owner: members.some((m) => m.id === delegated.owner) ? delegated.owner : (members.find((m) => m.isLead)?.id || members[0].id),
                dependency: delegated.dependencies[0] || null,
                managedDependencies: delegated.dependencies,
                managedRunId: snapshot.id, managedStatus: delegated.status,
                reviewNote: delegated.review || delegated.error,
                resultRunId: ['review', 'completed'].includes(delegated.status) ? resultRunId : undefined,
                state: (delegated.status === 'working' ? 'working' : delegated.status === 'completed'
                  ? resultRunId && existing?.acceptedRunId === resultRunId ? 'done' : 'review'
                  : delegated.status === 'review' ? 'review' : 'ready') as TeamTask['state']
              }
              if (index >= 0) tasks[index] = value
              else tasks.push(value)
            }
            for (const item of tasks) {
              if (item.dependency && (!tasks.some((d) => d.id === item.dependency) || hasDependencyCycle(tasks, item.id, item.dependency))) {
                item.dependency = null
              }
            }
            return {
              ...t,
              members,
              artifacts,
              messages,
              tasks: tasks.map((task) =>
                task.id === taskId && task.state === 'working' && !newerTaskRun
                  ? {
                      ...task,
                      resultRunId: snapshot.status === 'completed' ? snapshot.id : task.resultRunId,
                      acceptedRunId: undefined,
                      ...(task.managedRunId && !snapshot.coordination ? {
                        managedStatus: snapshot.status === 'completed' ? 'review' as const
                          : ['failed', 'cancelled'].includes(snapshot.status) ? 'failed' as const : 'working' as const,
                        reviewNote: snapshot.error
                      } : {}),
                      state:
                        snapshot.status === 'completed'
                          ? 'review'
                          : ['failed', 'cancelled'].includes(snapshot.status)
                            ? 'ready'
                            : 'working'
                    }
                  : task
              )
            }
          })
        }))
      },
      editMessage: async (teamId, messageId, text) => {
        if (!text.trim() || text.length > 8000 || Object.values(get().runs).some((r) => r.workspaceId === teamId && isActive(r.status))) return
        const source = get().teams.find((t) => t.id === teamId)?.messages.find((m) => m.id === messageId && m.author === 'you')
        if (!source) return
        await get().send(teamId, source.to, source.taskId, { sourceId: source.id, editedText: text.trim() })
      },
      deleteMessage: (teamId, messageId) => {
        if (Object.values(get().runs).some((r) => r.workspaceId === teamId && isActive(r.status))) return
        const team = get().teams.find((t) => t.id === teamId)
        const message = team?.messages.find((m) => m.id === messageId)
        if (team && message && !message.toolPermission) set((s) => invalidateDeliveries(s, teamId, team.tasks.filter((task) =>
          task.id === message.taskId || (task.resultRunId && task.resultRunId === message.runId)).map((task) => task.id)))
        set((s) => ({ teams: s.teams.map((t) => {
          if (t.id !== teamId) return t
          const message = t.messages.find((m) => m.id === messageId)
          if (!message) return t
          return { ...t, messages: t.messages.filter((m) => m.id !== messageId),
            deletedMessageIds: [...new Set([...(t.deletedMessageIds || []), messageId, ...(message.runtimeReplyId ? [message.runtimeReplyId] : []), ...(message.runId && !message.toolPermission ? [`${message.runId}-${message.author}`] : [])])] }
        }) }))
      },
      retryMessage: async (teamId, messageId) => {
        if (Object.values(get().runs).some((run) => run.workspaceId === teamId && isActive(run.status))) return
        const team = get().teams.find((t) => t.id === teamId)
        const message = team?.messages.find((m) => m.id === messageId)
        if (!team || !message || message.author === 'system' || message.toolPermission) return
        const source = message.author === 'you' ? message : team.messages.find((m) =>
          m.author === 'you' && (message.sourceMessageId ? m.id === message.sourceMessageId : m.runId && m.runId === message.runId))
        if (!source) { set({ runtimeError: '原始用户消息已删除，无法重新生成。' }); return }
        const managedTask = message.taskId && team.tasks.find((task) => task.id === message.taskId && task.managedRunId)
        if (managedTask && !source.taskId && message.author !== 'you') {
          const parent = get().teams.find((item) => item.id === team.parentId)
          if (team.paused || parent?.paused) { set({ runtimeError: '项目或对话已暂停，请恢复后再执行。' }); return }
          set((state) => invalidateDeliveries(state, teamId, [managedTask.id]))
          const lead = team.members.find((member) => member.isLead)!
          await get().send(teamId, lead.id, undefined, undefined,
            `请重新指派并检查既有任务 ${managedTask.id}（${managedTask.title}），沿用当前上下文的原始需求，保留其他已经检查通过的成果。任务说明：${managedTask.description}`)
          return
        }
        await get().send(teamId, message.author === 'you' ? message.to : message.author, source.taskId,
          { sourceId: source.id, replyId: message.author === 'you' ? undefined : message.id }, undefined, message.interaction || source.interaction)
      },
      send: async (teamId, to, taskId, retry, taskInput, interaction) => {
        const generation = workspaceEpoch
        const state = get(),
          team = state.teams.find((t) => t.id === teamId),
          source = retry ? team?.messages.find((m) => m.id === retry.sourceId && m.author === 'you') : undefined,
          attachments = retry ? source?.attachments || [] : taskInput !== undefined ? [] : state.attachmentDrafts[teamId] || [],
          prompt = (retry ? retry.editedText ?? source?.text ?? '' : taskInput ?? state.drafts[teamId] ?? '').trim() || (attachments.length ? '请查看并分析附件。' : '')
        if (
          !team ||
          (retry && !source) ||
          !prompt
        )
          return
        const lead = team.members.find((member) => member.isLead)!
        const permissionMode = team.permissionMode ?? 'ask'
        const active = Object.values(state.runs).filter((run) => run.workspaceId === teamId && isActive(run.status))
        const work = active.find((run) => run.interaction !== 'conversation')
        if (!retry && !taskId && to === lead.id && work && isStopWorkMessage(prompt)) {
          get().saveMessage(teamId, to, taskInput)
          await get().stop(work.id)
          if (generation !== workspaceEpoch) return
          if (!isActive(get().runs[work.id]?.status)) {
            set((s) => ({ teams: s.teams.map((t) => t.id === teamId ? { ...t, messages: [...t.messages, {
              id: makeId('message'), author: 'system', to: lead.id, text: '已停止当前任务，已有结果保留。',
              time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), kind: 'message', sample: false, private: true
            }] } : t) }))
          }
          return
        }
        interaction ||= source?.interaction
        if (interaction === 'conversation' ? active.some((run) => run.interaction === 'conversation') : active.length > 0) return
        if (interaction === 'conversation' && (taskId || to !== lead.id)) return
        if (interaction === 'conversation' && attachments.length) {
          set({ runtimeError: '聊聊模式不处理附件，请移除附件，或等待后台任务结束后切换助手模式。' })
          return
        }
        const parent = state.teams.find((t) => t.id === team.parentId && t.kind === 'project')
        const task = taskId ? team.tasks.find((t) => t.id === taskId) : undefined
        if (team.paused || parent?.paused) { set({ runtimeError: '项目或对话已暂停，请恢复后再执行。' }); return }
        if (prompt.length > 8000) { set({ runtimeError: '消息不能超过 8000 字符。' }); return }
        if (taskId && (!task || task.dependencyError || !isValidTeam(team) || to !== task.owner || (!retry && task.state !== 'ready') ||
          taskDependencies(task).some((id) => team.tasks.find((item) => item.id === id)?.state !== 'done'))) {
          set({ runtimeError: '任务配置无效、负责人不匹配或前置任务尚未完成。' })
          return
        }
        const managed = interaction !== 'conversation' && !taskId && to !== 'all' && team.members.some((m) => m.id === to && m.isLead)
        const employees = managed || to === 'all' ? team.members : team.members.filter((m) => m.id === to)
        if (!employees.length) return
        const inspection = useProviders.getState()
        // A manager may keep unconfigured employees, but only its own account is needed to start.
        const recipients = managed ? employees.filter((employee) => employee.isLead) : employees
        if (inspection.checked || inspection.checking || inspection.diagnostics.length || inspection.error) {
          for (const employee of recipients) {
            const readiness = getProviderReadiness(inspection.diagnostics.find((provider) => provider.id === employee.provider), inspection)
            if (!readiness.canRun) {
              set({ runtimeError: `${employee.name}：${readiness.detail}` })
              return
            }
          }
        }
        const revoked = new Set<string>()
        if (task && (task.resultRunId || ['done', 'review'].includes(task.state))) revoked.add(task.id)
        if (retry?.editedText !== undefined) {
          const removed = team.messages.slice(team.messages.findIndex((m) => m.id === retry.sourceId) + 1)
          for (const item of team.tasks) if (removed.some((m) => m.taskId === item.id || (item.resultRunId && m.runId === item.resultRunId))) revoked.add(item.id)
        }
        if (revoked.size) set((s) => invalidateDeliveries(s, teamId, revoked))
        const id = makeId('run')
        const snapshot: RunSnapshot = {
          id,
          workspaceId: teamId,
          permissionMode,
          taskId,
          interaction,
          status: 'queued',
          replies: [],
          permissions: [],
          createdAt: new Date().toISOString(),
          contextTrimmed: false
        }
        if (!retry) get().saveMessage(teamId, to, taskInput)
        set((s) => ({
          runtimeError: null,
          runs: { ...s.runs, [id]: snapshot },
          ...(taskInput !== undefined && taskId && s.taskSchedules[teamId]?.status === 'running' && s.taskSchedules[teamId].remaining.includes(taskId)
            ? { taskSchedules: { ...s.taskSchedules, [teamId]: { ...s.taskSchedules[teamId], runId: id, taskId } } } : {}),
          teams: s.teams.map((t) => {
            if (t.id !== teamId) return t
            const editing = retry?.editedText !== undefined
            // An edited turn replaces the following branch before any new output arrives.
            const sourceIndex = editing ? t.messages.findIndex((m) => m.id === retry.sourceId) : -1
            const removed = editing ? t.messages.slice(sourceIndex + 1) : t.messages.filter((m) => m.id === retry?.replyId)
            const messages = editing ? t.messages.slice(0, sourceIndex + 1) : t.messages
            const deletedIds = removed.flatMap((m) => [
              ...(editing ? [m.id] : []), ...(m.runtimeReplyId ? [m.runtimeReplyId] : []), ...(m.runId ? [`${m.runId}-${m.author}`] : [])
            ])
            return {
                  ...t,
                  deletedMessageIds: deletedIds.length ? [...new Set([...(t.deletedMessageIds || []), ...deletedIds])] : t.deletedMessageIds,
                  tasks: t.tasks.map((task) =>
                    task.id === taskId ? { ...task, state: 'working', resultRunId: undefined, acceptedRunId: undefined,
                      ...(task.managedRunId ? { managedStatus: 'working' } : {}) } : task
                  ),
                  messages: messages.map((m, index) =>
                    retry?.replyId === m.id
                      ? { ...m, runId: id, runtimeReplyId: undefined, sourceMessageId: source!.id, status: 'queued', text: '', images: [], error: undefined, interaction, private: m.private || managed || interaction === 'conversation' }
                      : (retry ? !retry.replyId && m.id === retry.sourceId : index === t.messages.length - 1)
                      ? { ...m, text: editing ? prompt : m.text, runId: id, status: 'queued', taskId, error: undefined, interaction, private: managed || interaction === 'conversation' }
                      : retry && source?.runId && m.runId === source.runId && m.author !== 'you' ? { ...m, sourceMessageId: source.id } : m
                  )
                }
          })
        }))
        const history = retry ? historyForRetry(team.messages, retry.sourceId, retry.replyId) : team.messages
        const currentTeam = get().teams.find((t) => t.id === teamId)!
        const shared = collaborationContext(currentTeam, parent, history, taskId, parent ? state.teams.filter((t) => t.parentId === parent.id && t.id !== teamId) : [])
        const separated = separateAssistantContext(shared.context, history, lead.id)
        const request = {
          id,
          workspaceId: teamId,
          assetScopeId: assistantScopeId(team),
          permissionMode,
          directory: teamDirectory(state.teams, teamId),
          queue: true,
          prompt,
          attachments,
          ...(managed || interaction === 'conversation' ? { assistantScopeId: assistantScopeId(team) } : {}),
          interaction,
          employees: employees.map(({ avatar: _avatar, ...employee }) => {
            const profile = useAssistant.getState().snapshots[assistantScopeId(team)]?.profile
            return employee.isLead && profile && profile.updatedAt !== new Date(0).toISOString()
              ? { ...employee, name: profile.name, persona: profile.persona } : employee
          }),
          ...(managed ? { coordination: { leadId: to, previousTasks: currentTeam.tasks.filter((task) => task.managedRunId).slice(-100).map((task) => {
            const output = [...currentTeam.messages].reverse().find((message) => message.taskId === task.id &&
              message.runId === (task.resultRunId || task.managedRunId) && message.author !== 'you' && !message.toolPermission)
            return {
            id: task.id, title: task.title, description: task.description, acceptance: task.acceptance, owner: task.owner,
            dependencies: taskDependencies(task),
            status: task.state === 'done' ? 'completed' as const : task.managedStatus || 'ready' as const,
            attempts: 0, review: task.reviewNote, replyId: output?.runtimeReplyId || output?.id
          } }) } } : {}),
          ...shared,
          context: separated.context,
          ...(managed || interaction === 'conversation' ? { privateContext: separated.privateContext } : {})
        }
        try {
          const result = await runtimeClient.start(request)
          if (generation !== workspaceEpoch) return
          get().applyRun(result)
          void watchRun(id)
        } catch (error) {
          if (generation !== workspaceEpoch) return
          // A response can be lost after the server accepted a request; never replay automatically.
          try {
            const result = await runtimeClient.run(id)
            if (generation !== workspaceEpoch) return
            get().applyRun(result)
            void watchRun(id)
          } catch (recoveryError) {
            if (generation !== workspaceEpoch) return
            if (recoveryError instanceof Error && recoveryError.message.includes(RUN_EXPIRED_MESSAGE)) {
              get().applyRun({
                ...snapshot, status: 'failed', error: error instanceof Error ? error.message : '发送失败，请重试'
              })
              if (!retry && taskInput === undefined) set((s) => ({
                drafts: { ...s.drafts, [teamId]: s.drafts[teamId] || prompt },
                attachmentDrafts: { ...s.attachmentDrafts, [teamId]: s.attachmentDrafts[teamId]?.length ? s.attachmentDrafts[teamId] : attachments }
              }))
            } else {
              set((s) => ({ connectionErrors: { ...s.connectionErrors, [id]: '发送结果待确认，正在重连；不会自动重发。' } }))
              void watchRun(id)
            }
          }
        }
        return id
      },
      stop: async (id) => {
        const generation = workspaceEpoch
        if (get().stoppingRuns[id]) return
        set((s) => ({ stoppingRuns: { ...s.stoppingRuns, [id]: true }, runtimeError: null,
          taskSchedules: Object.fromEntries(Object.entries(s.taskSchedules).map(([teamId, schedule]) =>
            [teamId, schedule.runId === id ? { ...schedule, status: 'paused' as const } : schedule])) }))
        try {
          const result = await runtimeClient.cancel(id)
          if (generation === workspaceEpoch) get().applyRun(result)
        } catch (e) {
          if (generation === workspaceEpoch) set({ runtimeError: e instanceof Error ? e.message : '停止失败' })
        } finally {
          if (generation === workspaceEpoch) set((s) => {
            const stoppingRuns = { ...s.stoppingRuns }
            delete stoppingRuns[id]
            return { stoppingRuns }
          })
        }
      },
      answerPermission: async (id, permissionId, option) => {
        const generation = workspaceEpoch
        try {
          await runtimeClient.permission(id, permissionId, option)
          if (generation !== workspaceEpoch) return
          const result = await runtimeClient.run(id)
          if (generation === workspaceEpoch) get().applyRun(result)
        } catch (e) {
          if (generation === workspaceEpoch) set({ runtimeError: e instanceof Error ? e.message : '权限请求已失效' })
        }
      },
      setCreatingProject: (creatingProject) => set({ creatingProject }),
      setDefaultProvider: (defaultProvider) => {
        if (PROVIDER_IDS.includes(defaultProvider)) set({ defaultProvider })
      },
      setSurface: (surface) => set({ surface }),
      navigate: (page, teamId) => {
        // Gallery workspaces retain execution history, but are never opened as conversations.
        if (teamId && get().teams.find((team) => team.id === teamId)?.gallery) {
          set({ page: 'gallery', surface: 'workspace' })
        } else set({ page, surface: 'workspace', ...(teamId ? { activeTeamId: teamId } : {}) })
      },
      setDraft: (teamId, value) => set((s) => s.teams.some((t) => t.id === teamId) ? ({ drafts: { ...s.drafts, [teamId]: value } }) : s),
      setPermissionMode: (teamId, permissionMode) => {
        if (!['ask', 'review', 'auto'].includes(permissionMode)) return
        set((s) => ({ teams: s.teams.map((team) => team.id === teamId ? { ...team, permissionMode } : team) }))
      },
      createWorkspace: (kind, name = '', goal = '', parentId, directory) => {
        if (kind === 'project' && !isAbsoluteDirectory(directory))
          throw new Error('请先选择或创建项目目录。')
        const parent = get().teams.find((t) => t.id === parentId && t.kind === 'project')
        const workspace = createWorkspace(
          kind,
          get().defaultProvider,
          name,
          goal,
          kind === 'conversation' ? parent : undefined,
          directory
        )
        const id = workspace.id
        if (!parent)
          workspace.members = workspace.members.map((m) => ({
            ...m,
            ...get().modelDefaults[m.provider]
          }))
        set((s) => ({
          teams: [...s.teams, workspace],
          activeTeamId: id,
          page: 'team',
          surface: 'workspace',
          creatingProject: false
        }))
        return id
      },
      generateImages: async (input, provider, ratio, count, reference) => {
        const generation = workspaceEpoch
        const prompt = input.trim()
        if (!prompt || prompt.length > 6000 || !PROVIDER_IDS.includes(provider) || !['auto', '1:1', '3:2', '2:3', '16:9', '9:16'].includes(ratio) || ![1, 2, 4].includes(count)) return
        const data = reference ? await galleryImageData(reference) : undefined
        if (generation !== workspaceEpoch) return
        if (data && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(data)) throw new Error('编辑原图需要 PNG、JPEG、GIF 或 WebP 格式。')
        const team = createWorkspace('conversation', provider, `画廊 · ${prompt.slice(0, 30)}`)
        team.gallery = { prompt, ratio, count: reference ? 1 : count, createdAt: new Date().toISOString() }
        team.members = team.members.map((m) => ({ ...m, ...get().modelDefaults[m.provider] }))
        const request = reference
          ? `请实际调用图片编辑工具，以附件中的原图为基础，按以下要求编辑，返回 1 张编辑后的图片。${ratio === 'auto' ? '保留原图宽高比。' : `宽高比 ${ratio}。`}保留未要求修改的内容。若当前服务不支持图片编辑，请明确说明。\n\n编辑要求：\n${prompt}`
          : `请实际调用图片生成工具，生成 ${count} 张独立图片${ratio === 'auto' ? '，宽高比由你决定' : `，宽高比 ${ratio}`}。请返回每张图片，勿拼成一张图。若当前服务不支持图片生成，请明确说明。\n\n图片描述：\n${prompt}`
        const attachment = data ? await runtimeClient.upload(team.id, { name: 'original.png', data: data.slice(data.indexOf(',') + 1) }) : undefined
        if (generation !== workspaceEpoch) return
        set((s) => ({ teams: [...s.teams, team], drafts: { ...s.drafts, [team.id]: request },
          ...(attachment ? { attachmentDrafts: { ...s.attachmentDrafts, [team.id]: [attachment] } } : {}), page: 'gallery', surface: 'workspace' }))
        await get().send(team.id, team.members[0].id)
      },
      saveEmployee: (id, employee) =>
        set((s) => ({
          teams: s.teams.map((t) => {
            if (t.id !== id) return t
            const candidate = {
              ...t,
              defaultProvider: employee.isLead ? employee.provider : t.defaultProvider,
              members: t.members.some((m) => m.id === employee.id)
                ? t.members.map((m) => (m.id === employee.id ? employee : m))
                : [...t.members, employee]
            }
            return isValidTeam(candidate) ? candidate : t
          })
        })),
      removeEmployee: (id, employeeId) =>
        set((s) => ({
          teams: s.teams.map((t) =>
            t.id === id &&
            !Object.values(s.runs).some((r) => r.workspaceId === id && isActive(r.status)) &&
            !employeeReferenced(t, employeeId) &&
            !t.members.find((m) => m.id === employeeId)?.isLead
              ? { ...t, members: t.members.filter((m) => m.id !== employeeId) }
              : t
          )
        })),
      updateTeam: (id, name, goal, members, directory) => {
        const current = get().teams.find((t) => t.id === id)
        if (directory !== undefined && directory !== current?.directory) {
          if (!isAbsoluteDirectory(directory) || current?.kind !== 'project' || current.directory)
            throw new Error('项目目录无效。')
          const related = new Set(get().teams.filter((t) => t.id === id || t.parentId === id).map((t) => t.id))
          if (Object.values(get().runs).some((r) => related.has(r.workspaceId) && isActive(r.status)))
            throw new Error('请等待项目及其对话中的执行结束后再设置目录。')
        }
        set((s) => ({
          teams: s.teams.map((t) => {
            if (directory && t.parentId === id) return { ...t, directory }
            if (t.id !== id) return t
            const candidate = { ...t, name: name.trim(), goal: goal.trim(), members, directory: directory ?? t.directory }
            return candidate.name && isValidTeam(candidate) ? candidate : t
          })
        }))
      },
      togglePause: (teamId) =>
        set((s) => ({
          teams: s.teams.map((t) => (t.id === teamId ? { ...t, paused: !t.paused } : t))
        })),
      saveMessage: (teamId, to, taskInput) => {
        const attachments = taskInput !== undefined ? [] : get().attachmentDrafts[teamId] || []
        const text = (taskInput ?? get().drafts[teamId] ?? '').trim() || (attachments.length ? '请查看并分析附件。' : '')
        if (!text) return
        if (
          to !== 'all' &&
          !get()
            .teams.find((t) => t.id === teamId)
            ?.members.some((m) => m.id === to)
        )
          return
        set((s) => ({
          drafts: taskInput !== undefined ? s.drafts : { ...s.drafts, [teamId]: '' },
          attachmentDrafts: taskInput !== undefined ? s.attachmentDrafts : { ...s.attachmentDrafts, [teamId]: [] },
          teams: s.teams.map((t) =>
            t.id === teamId
              ? {
                  ...t,
                  name:
                    t.kind === 'conversation' && t.name === '新对话' && !t.messages.length
                      ? text.slice(0, 32).replace(/\s+/g, ' ')
                      : t.name,
                  messages: [
                    ...t.messages,
                    {
                      id: makeId('message'),
                      author: 'you',
                      attachments: attachments.length ? attachments : undefined,
                      text,
                      to,
                      kind: 'message',
                      sample: false,
                      time: new Date().toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })
                    }
                  ]
                }
              : t
          )
        }))
      },
      saveTask: (teamId, task) => {
        const team = get().teams.find((t) => t.id === teamId)
        if (!team) return false
        task = { ...task, dependencyError: undefined }
        const previousTask = team.tasks.find((item) => item.id === task.id)
        const scopeChanged = previousTask && (['title', 'description', 'owner', 'dependency', 'acceptance'].some((key) =>
          previousTask[key as keyof TeamTask] !== task[key as keyof TeamTask]) ||
          JSON.stringify(taskDependencies(previousTask)) !== JSON.stringify(taskDependencies(task)))
        if (scopeChanged && (previousTask.resultRunId || ['done', 'review'].includes(previousTask.state)))
          task = { ...task, state: 'ready', resultRunId: undefined, acceptedRunId: undefined,
            ...(task.managedRunId ? { managedStatus: 'failed', reviewNote: undefined } : {}) }
        task = { ...task, acceptedRunId: task.state === 'done' ? task.resultRunId : undefined }
        let affected = new Set([task.id])
        const invalidated = scopeChanged || (previousTask?.state === 'done' && task.state !== 'done')
        if (invalidated) affected = affectedTasks(team, affected)
        const busy = Object.values(get().runs).some((run) => run.workspaceId === teamId && run.coordination && isActive(run.status)) ||
          team.messages.some((m) => m.taskId && affected.has(m.taskId) && m.runId && isActive(get().runs[m.runId]?.status))
        const candidate = { ...team, tasks: team.tasks.some((t) => t.id === task.id)
          ? team.tasks.map((t) => t.id === task.id ? task : invalidated && affected.has(t.id)
            ? { ...t, state: 'ready' as const, resultRunId: undefined, acceptedRunId: undefined,
              ...(t.managedRunId ? { managedStatus: 'failed' as const, reviewNote: undefined } : {}) } : t) : [...team.tasks, task] }
        if (busy || !task.title.trim() || !isValidTeam(candidate)) {
          set({ runtimeError: busy ? '任务或受影响的后续任务正在执行，请先停止。' : '任务负责人或依赖配置无效。' })
          return false
        }
        set((s) => ({ teams: s.teams.map((t) => t.id === teamId ? candidate : t), runtimeError: null,
          ...(invalidated && s.taskSchedules[teamId] ? { taskSchedules: { ...s.taskSchedules, [teamId]: {
            ...s.taskSchedules[teamId], status: 'paused' as const,
            remaining: [...new Set([...s.taskSchedules[teamId].remaining, ...candidate.tasks.filter((t) => affected.has(t.id) && t.state === 'ready').map((t) => t.id)])]
          } } } : {}) }))
        return true
      },
      addArtifact: (teamId, artifact) =>
        set((s) => ({
          teams: s.teams.map((t) =>
            t.id === teamId
              ? {
                  ...t,
                  artifacts: [...t.artifacts, { ...artifact, id: makeId('artifact') }]
                }
              : t
          )
        }))
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 2,
      migrate: migrateWorkspace,
      storage: workspaceStorage,
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          workspaceStorageStatus.update({ phase: 'error', error: error instanceof Error ? error.message : '工作区读取失败，原数据已保留。' })
          void workspaceDatabase?.getPrevious(WORKSPACE_STORAGE_KEY).then((previous) => {
            workspaceStorageStatus.update({ previousAvailable: !!previous })
          }).catch(() => {})
          return
        }
        // Commit normalized startup state before rendering or accepting edits.
        // In particular, old running task schedules are persisted as paused.
        if (workspaceDatabase) queueMicrotask(() => {
          useCollaboration.setState({})
          void workspaceStorage.flush().then(() => reconcilePortableWorkspace(savedWorkspace(useCollaboration.getState()), true))
            .then(() => workspaceStorageStatus.update({ phase: 'ready', error: null }))
            .catch((cause) => workspaceStorageStatus.update({ phase: 'error', error: cause instanceof Error ? cause.message : '工作区保存失败。' }))
        })
        else workspaceStorageStatus.update({ phase: 'ready' })
      },
      partialize: (s) => ({
        teams: s.teams,
        drafts: s.drafts,
        attachmentDrafts: s.attachmentDrafts,
        activeTeamId: s.activeTeamId,
        defaultProvider: s.defaultProvider,
        modelDefaults: s.modelDefaults,
        taskSchedules: s.taskSchedules,
        deletedGalleryKeys: s.deletedGalleryKeys
      }),
      merge: (saved, current) => {
        const value = saved as Partial<CollaborationState> | null
        // Discard malformed snapshots instead of breaking startup; only persist frontend-owned data.
        if (
          !value ||
          !Array.isArray(value.teams) ||
          !value.teams.length ||
          !value.teams.every((team) => isValidTeam(team, false)) ||
          new Set(value.teams.map((t) => t.id)).size !== value.teams.length ||
          value.teams.some(
            (t) =>
              t.parentId !== null &&
              (t.kind !== 'conversation' ||
                !value.teams!.some((p) => p.id === t.parentId && p.kind === 'project'))
          )
        )
          return current
        const recovered = value.teams.map((team) => recoverTaskGraph({ ...team, permissionMode: team.permissionMode ?? 'ask' }))
        const teams = recovered.some((team) => !team.gallery) ? recovered : [...recovered, ...seedTeams()]
        const savedGalleryActive = value.teams.some((team) => team.id === value.activeTeamId && team.gallery)
        return {
          ...current,
          teams,
          ...(savedGalleryActive ? { page: 'gallery' as const } : {}),
          deletedGalleryKeys: Array.isArray(value.deletedGalleryKeys) ? value.deletedGalleryKeys.filter((key) => typeof key === 'string') : [],
          taskSchedules: value.taskSchedules && typeof value.taskSchedules === 'object'
            ? Object.fromEntries(Object.entries(value.taskSchedules).filter(([id, schedule]) =>
              value.teams!.some((team) => team.id === id) && schedule && Array.isArray(schedule.remaining) &&
              schedule.remaining.every((id) => typeof id === 'string') &&
              (schedule.runId === undefined || typeof schedule.runId === 'string') &&
              (schedule.taskId === undefined || typeof schedule.taskId === 'string'))
              .map(([id, schedule]) => [id, { ...schedule, status: schedule.status === 'completed' ? 'completed' : 'paused' }]))
            : {},
          attachmentDrafts: value.attachmentDrafts && typeof value.attachmentDrafts === 'object'
            ? Object.fromEntries(Object.entries(value.attachmentDrafts).filter(([id, files]) =>
              value.teams!.some((t) => t.id === id) && Array.isArray(files) && files.length <= MAX_ATTACHMENTS && files.every(isWorkspaceAttachment))) : {},
          modelDefaults:
            value.modelDefaults && typeof value.modelDefaults === 'object'
              ? Object.fromEntries(
                  Object.entries(value.modelDefaults).filter(
                    ([key, v]) =>
                      PROVIDER_IDS.includes(key as Provider) &&
                      v &&
                      (v.model === undefined || typeof v.model === 'string') &&
                      (v.effort === undefined || typeof v.effort === 'string')
                  )
                )
              : {},
          defaultProvider:
            value.defaultProvider && PROVIDER_IDS.includes(value.defaultProvider)
              ? value.defaultProvider
              : 'grok',
          activeTeamId: teams.some((t) => t.id === value.activeTeamId && !t.gallery)
            ? value.activeTeamId!
            : teams.find((team) => !team.gallery)!.id,
          drafts:
            value.drafts && typeof value.drafts === 'object'
              ? Object.fromEntries(
                  Object.entries(value.drafts).filter(([, v]) => typeof v === 'string')
                )
              : {}
        }
      }
    }
  )
)

export const isActive = (status: RunStatus) =>
  ['queued', 'running', 'needs_permission'].includes(status)
const watching = new Set<string>()
const polling = new Map<string, Promise<RunSnapshot | null>>()
export function refreshRun(id: string): Promise<RunSnapshot | null> {
  const generation = workspaceEpoch
  const pending = polling.get(id)
  if (pending) return pending
  const request = (async () => {
    try {
      const snapshot = await runtimeClient.run(id)
      if (generation !== workspaceEpoch) return null
      useCollaboration.getState().applyRun(snapshot)
      if (useCollaboration.getState().connectionErrors[id]) {
        const errors = { ...useCollaboration.getState().connectionErrors }
        delete errors[id]
        useCollaboration.setState({ connectionErrors: errors })
      }
      return useCollaboration.getState().runs[id] || snapshot
    } catch (error) {
      if (generation !== workspaceEpoch) return null
      const state = useCollaboration.getState()
      const previous = state.runs[id]
      if (error instanceof Error && error.message.includes(RUN_EXPIRED_MESSAGE)) {
        if (previous && isActive(previous.status)) {
          state.applyRun({ ...previous, revision: undefined, status: 'failed', permissions: [], error: RUN_EXPIRED_MESSAGE,
            replies: previous.replies.map((r) => isActive(r.status) ? { ...r, status: 'failed', error: RUN_EXPIRED_MESSAGE } : r) })
        }
        return useCollaboration.getState().runs[id] || null
      }
      // Transport failure does not prove that the agent stopped writing files.
      const message = '连接中断，正在重连；执行状态待确认，请勿重复发送。'
      if (previous && isActive(previous.status) && state.connectionErrors[id] !== message)
        useCollaboration.setState({ connectionErrors: { ...state.connectionErrors, [id]: message } })
      return null
    }
  })().finally(() => polling.delete(id))
  polling.set(id, request)
  return request
}
async function watchRun(id: string) {
  const generation = workspaceEpoch
  if (watching.has(id)) return
  watching.add(id)
  let failures = 0
  try {
    while (generation === workspaceEpoch) {
      const snapshot = await refreshRun(id)
      failures = snapshot ? 0 : failures + 1
      if (snapshot && !isActive(snapshot.status)) break
      const current = useCollaboration.getState().runs[id]
      if (!current || !isActive(current.status)) break
      await new Promise((resolve) => setTimeout(resolve,
        failures ? Math.min(10000, 1000 * 2 ** Math.min(failures, 4)) : snapshot?.status === 'needs_permission' ? 2000 : 150))
    }
  } finally {
    watching.delete(id)
  }
}
export function resumeRuns() {
  const state = useCollaboration.getState()
  for (const team of state.teams)
    for (const message of team.messages) {
      if (
        !message.runId ||
        isRestoredRunId(message.runId) ||
        !message.status ||
        !isActive(message.status)
      )
        continue
      if (!useCollaboration.getState().runs[message.runId]) {
        const snapshot: RunSnapshot = {
          id: message.runId,
          workspaceId: team.id,
          interaction: message.interaction,
          status: message.status,
          replies: team.messages.filter((m) => m.runId === message.runId && !m.toolPermission && team.members.some((e) => e.id === m.author)).map((m) => ({
            id: m.runtimeReplyId || m.id, taskId: m.taskId, kind: m.kind,
            employeeId: m.author, provider: team.members.find((e) => e.id === m.author)!.provider,
            text: m.text, model: m.model || '', status: m.status || 'running', images: m.images,
            cwd: m.cwd, sessionId: m.sessionId, error: m.error, effort: m.effort
          })),
          permissions: [],
          createdAt: new Date().toISOString(),
          contextTrimmed: false
        }
        useCollaboration.setState((s) => ({ runs: { ...s.runs, [snapshot.id]: snapshot } }))
      }
      void watchRun(message.runId)
    }
}

export function reconnectRun(id: string) {
  if (isRestoredRunId(id)) return
  const state = useCollaboration.getState()
  const team = state.teams.find((t) => t.messages.some((m) => m.runId === id))
  if (!team) return
  const existing = state.runs[id]
  const snapshot: RunSnapshot =
    existing || {
          id,
          workspaceId: team.id,
          status: 'queued',
          replies: [],
          permissions: [],
          createdAt: new Date().toISOString(),
          contextTrimmed: false
        }
  useCollaboration.setState((s) => ({ runs: { ...s.runs, [id]: snapshot } }))
  void refreshRun(id)
  void watchRun(id)
}

const taskPumps = new Map<string, number>()
let taskPumpQueued = false
function requestTaskPump() {
  if (taskPumpQueued || workspaceStorageStatus.getSnapshot().closing) return
  taskPumpQueued = true
  queueMicrotask(() => {
    taskPumpQueued = false
    for (const [teamId, schedule] of Object.entries(useCollaboration.getState().taskSchedules))
      if (['running', 'waiting_review'].includes(schedule.status) && taskPumps.get(teamId) !== workspaceEpoch) void advanceTaskSchedule(teamId)
  })
}

async function advanceTaskSchedule(teamId: string) {
  const generation = workspaceEpoch
  taskPumps.set(teamId, generation)
  let advanced = false
  const update = (patch: Partial<TaskSchedule>) => generation === workspaceEpoch && useCollaboration.setState((state) => ({
    taskSchedules: { ...state.taskSchedules, [teamId]: { ...state.taskSchedules[teamId], ...patch } }
  }))
  try {
    let state = useCollaboration.getState()
    let schedule = state.taskSchedules[teamId]
    let team = state.teams.find((item) => item.id === teamId)
    if (!team || !schedule || !['running', 'waiting_review'].includes(schedule.status)) return
    if (team.paused || state.teams.find((item) => item.id === team!.parentId)?.paused) { update({ status: 'paused' }); return }
    if (schedule.runId) {
      const run = state.runs[schedule.runId]
      if (!run || isActive(run.status)) return
      if (run.status !== 'completed') {
        update({ status: 'failed', error: run.error || '任务执行中断，请检查后继续。' }); return
      }
      update({ remaining: schedule.remaining.filter((id) => id !== schedule.taskId), runId: undefined, taskId: undefined })
      state = useCollaboration.getState()
      schedule = state.taskSchedules[teamId]
      team = state.teams.find((item) => item.id === teamId)!
    }
    if (Object.values(state.runs).some((run) => run.workspaceId === teamId && isActive(run.status))) return
    const next = selectScheduledTask(team, schedule.remaining)
    if (next.error) { update({ status: 'failed', error: next.error }); return }
    if (!next.pending?.length) { update({ status: 'completed', remaining: [], error: undefined }); return }
    if (!next.task) {
      if (schedule.status !== 'waiting_review') update({ status: 'waiting_review' })
      return
    }
    update({ status: 'running', error: undefined })
    const runId = await useCollaboration.getState().executeTask(teamId, next.task.id)
    if (generation !== workspaceEpoch) return
    const latest = useCollaboration.getState().taskSchedules[teamId]
    if (!latest) return
    if (!runId) { update({ status: 'failed', error: useCollaboration.getState().runtimeError || '任务尚未发送，请检查配置。' }); return }
    update({ runId, taskId: next.task.id })
    if (latest.status === 'paused') await useCollaboration.getState().stop(runId)
    advanced = true
  } catch (error) {
    update({ status: 'failed', error: error instanceof Error ? error.message : '任务调度失败' })
  } finally {
    if (taskPumps.get(teamId) === generation) taskPumps.delete(teamId)
    if (advanced) requestTaskPump()
  }
}

useCollaboration.subscribe((state, previous) => {
  if (state.teams !== previous.teams || state.runs !== previous.runs || state.taskSchedules !== previous.taskSchedules)
    requestTaskPump()
})
