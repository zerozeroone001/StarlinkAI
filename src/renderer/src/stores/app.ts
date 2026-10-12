import { create } from 'zustand'
import { useCollaboration } from './collaboration'
import { runtimeClient } from '@/lib/runtime-client'
import { teamDirectory } from '@/lib/collaboration-data'
import { pathKey } from '@/lib/format'
import {
  BUILTIN_PETS,
  DEFAULT_PET_ID,
  type AuthInfo,
  type AppSnapshot,
  type ChatMessage,
  type CreateSkillResult,
  type Effort,
  type FileNode,
  type FilePreview,
  type GitState,
  type HistoryCursor,
  type HistoryPage,
  type Locale,
  type PermissionMode,
  type PermissionRequest,
  type PetActionDraft,
  type PetDraft,
  type PetInfo,
  type PetSnapshot,
  type PlanItem,
  type Project,
  type PromptAttachment,
  type RightTab,
  type RunMode,
  type SettingsTab,
  type SkillInfo,
  type SkillScope,
  type Theme,
  type ThreadMeta
} from '@shared/types'
import {
  NEW_THREAD_KEY,
  applySessionUpdate,
  emptyRuntime,
  finishRun,
  mergeDiskThreads,
  uid,
  withThreadStatus,
  type ThreadRuntime
} from '@/lib/session-runtime'

let hydrateOnce = false
let newThreadEpoch = 0
let openThreadEpoch = 0
let filePreviewEpoch = 0
let skillsLoadEpoch = 0
const historyLoads = new Map<string, Promise<HistoryPage>>()
const sessionLoads = new Map<string, Promise<string>>()
const loadedSessions = new Set<string>()
const sending = new Set<string>()

function historyKey(id: string, cwd: string, cursor?: HistoryCursor | null): string {
  return `${cwd}\u0000${id}\u0000${cursor ? JSON.stringify(cursor) : 'latest'}`
}

function loadHistoryOnce(id: string, cwd: string, cursor?: HistoryCursor | null): Promise<HistoryPage> {
  const key = historyKey(id, cwd, cursor)
  const pending = historyLoads.get(key)
  if (pending) return pending
  const request = window.grok.history(id, cwd, cursor).finally(() => historyLoads.delete(key))
  historyLoads.set(key, request)
  return request
}

function ensureSessionLoaded(id: string, cwd: string): Promise<string> {
  if (loadedSessions.has(id)) return Promise.resolve(id)
  const pending = sessionLoads.get(id)
  if (pending) return pending
  const request = window.grok.acp
    .loadSession(id, cwd)
    .then(({ sessionId }) => {
      const loadedId = sessionId || id
      loadedSessions.add(loadedId)
      return loadedId
    })
    .finally(() => sessionLoads.delete(id))
  sessionLoads.set(id, request)
  return request
}

function storedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const saved = localStorage.getItem(key)
    if (!saved?.trim()) return fallback
    const n = Number(saved)
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n))
  } catch {
    /* ignore */
  }
  return fallback
}

function viewOf(rt: ThreadRuntime) {
  return {
    messages: rt.messages,
    running: rt.running,
    plan: rt.plan,
    permission: rt.permission,
    hasMoreHistory: rt.hasMoreHistory,
    loadingHistory: rt.loadingHistory
  }
}

async function petInvoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const pets = window.grok?.pets as unknown as Record<string, unknown> | undefined
  const fn = pets?.[method]
  if (typeof fn === 'function') return (fn as (...a: unknown[]) => Promise<T>)(...args)
  const channel = `pets:${method}`
  if (typeof window.grok?.invoke === 'function') return (await window.grok.invoke(channel, ...args)) as T
  throw new Error('Please fully quit and reopen StarlinkAI, then try again.')
}

function persistPrefs(patch: {
  theme?: Theme
  locale?: Locale
  permissionMode?: PermissionMode
  model?: string
  effort?: Effort
  wallpaperOpacity?: number
}): void {
  if (typeof window.grok?.savePrefs !== 'function') {
    try { localStorage.setItem('grok.previewPrefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('grok.previewPrefs') || '{}'), ...patch })) } catch { /* state remains usable */ }
    return
  }
  void window.grok.savePrefs(patch).catch(() => undefined)
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

interface AppState {
  theme: Theme
  locale: Locale
  wallpaperName: string | null
  wallpaperOpacity: number
  wallpaperDataUrl: string | null
  ready: boolean
  startupError: string | null
  desktopStateHealth: AppSnapshot['desktopStateHealth'] | null
  auth: AuthInfo
  grokPath: string | null
  grokVersion: string | null
  connected: boolean
  model: string
  effort: Effort
  runMode: RunMode
  permissionMode: PermissionMode
  projects: Project[]
  threads: ThreadMeta[]
  activeThreadId: string | null
  cwd: string
  messages: ChatMessage[]
  draft: string
  running: boolean
  hasMoreHistory: boolean
  loadingHistory: boolean
  plan: PlanItem[]
  git: GitState | null
  tree: FileNode[]
  rightOpen: boolean
  rightTab: RightTab
  sidebarCollapsed: boolean
  sidebarWidth: number
  rightWidth: number
  paletteOpen: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  skillsOpen: boolean
  skills: SkillInfo[]
  petAwake: boolean
  petId: string
  pets: PetInfo[]
  permission: PermissionRequest | null
  previewPath: string | null
  preview: FilePreview | null
  error: string | null
  runtimes: Record<string, ThreadRuntime>
  drafts: Record<string, string>

  hydrate: () => Promise<void>
  setTheme: (theme: Theme) => void
  setLocale: (locale: Locale) => void
  setDraft: (v: string) => void
  setModel: (v: string) => void
  setEffort: (v: Effort) => void
  setRunMode: (v: RunMode) => void
  setPermissionMode: (v: PermissionMode) => void
  setWallpaperOpacity: (n: number) => void
  chooseWallpaper: () => Promise<void>
  clearWallpaper: () => Promise<void>
  setRightOpen: (v: boolean) => void
  setRightTab: (v: RightTab) => void
  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setRightWidth: (w: number) => void
  setPalette: (v: boolean) => void
  setSettings: (v: boolean, tab?: SettingsTab) => void
  setSettingsTab: (tab: SettingsTab) => void
  setSkillsOpen: (v: boolean) => void
  loadSkills: (cwd?: string) => Promise<void>
  setSkillDisabled: (name: string, disabled: boolean) => Promise<void>
  createSkill: (input: { name: string; description: string; scope: SkillScope }) => Promise<CreateSkillResult>
  runSkill: (skill: SkillInfo) => void
  wakePet: () => Promise<void>
  tuckPet: () => Promise<void>
  selectPet: (id: string) => Promise<void>
  applyPetPrefs: (pet: { awake: boolean; petId: string; pets?: PetInfo[] }) => void
  applyPetSnapshot: (snap: PetSnapshot) => void
  createPet: (draft: PetDraft) => Promise<PetSnapshot>
  updatePet: (id: string, draft: PetDraft) => Promise<PetSnapshot>
  deletePet: (id: string) => Promise<PetSnapshot>
  addPetAction: (petId: string, draft: PetActionDraft) => Promise<PetSnapshot>
  updatePetAction: (petId: string, actionId: string, draft: PetActionDraft) => Promise<PetSnapshot>
  removePetAction: (petId: string, actionId: string) => Promise<PetSnapshot>
  playPetAction: (actionId: string, petId?: string) => Promise<void>
  newThread: (cwd?: string) => Promise<void>
  focusProject: (path: string) => Promise<void>
  openThread: (thread: ThreadMeta) => Promise<void>
  loadOlderMessages: () => Promise<void>
  addProject: () => Promise<void>
  renameProject: (projectPath: string, name: string) => Promise<void>
  removeProject: (projectPath: string) => Promise<void>
  renameThread: (thread: ThreadMeta, title: string) => Promise<void>
  deleteThread: (thread: ThreadMeta) => Promise<void>
  refreshGit: () => Promise<void>
  refreshWorkspace: (cwd?: string) => Promise<void>
  send: (text?: string, files?: PromptAttachment[]) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (optionId: string) => Promise<void>
  openPreview: (path: string) => Promise<void>
  closePreview: () => void
  applyUpdate: (update: Record<string, unknown>) => void
  applyPermission: (req: PermissionRequest) => void
  onAgentDisconnected: () => void
}

export const useApp = create<AppState>((set, get) => ({
  theme: 'dark',
  locale: 'en',
  wallpaperName: null,
  wallpaperOpacity: 40,
  wallpaperDataUrl: null,
  ready: false,
  auth: { email: null, name: null, userId: null, signedIn: false },
  grokPath: null,
  grokVersion: null,
  connected: false,
  model: 'grok-4.6',
  effort: 'xhigh',
  runMode: 'local',
  permissionMode: 'ask',
  projects: [],
  threads: [],
  activeThreadId: null,
  cwd: '',
  messages: [],
  draft: '',
  running: false,
  hasMoreHistory: false,
  loadingHistory: false,
  plan: [],
  git: null,
  tree: [],
  rightOpen: true,
  rightTab: 'review',
  sidebarCollapsed: false,
  sidebarWidth: 268,
  rightWidth: 360,
  paletteOpen: false,
  settingsOpen: false,
  settingsTab: 'providers',
  skillsOpen: false,
  skills: [],
  petAwake: false,
  petId: DEFAULT_PET_ID,
  pets: [...BUILTIN_PETS],
  permission: null,
  previewPath: null,
  preview: null,
  error: null,
  runtimes: {},
  drafts: {},

  startupError: null,
  desktopStateHealth: null,
  hydrate: async () => {
    if (hydrateOnce || get().ready) return
    hydrateOnce = true
    set({ startupError: null })
    if (typeof window.grok === 'undefined') {
      let prefs: Record<string, unknown> = {}
      try { const saved = JSON.parse(localStorage.getItem('grok.previewPrefs') || '{}'); if (saved && typeof saved === 'object') prefs = saved } catch { /* use defaults */ }
      const locale = prefs.locale === 'en' ? 'en' : 'zh-CN'
      const theme = prefs.theme === 'light' ? 'light' : 'dark'
      set({ ready: true, error: null, locale, theme })
      applyTheme(theme)
      document.documentElement.lang = locale
      return
    }
    let snap: Awaited<ReturnType<typeof window.grok.snapshot>>
    try { snap = await window.grok.snapshot() }
    catch (error) {
      hydrateOnce = false
      set({ startupError: error instanceof Error ? error.message : '无法读取本机配置，请重试。' })
      return
    }
    const cwd = snap.projects[0]?.path || ''
    applyTheme(snap.theme)
    document.documentElement.lang = snap.locale === 'zh-CN' ? 'zh-CN' : 'en'
    set({
      ready: true,
      desktopStateHealth: snap.desktopStateHealth || null,
      auth: snap.auth,
      grokPath: snap.grokPath,
      grokVersion: snap.grokVersion,
      connected: snap.connected,
      theme: snap.theme,
      locale: snap.locale,
      permissionMode: snap.permissionMode,
      model: snap.model,
      effort: snap.effort,
      projects: snap.projects,
      threads: snap.threads,
      wallpaperName: snap.wallpaper?.name || null,
      wallpaperOpacity: snap.wallpaper?.opacity ?? 40,
      wallpaperDataUrl: null,
      cwd,
      skills: snap.skills || [],
      petAwake: Boolean(snap.pet?.awake),
      petId: snap.pet?.petId || DEFAULT_PET_ID,
      pets: snap.pet?.pets || [],
      sidebarWidth: storedWidth('grok.sidebarWidth', 268, 200, 480),
      rightWidth: storedWidth('grok.rightWidth', 360, 280, 560)
    })
    if (cwd) {
      const [git, tree, skills] = await Promise.allSettled([
        window.grok.git(cwd),
        window.grok.tree(cwd),
        window.grok.skills.list(cwd).catch(() => get().skills)
      ])
      set({ git: git.status === 'fulfilled' ? git.value : null,
        tree: tree.status === 'fulfilled' ? tree.value : [],
        skills: skills.status === 'fulfilled' ? skills.value : get().skills,
        error: git.status === 'rejected' || tree.status === 'rejected' ? '部分项目文件无法读取，可重新选择目录；其他功能仍可使用。' : null })
    }
    if (snap.wallpaper) {
      void window.grok
        .wallpaperData()
        .then((paper) => {
          if (!paper) return
          set({
            wallpaperName: paper.name,
            wallpaperOpacity: paper.opacity,
            wallpaperDataUrl: paper.dataUrl
          })
        })
        .catch(() => undefined)
    }
    // Workspace providers initialize independently. A fresh installation must
    // not spawn a legacy Grok agent before that account is signed in.
    if (!snap.auth.signedIn) return
    window.grok.acp
      .start({ model: snap.model, effort: snap.effort })
      .then(() => set({ connected: true }))
      .catch((err: unknown) =>
        set({
          error: err instanceof Error ? err.message : 'Failed to start Grok agent',
          connected: false
        })
      )
  },

  setTheme: (theme) => {
    set({ theme })
    applyTheme(theme)
    persistPrefs({ theme })
  },
  setLocale: (locale) => {
    set({ locale })
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
    persistPrefs({ locale })
  },
  setDraft: (draft) => {
    const key = get().activeThreadId || NEW_THREAD_KEY
    set({ draft, drafts: { ...get().drafts, [key]: draft } })
  },
  setModel: (model) => {
    set({ model })
    persistPrefs({ model })
  },
  setEffort: (effort) => {
    set({ effort })
    persistPrefs({ effort })
  },
  setRunMode: (runMode) => set({ runMode }),
  setPermissionMode: (permissionMode) => {
    set({ permissionMode })
    persistPrefs({ permissionMode })
  },
  setWallpaperOpacity: (n) => {
    const wallpaperOpacity = Math.min(100, Math.max(0, Math.round(n)))
    set({ wallpaperOpacity })
    persistPrefs({ wallpaperOpacity })
  },
  chooseWallpaper: async () => {
    try {
      if (!window.grok) {
        const input = document.createElement('input')
        input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'
        await new Promise<void>((resolve, reject) => {
          input.oncancel = () => resolve()
          input.onchange = async () => {
            try {
              const file = input.files?.[0]
              if (!file) { resolve(); return }
              if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片')
              const reader = new FileReader()
              reader.onload = () => { set({ wallpaperName: file.name, wallpaperDataUrl: String(reader.result), error: null }); resolve() }
              reader.onerror = () => reject(new Error('图片读取失败'))
              reader.readAsDataURL(file)
            } catch (e) { reject(e) }
          }
          input.click()
        })
        return
      }
      const res = await window.grok.chooseWallpaper()
      if (!res.wallpaper) return
      set({
        wallpaperName: res.wallpaper.name,
        wallpaperOpacity: res.wallpaper.opacity,
        wallpaperDataUrl: res.wallpaper.dataUrl,
        error: null
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not set background'
      set({ error: msg })
      throw err
    }
  },
  clearWallpaper: async () => {
    if (window.grok) await window.grok.clearWallpaper()
    set({ wallpaperName: null, wallpaperDataUrl: null })
  },
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setSidebarWidth: (w) => {
    const max = Math.min(480, Math.max(200, window.innerWidth - get().rightWidth - 520))
    const next = Math.round(Math.min(max, Math.max(200, w)))
    set({ sidebarWidth: next })
    try {
      localStorage.setItem('grok.sidebarWidth', String(next))
    } catch {
      /* ignore */
    }
  },
  setRightWidth: (w) => {
    const max = Math.min(560, Math.max(280, window.innerWidth - get().sidebarWidth - 520))
    const next = Math.round(Math.min(max, Math.max(280, w)))
    set({ rightWidth: next })
    try {
      localStorage.setItem('grok.rightWidth', String(next))
    } catch {
      /* ignore */
    }
  },
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setSettings: (settingsOpen, tab) =>
    set(tab ? { settingsOpen, settingsTab: tab } : { settingsOpen }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setSkillsOpen: (open) => {
    if (open) set({ settingsOpen: true, settingsTab: 'skills' })
    else set({ settingsOpen: false })
  },

  loadSkills: async (cwd) => {
    const epoch = ++skillsLoadEpoch
    const workspace = useCollaboration.getState()
    const target = cwd || get().cwd
    const current = () => epoch === skillsLoadEpoch && useCollaboration.getState().surface === workspace.surface &&
      (workspace.surface === 'workspace' ? useCollaboration.getState().activeTeamId === workspace.activeTeamId : get().cwd === target)
    try {
      const skills = workspace.surface === 'workspace' ? await runtimeClient.skills(workspace.activeTeamId, teamDirectory(workspace.teams, workspace.activeTeamId)) : await window.grok.skills.list(target)
      if (current()) set({ skills, error: null })
    } catch (e) { if (current()) set({ error: e instanceof Error ? e.message : '技能读取失败' }) }
  },
  setSkillDisabled: async (name, disabled) => {
    const workspace = useCollaboration.getState()
    const skills = workspace.surface === 'workspace' ? await runtimeClient.toggleSkill(workspace.activeTeamId, name, disabled, teamDirectory(workspace.teams, workspace.activeTeamId)) : await window.grok.skills.setDisabled(name, disabled, get().cwd)
    set({ skills })
  },
  createSkill: async (input) => {
    const workspace = useCollaboration.getState()
    const res = workspace.surface === 'workspace' ? await runtimeClient.createSkill(workspace.activeTeamId, input, teamDirectory(workspace.teams, workspace.activeTeamId)) : await window.grok.skills.create({ ...input, cwd: get().cwd })
    if (res.ok) set({ skills: res.skills })
    return res
  },
  runSkill: (skill) => {
    const workspace = useCollaboration.getState()
    if (workspace.surface === 'workspace') {
      const id = workspace.activeTeamId
      const team = workspace.teams.find((t) => t.id === id)
      if (!team || skill.disabled || !skill.userInvocable) return
      const draft = `/${skill.name} ${(workspace.drafts[id] || '').trim()}`.trim()
      if (draft.length > 8000) { set({ error: '消息超过 8,000 字，请缩短后重试。' }); return }
      workspace.setDraft(id, draft)
      workspace.navigate('team', id)
      set({ skillsOpen: false, settingsOpen: false, error: null })
      return
    }
    const text = `/${skill.name}`
    set({ skillsOpen: false, settingsOpen: false })
    void get().send(text)
  },
  wakePet: async () => {
    if (typeof window.grok?.pets?.wake !== 'function') return
    const snap = await window.grok.pets.wake()
    set({ petAwake: snap.awake, petId: snap.petId, pets: snap.pets })
  },
  tuckPet: async () => {
    if (typeof window.grok?.pets?.tuck !== 'function') return
    const snap = await window.grok.pets.tuck()
    set({ petAwake: snap.awake, petId: snap.petId, pets: snap.pets })
  },
  selectPet: async (id) => {
    const snap = await window.grok.pets.select(id)
    set({ petAwake: snap.awake, petId: snap.petId, pets: snap.pets })
  },
  applyPetPrefs: (pet) => {
    set({
      petAwake: pet.awake,
      petId: pet.petId,
      pets: pet.pets || get().pets
    })
  },
  applyPetSnapshot: (snap) => {
    set({ petAwake: snap.awake, petId: snap.petId, pets: snap.pets })
  },
  createPet: async (draft) => {
    const snap = await petInvoke<PetSnapshot>('create', draft)
    get().applyPetSnapshot(snap)
    return snap
  },
  updatePet: async (id, draft) => {
    const snap = await petInvoke<PetSnapshot>('update', id, draft)
    get().applyPetSnapshot(snap)
    return snap
  },
  deletePet: async (id) => {
    const snap = await petInvoke<PetSnapshot>('delete', id)
    get().applyPetSnapshot(snap)
    return snap
  },
  addPetAction: async (petId, draft) => {
    const snap = await petInvoke<PetSnapshot>('addAction', petId, draft)
    get().applyPetSnapshot(snap)
    return snap
  },
  removePetAction: async (petId, actionId) => {
    const snap = await petInvoke<PetSnapshot>('removeAction', petId, actionId)
    get().applyPetSnapshot(snap)
    return snap
  },
  updatePetAction: async (petId, actionId, draft) => {
    const snap = await petInvoke<PetSnapshot>('updateAction', petId, actionId, draft)
    get().applyPetSnapshot(snap)
    return snap
  },
  playPetAction: async (actionId, petId) => {
    const snap = await petInvoke<PetSnapshot>('playAction', actionId, petId)
    get().applyPetSnapshot(snap)
  },

  focusProject: async (path) => {
    if (!path) return
    if (pathKey(path) !== pathKey(get().cwd)) {
      await get().newThread(path)
      return
    }
    useCollaboration.getState().setSurface('legacy')
    set({ sidebarCollapsed: false })
    await get().refreshWorkspace(path)
  },

  newThread: async (cwd) => {
    useCollaboration.getState().setSurface('legacy')
    const epoch = ++newThreadEpoch
    openThreadEpoch += 1
    get().closePreview()
    const dir = cwd || get().cwd
    const runtimes = { ...get().runtimes, [NEW_THREAD_KEY]: emptyRuntime() }
    const drafts = { ...get().drafts, [NEW_THREAD_KEY]: '' }
    set({
      activeThreadId: null,
      messages: [],
      plan: [],
      draft: '',
      cwd: dir,
      git: null,
      tree: [],
      skills: [],
      permission: null,
      running: false,
      hasMoreHistory: false,
      loadingHistory: false,
      error: null,
      sidebarCollapsed: false,
      runtimes,
      drafts
    })
    if (dir) {
      try {
        const [git, tree, skills] = await Promise.all([
          window.grok.git(dir),
          window.grok.tree(dir),
          window.grok.skills.list(dir).catch(() => [])
        ])
        if (get().activeThreadId === null && get().cwd === dir && epoch === newThreadEpoch)
          set({ git, tree, skills })
      } catch (err) {
        if (get().activeThreadId === null && get().cwd === dir && epoch === newThreadEpoch)
          set({ error: err instanceof Error ? err.message : 'Could not load project' })
      }
    } else {
      void get().loadSkills('')
    }
  },

  openThread: async (thread) => {
    useCollaboration.getState().setSurface('legacy')
    if (get().activeThreadId === thread.id && get().runtimes[thread.id]) {
      set({
        threads: get().threads.map((t) => (t.id === thread.id ? { ...t, unread: false } : t))
      })
      return
    }

    const epoch = ++openThreadEpoch
    const previousCwd = get().cwd
    get().closePreview()
    const cached = get().runtimes[thread.id]
    const initial = cached || emptyRuntime()
    set({
      activeThreadId: thread.id,
      cwd: thread.cwd,
      ...(previousCwd !== thread.cwd ? { git: null, tree: [], skills: [] } : {}),
      ...viewOf(initial),
      draft: get().drafts[thread.id] || '',
      error: null,
      sidebarCollapsed: false,
      threads: get().threads.map((t) => (t.id === thread.id ? { ...t, unread: false } : t))
    })

    const historyPromise = cached
      ? Promise.resolve(cached)
      : loadHistoryOnce(thread.id, thread.cwd).then((page) => ({
          ...emptyRuntime(),
          messages: page.messages,
          historyCursor: page.nextCursor,
          hasMoreHistory: page.hasMore
        }))

    const contextPromise =
      previousCwd === thread.cwd && get().tree.length
        ? Promise.resolve(null)
        : Promise.allSettled([
            window.grok.git(thread.cwd),
            window.grok.tree(thread.cwd),
            window.grok.skills.list(thread.cwd).catch(() => [])
          ])

    try {
      const [loaded, context] = await Promise.all([historyPromise, contextPromise])
      const state = get()
      const runtime = state.runtimes[thread.id] || loaded
      const isCurrent = state.activeThreadId === thread.id && epoch === openThreadEpoch
      const contextFailure = context?.find((result) => result.status === 'rejected')
      set({
        runtimes: { ...state.runtimes, [thread.id]: runtime },
        ...(isCurrent ? { ...viewOf(runtime) } : {}),
        ...(isCurrent && context
          ? {
              git: context[0].status === 'fulfilled' ? context[0].value : null,
              tree: context[1].status === 'fulfilled' ? context[1].value : [],
              skills: context[2].status === 'fulfilled' ? context[2].value : [],
              ...(contextFailure?.status === 'rejected' ? {
                error: contextFailure.reason instanceof Error ? contextFailure.reason.message : 'Could not load project'
              } : {})
            }
          : {})
      })
    } catch (err) {
      if (get().activeThreadId === thread.id && epoch === openThreadEpoch) {
        set({ error: err instanceof Error ? err.message : 'Could not load session' })
      }
    }
  },

  loadOlderMessages: async () => {
    const state = get()
    const sessionId = state.activeThreadId
    if (!sessionId) return
    const runtime = state.runtimes[sessionId]
    if (!runtime || !runtime.hasMoreHistory || runtime.loadingHistory || runtime.historyCursor === null) {
      return
    }

    const cursor = runtime.historyCursor
    const loading = { ...runtime, loadingHistory: true }
    set({
      runtimes: { ...state.runtimes, [sessionId]: loading },
      ...(state.activeThreadId === sessionId ? viewOf(loading) : {})
    })

    try {
      const page = await loadHistoryOnce(sessionId, state.cwd, cursor)
      const latest = get()
      const current = latest.runtimes[sessionId]
      if (!current) return
      const seen = new Set(current.messages.map((message) => message.id))
      const older = page.messages.filter((message) => !seen.has(message.id))
      const next: ThreadRuntime = {
        ...current,
        messages: [...older, ...current.messages],
        historyCursor: page.nextCursor,
        hasMoreHistory: page.hasMore,
        loadingHistory: false
      }
      set({
        runtimes: { ...latest.runtimes, [sessionId]: next },
        ...(latest.activeThreadId === sessionId ? viewOf(next) : {})
      })
    } catch (err) {
      const latest = get()
      const current = latest.runtimes[sessionId]
      if (!current) return
      const next = { ...current, loadingHistory: false }
      set({
        runtimes: { ...latest.runtimes, [sessionId]: next },
        ...(latest.activeThreadId === sessionId
          ? {
              ...viewOf(next),
              error: err instanceof Error ? err.message : 'Could not load older messages'
            }
          : {})
      })
    }
  },

  addProject: async () => {
    if (!window.grok) { set({ error: '请在桌面应用中打开本地项目。' }); return }
    try {
      const folder = await window.grok.pickFolder()
      if (!folder) return
      const projects = await window.grok.addProjectPath(folder)
      set({ projects })
      await get().newThread(folder)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '导入项目失败' })
    }
  },

  renameProject: async (projectPath, name) => {
    const projects = await window.grok.renameProject(projectPath, name)
    set({ projects })
  },

  removeProject: async (projectPath) => {
    const victims = get().threads.filter((t) => pathKey(t.cwd) === pathKey(projectPath))
    for (const t of victims) {
      if (get().runtimes[t.id]?.running) await window.grok.acp.cancel(t.id)
    }
    const projects = await window.grok.removeProject(projectPath)
    set({ projects })
    if (pathKey(get().cwd) === pathKey(projectPath)) {
      const next = projects[0]?.path
      if (next) await get().focusProject(next)
      else {
        set({ cwd: '', tree: [], git: null })
        await get().newThread()
      }
    }
  },

  renameThread: async (thread, title) => {
    await window.grok.renameThread(thread.id, thread.cwd, title)
    const { threads, projects } = await window.grok.refresh()
    set({ threads: mergeDiskThreads(threads, get().threads), projects })
  },

  deleteThread: async (thread) => {
    if (get().runtimes[thread.id]?.running) await window.grok.acp.cancel(thread.id)
    await window.grok.deleteThread(thread.id, thread.cwd)
    const runtimes = { ...get().runtimes }
    const drafts = { ...get().drafts }
    delete runtimes[thread.id]
    delete drafts[thread.id]
    set({ runtimes, drafts })
    if (get().activeThreadId === thread.id) await get().newThread(thread.cwd)
    const { threads, projects } = await window.grok.refresh()
    set({
      threads: mergeDiskThreads(
        threads,
        get().threads.filter((t) => t.id !== thread.id)
      ),
      projects
    })
  },

  refreshGit: async () => {
    const cwd = get().cwd
    if (!cwd) return
    const git = await window.grok.git(cwd)
    if (get().cwd === cwd) set({ git })
  },

  refreshWorkspace: async (requestedCwd) => {
    const cwd = requestedCwd || get().cwd
    if (!cwd) return
    const previewPath = get().cwd === cwd ? get().previewPath : null
    const previewEpoch = filePreviewEpoch
    const [git, tree] = await Promise.allSettled([
      window.grok.git(cwd),
      window.grok.tree(cwd)
    ])
    if (get().cwd === cwd) {
      const failed = [git, tree].find((result) => result.status === 'rejected')
      set({ git: git.status === 'fulfilled' ? git.value : null, tree: tree.status === 'fulfilled' ? tree.value : [],
        ...(failed?.status === 'rejected' ? { error: failed.reason instanceof Error ? failed.reason.message : '项目刷新失败' } : {}) })
    }
    if (previewPath && get().cwd === cwd && previewEpoch === filePreviewEpoch) {
      try {
        const preview = await window.grok.previewFile(previewPath)
        if (get().cwd === cwd && get().previewPath === previewPath && previewEpoch === filePreviewEpoch)
          set({ preview })
      } catch (err) {
        if (get().cwd === cwd && get().previewPath === previewPath && previewEpoch === filePreviewEpoch)
          set({ error: err instanceof Error ? err.message : 'Could not refresh file' })
      }
    }
  },

  send: async (text, files = []) => {
    if (!window.grok) { set({ error: '浏览器仅用于界面预览。请运行 npm run dev，在桌面应用中使用 Grok 单聊。' }); return }
    const submittedDraft = get().draft
    const value = (text ?? get().draft).trim()
    const attached = files.filter((f) => f.path || f.dataUrl)
    const startedId = get().activeThreadId
    if (startedId && get().runtimes[startedId]?.running) return
    if (!value && !attached.length) return

    if (!attached.length) {
      const key = startedId || NEW_THREAD_KEY
      if (value === '/pet' || value === '/pet wake' || value === '/pet tuck') {
        if (value.endsWith('tuck') || (value === '/pet' && get().petAwake)) await get().tuckPet()
        else await get().wakePet()
        set({ draft: '', drafts: { ...get().drafts, [key]: '' } })
        return
      }
      if (value === '/skills') {
        set({
          settingsOpen: true,
          settingsTab: 'skills',
          draft: '',
          drafts: { ...get().drafts, [key]: '' }
        })
        return
      }
    }

    const epoch = newThreadEpoch
    const sendKey = startedId || `${NEW_THREAD_KEY}:${epoch}`
    if (sending.has(sendKey)) return
    sending.add(sendKey)
    try {
      let cwd = get().cwd
      if (!cwd) {
        try {
          const folder = await window.grok.pickFolder()
          if (!folder) return
          const projects = await window.grok.addProjectPath(folder)
          if (newThreadEpoch !== epoch || get().activeThreadId !== startedId) return
          cwd = folder
          set({ cwd, projects })
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '导入项目失败' })
          return
        }
      }

      const creating = !startedId
      let sessionId = startedId
      if (sessionId) {
        try {
          const pendingHistory = historyLoads.get(historyKey(sessionId, cwd))
          if (pendingHistory && !get().runtimes[sessionId]) {
            const page = await pendingHistory
            const state = get()
            if (!state.runtimes[sessionId]) {
              const restored = {
                ...emptyRuntime(),
                messages: page.messages,
                historyCursor: page.nextCursor,
                hasMoreHistory: page.hasMore
              }
              set({
                runtimes: { ...state.runtimes, [sessionId]: restored },
                ...(state.activeThreadId === sessionId ? viewOf(restored) : {})
              })
            }
          }
          const loadedId = await ensureSessionLoaded(sessionId, cwd)
          if (loadedId !== sessionId) {
            const state = get()
            const moved = state.runtimes[sessionId] || emptyRuntime()
            const runtimes = { ...state.runtimes }
            const drafts = { ...state.drafts }
            delete runtimes[sessionId]
            delete drafts[sessionId]
            runtimes[loadedId] = moved
            drafts[loadedId] = state.drafts[sessionId] || ''
            set({
              runtimes,
              drafts,
              activeThreadId: state.activeThreadId === sessionId ? loadedId : state.activeThreadId,
              threads: state.threads.map((t) => (t.id === sessionId ? { ...t, id: loadedId } : t))
            })
            sessionId = loadedId
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not resume session'
          if (get().activeThreadId === startedId) set({ error: msg, running: false })
          return
        }
      } else {
        try {
          const meta: Record<string, unknown> = {
            yoloMode: get().permissionMode === 'auto',
            model: get().model,
            effort: get().effort
          }
          const created = await window.grok.acp.newSession(cwd, meta)
          sessionId = created.sessionId
          loadedSessions.add(sessionId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not start session'
          if (get().activeThreadId === startedId) set({ error: msg, running: false })
          return
        }
      }

      const userMsg: ChatMessage = {
        id: uid(),
        kind: 'user',
        text: value,
        createdAt: new Date().toISOString(),
        attachments: attached.length
          ? attached.map((f) => ({ path: f.path, name: f.name, dataUrl: f.dataUrl, mime: f.mime }))
          : undefined
      }

      const viewing = get().activeThreadId
      const showInView = creating
        ? viewing === null && epoch === newThreadEpoch
        : viewing === startedId || viewing === sessionId
      const prev =
        get().runtimes[sessionId] ||
        (creating ? get().runtimes[NEW_THREAD_KEY] || emptyRuntime() : emptyRuntime())
      const rt: ThreadRuntime = {
        ...prev,
        messages: [...prev.messages, userMsg],
        running: true,
        permission: null
      }
      const runtimes = { ...get().runtimes, [sessionId]: rt }
      if (creating && showInView) runtimes[NEW_THREAD_KEY] = emptyRuntime()

      const threadMeta: ThreadMeta = {
        id: sessionId,
        title: (value || attached[0]?.name || 'New thread').slice(0, 72),
        cwd,
        projectName: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd,
        updatedAt: new Date().toISOString(),
        status: 'running',
        model: get().model
      }
      const threads = creating
        ? [threadMeta, ...get().threads.filter((t) => t.id !== sessionId)]
        : withThreadStatus(get().threads, sessionId, 'running', { unread: false })

      // Session creation/resumption can take time. Preserve anything typed in the
      // meantime, and keep explicit skill commands from clearing unrelated text.
      const draftKey = creating ? NEW_THREAD_KEY : sessionId
      const currentDraft = creating && epoch !== newThreadEpoch ? ''
        : get().drafts[draftKey] ?? (showInView ? get().draft : '')
      const nextDraft = currentDraft === submittedDraft && value === submittedDraft.trim() ? '' : currentDraft
      const drafts = { ...get().drafts, [sessionId]: nextDraft }
      if (creating && epoch === newThreadEpoch) drafts[NEW_THREAD_KEY] = ''

      set({
        runtimes,
        threads,
        drafts,
        ...(showInView
          ? {
              activeThreadId: sessionId,
              ...viewOf(rt),
              draft: nextDraft,
              error: null
            }
          : {})
      })

      try {
        await window.grok.acp.prompt(
          value,
          sessionId,
          attached,
          get().permissionMode === 'auto'
        )
        const current = get().runtimes[sessionId] || rt
        const finished = finishRun(current)
        const isActive = get().activeThreadId === sessionId
        set({
          runtimes: { ...get().runtimes, [sessionId]: finished },
          threads: withThreadStatus(get().threads, sessionId, 'idle'),
          ...(isActive ? { ...viewOf(finished) } : {})
        })
        const disk = await window.grok.threads()
        set({ threads: mergeDiskThreads(disk, get().threads) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Prompt failed'
        const cancelled = /cancel|aborted/i.test(msg)
        const current = get().runtimes[sessionId] || rt
        const finished = finishRun(current)
        const failed: ThreadRuntime = cancelled
          ? finished
          : {
              ...finished,
              messages: [
                ...finished.messages,
                {
                  id: uid(),
                  kind: 'error',
                  text: msg,
                  createdAt: new Date().toISOString()
                }
              ]
            }
        const isActive = get().activeThreadId === sessionId
        set({
          runtimes: { ...get().runtimes, [sessionId]: failed },
          threads: withThreadStatus(get().threads, sessionId, cancelled ? 'idle' : 'error'),
          ...(isActive ? { ...viewOf(failed), error: cancelled ? get().error : msg } : {})
        })
      } finally {
        await get().refreshWorkspace(cwd)
      }
    } finally {
      sending.delete(sendKey)
    }
  },

  cancel: async () => {
    const id = get().activeThreadId
    if (!id) return
    try {
      await window.grok.acp.cancel(id)
      const runtime = get().runtimes[id]
      if (!runtime) return
      const next = finishRun(runtime)
      set({
        runtimes: { ...get().runtimes, [id]: next },
        threads: withThreadStatus(get().threads, id, 'idle'),
        ...(get().activeThreadId === id ? viewOf(next) : {})
      })
    } catch (err) {
      if (get().activeThreadId === id)
        set({ error: err instanceof Error ? err.message : '停止失败，请重试。' })
    }
  },

  respondPermission: async (optionId) => {
    const req = get().permission
    if (!req) return
    if (optionId === 'reject' || optionId === 'cancel') await window.grok.acp.deny(req.requestId)
    else await window.grok.acp.permission(req.requestId, optionId)
    const sessionId = req.sessionId
    const prev = get().runtimes[sessionId]
    const next = prev ? { ...prev, permission: null } : null
    set({
      permission: get().activeThreadId === sessionId ? null : get().permission,
      ...(next
        ? {
            runtimes: { ...get().runtimes, [sessionId]: next },
            threads: withThreadStatus(get().threads, sessionId, 'running')
          }
        : {}),
      ...(get().activeThreadId === sessionId ? { permission: null } : {})
    })
  },

  openPreview: async (path) => {
    const epoch = ++filePreviewEpoch
    const cwd = get().cwd
    set({ previewPath: path, preview: null, rightTab: 'files', rightOpen: true })
    try {
      const preview = await window.grok.previewFile(path)
      if (epoch === filePreviewEpoch && get().cwd === cwd) set({ preview })
    } catch (err) {
      if (epoch === filePreviewEpoch && get().cwd === cwd)
        set({ previewPath: null, error: err instanceof Error ? err.message : 'Could not load file' })
    }
  },

  closePreview: () => {
    filePreviewEpoch += 1
    set({ preview: null, previewPath: null })
  },

  applyUpdate: (update) => {
    const sessionId = String(update.sessionId || '')
    if (!sessionId) return
    loadedSessions.add(sessionId)
    const prev = get().runtimes[sessionId] || emptyRuntime()
    const next = applySessionUpdate(prev, update)
    const kind = String(update.sessionUpdate || update.type || '')
    const isActive = get().activeThreadId === sessionId
    const listed = get().threads.some((t) => t.id === sessionId)
    const bumpRunning =
      kind === 'agent_message_chunk' ||
      kind === 'agent_message' ||
      kind === 'agent_thought_chunk' ||
      kind === 'agent_thought' ||
      kind === 'tool_call' ||
      kind === 'tool_call_update'
    set({
      runtimes: { ...get().runtimes, [sessionId]: next },
      threads:
        listed && bumpRunning
          ? withThreadStatus(get().threads, sessionId, 'running', {
              unread: !isActive
            })
          : listed && isActive
            ? get().threads.map((t) => (t.id === sessionId ? { ...t, unread: false } : t))
            : get().threads,
      ...(isActive
        ? {
            ...viewOf(next),
            ...(kind === 'plan' ? { rightTab: 'plan' as const, rightOpen: true } : {})
          }
        : {})
    })
  },

  applyPermission: (req) => {
    const sessionId = req.sessionId
    if (!sessionId) return
    const prev = get().runtimes[sessionId] || emptyRuntime()
    const next: ThreadRuntime = { ...prev, permission: req, running: true }
    const isActive = get().activeThreadId === sessionId
    set({
      runtimes: { ...get().runtimes, [sessionId]: next },
      threads: withThreadStatus(get().threads, sessionId, 'needs_input', {
        unread: isActive ? false : true
      }),
      ...(isActive ? { permission: req, running: true } : {})
    })
  },

  onAgentDisconnected: () => {
    loadedSessions.clear()
    sessionLoads.clear()
    const runtimes = { ...get().runtimes }
    for (const [id, rt] of Object.entries(runtimes)) {
      if (rt.running || rt.permission) runtimes[id] = finishRun(rt)
    }
    const active = get().activeThreadId
    const view = active ? runtimes[active] : null
    set({
      connected: false,
      runtimes,
      threads: get().threads.map((t) =>
        t.status === 'running' || t.status === 'needs_input' ? { ...t, status: 'error' } : t
      ),
      running: false,
      permission: null,
      ...(view ? viewOf(view) : {})
    })
  }
}))
