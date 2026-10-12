/// <reference types="vite/client" />

import type {
  AppSnapshot,
  ProviderDiagnostic,
  CreateSkillResult,
  Effort,
  FileNode,
  FilePreview,
  GitState,
  HistoryCursor,
  HistoryPage,
  PermissionRequest,
  PetActionDraft,
  PetActionGenerationOptions,
  PetActionProgress,
  PetAtlas,
  PetDraft,
  PetGeneratedMedia,
  PetInfo,
  PetLiveStatus,
  PetSnapshot,
  PetSubjectExtractionOptions,
  PetVisual,
  Project,
  PromptAttachment,
  SkillInfo,
  SkillScope,
  ThreadMeta,
  UiPrefs,
  UsageSnapshot
} from '@shared/types'

interface GrokAPI {
  persistence: {
    ready: () => void
    onPrepareClose: (handler: (id: string) => void) => () => void
    respondClose: (id: string, result: { ok: boolean; error?: string }) => Promise<void>
    onResume: (handler: () => void) => () => void
  }
  providers: { inspect: () => Promise<ProviderDiagnostic[]> }
  workspace: import('@shared/runtime').RuntimeApi
  backup: import('@shared/portable-backup').PortableBackupApi
  projectRelink: import('@shared/project-relink').ProjectRelinkApi
  snapshot: () => Promise<AppSnapshot>
  threads: () => Promise<ThreadMeta[]>
  refresh: () => Promise<{ threads: ThreadMeta[]; projects: Project[] }>
  renameThread: (id: string, cwd: string, title: string) => Promise<boolean>
  deleteThread: (id: string, cwd: string) => Promise<boolean>
  renameProject: (projectPath: string, name: string) => Promise<Project[]>
  removeProject: (projectPath: string) => Promise<Project[]>
  addProjectPath: (folder: string) => Promise<Project[]>
  history: (id: string, cwd: string, cursor?: HistoryCursor | null) => Promise<HistoryPage>
  git: (cwd: string) => Promise<GitState | null>
  tree: (cwd: string) => Promise<FileNode[]>
  readFile: (file: string) => Promise<string>
  previewFile: (file: string, ctx?: { cwd?: string; sessionId?: string }) => Promise<FilePreview>
  saveMedia: (payload: {
    dataUrl?: string
    path?: string
    name?: string
    cwd?: string
    sessionId?: string
  }) => Promise<string | null>
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  openPath: (target: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  pickFolder: () => Promise<string | null>
  pickFiles: () => Promise<string[]>
  pickImage: () => Promise<string | null>
  chooseWallpaper: () => Promise<{
    wallpaper: { name: string; opacity: number; dataUrl: string } | null
  }>
  wallpaperData: () => Promise<{ name: string; opacity: number; dataUrl: string } | null>
  savePrefs: (patch: Partial<UiPrefs>) => Promise<{
    theme: AppSnapshot['theme']
    locale: AppSnapshot['locale']
    permissionMode: AppSnapshot['permissionMode']
    model?: string
    effort?: Effort
    wallpaper: AppSnapshot['wallpaper']
  }>
  setWallpaper: (file: string) => Promise<{
    wallpaper: { name: string; opacity: number; dataUrl: string }
  }>
  clearWallpaper: () => Promise<{ wallpaper: null }>
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  skills: {
    list: (cwd?: string) => Promise<SkillInfo[]>
    read: (file: string) => Promise<SkillInfo | null>
    setDisabled: (name: string, disabled: boolean, cwd?: string) => Promise<SkillInfo[]>
    create: (input: {
      name: string
      description: string
      scope: SkillScope
      cwd?: string
    }) => Promise<CreateSkillResult>
  }
  usage: {
    fetch: () => Promise<UsageSnapshot>
  }
  pets: {
    list: () => Promise<PetInfo[]>
    snapshot: () => Promise<PetSnapshot>
    wake: () => Promise<PetSnapshot>
    tuck: () => Promise<PetSnapshot>
    select: (id: string) => Promise<PetSnapshot>
    report: (status: PetLiveStatus) => Promise<void>
    activate: (threadId?: string | null) => Promise<void>
    spritesheet: (id: string) => Promise<{ dataUrl: string; atlas: PetAtlas } | null>
    visual: (id: string, file?: string) => Promise<PetVisual | null>
    bounds: () => Promise<{ x: number; y: number; width: number; height: number }>
    moveTo: (x: number, y: number) => Promise<{ x: number; y: number }>
    endDrag: () => Promise<{ x: number; y: number }>
    create: (draft: PetDraft) => Promise<PetSnapshot>
    update: (id: string, draft: PetDraft) => Promise<PetSnapshot>
    delete: (id: string) => Promise<PetSnapshot>
    addAction: (petId: string, draft: PetActionDraft) => Promise<PetSnapshot>
    updateAction: (petId: string, actionId: string, draft: PetActionDraft) => Promise<PetSnapshot>
    removeAction: (petId: string, actionId: string) => Promise<PetSnapshot>
    playAction: (actionId: string, petId?: string) => Promise<PetSnapshot>
    generateImages: (prompt: string, count?: 1 | 2 | 4) => Promise<PetGeneratedMedia[]>
    extractSubject: (imagePath: string, target?: string, options?: PetSubjectExtractionOptions) => Promise<PetGeneratedMedia>
    generateActionVideo: (petId: string, prompt: string) => Promise<PetGeneratedMedia>
    generateActionSheet: (petId: string, prompt: string, referencePath?: string, options?: PetActionGenerationOptions) => Promise<PetGeneratedMedia>
    actionJobs: (petId: string) => Promise<PetActionProgress[]>
    pauseActionGeneration: (petId: string, jobId: string) => Promise<void>
    menu: () => Promise<void>
  }
  acp: {
    start: (opts?: { model?: string; effort?: Effort }) => Promise<{ connected: boolean; grokPath: string | null }>
    newSession: (cwd: string, meta?: Record<string, unknown>) => Promise<{ sessionId: string }>
    loadSession: (sessionId: string, cwd: string) => Promise<{ sessionId: string }>
    prompt: (
      text: string,
      sessionId: string,
      attachments?: PromptAttachment[],
      autoApprove?: boolean
    ) => Promise<unknown>
    cancel: (sessionId: string) => Promise<void>
    setMode: (modeId: string, sessionId?: string) => Promise<void>
    permission: (id: number | string, optionId: string) => Promise<void>
    deny: (id: number | string) => Promise<void>
  }
  on: (channel: string, cb: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    grok: GrokAPI
  }
}

export {}
