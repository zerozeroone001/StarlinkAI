import { contextBridge, ipcRenderer } from 'electron'
import type {
  Effort,
  HistoryCursor,
  PetActionDraft,
  PetActionGenerationOptions,
  PetDraft,
  PetSubjectExtractionOptions,
  PetLiveStatus,
  PromptAttachment,
  ProviderId,
  SkillScope,
  UiPrefs
} from '../shared/types'

const INVOKE = new Set([
  'app:snapshot',
  'app:previewFile',
  'app:saveMedia',
  'app:pickImage',
  'pets:list',
  'pets:snapshot',
  'pets:wake',
  'pets:tuck',
  'pets:select',
  'pets:report',
  'pets:activate',
  'pets:spritesheet',
  'pets:visual',
  'pets:bounds',
  'pets:moveTo',
  'pets:endDrag',
  'pets:create',
  'pets:update',
  'pets:delete',
  'pets:addAction',
  'pets:updateAction',
  'pets:removeAction',
  'pets:playAction',
  'pets:generateImages',
  'pets:extractSubject',
  'pets:generateActionVideo',
  'pets:generateActionSheet',
  'pets:actionJobs',
  'pets:pauseActionGeneration',
  'pets:menu',
  'usage:fetch'
])

const EVENTS = new Set([
  'grok:update',
  'grok:permission',
  'grok:connected',
  'grok:disconnected',
  'grok:log',
  'grok:open-thread',
  'pets:status',
  'pets:snapshot',
  'pets:prefs',
  'pets:chrome',
  'pets:action',
  'pets:actionProgress'
])

const api = {
  projectRelink: {
    prepare: (text: string, id: string) => ipcRenderer.invoke('projectRelink:prepare', text, id),
    commit: (token: string, allowIncomplete: boolean) => ipcRenderer.invoke('projectRelink:commit', token, allowIncomplete),
    finish: (token: string) => ipcRenderer.invoke('projectRelink:finish', token),
    cancel: (token?: string) => ipcRenderer.invoke('projectRelink:cancel', token),
    status: () => ipcRenderer.invoke('projectRelink:status')
  } satisfies import('../shared/project-relink').ProjectRelinkApi,
  backup: {
    beginExport: (text: string) => ipcRenderer.invoke('backup:beginExport', text),
    inspectImport: () => ipcRenderer.invoke('backup:inspectImport'),
    writeExport: (token: string, allowIncomplete: boolean) => ipcRenderer.invoke('backup:writeExport', token, allowIncomplete),
    prepareRestore: (token: string, allowIncomplete: boolean) => ipcRenderer.invoke('backup:prepareRestore', token, allowIncomplete),
    prepareRollback: () => ipcRenderer.invoke('backup:prepareRollback'),
    reconcile: (marker: string | null, scopes: string[]) => ipcRenderer.invoke('backup:reconcile', marker, scopes),
    cancel: (token?: string) => ipcRenderer.invoke('backup:cancel', token),
    status: () => ipcRenderer.invoke('backup:status'),
    setRemindersPaused: (scopeId: string, paused: boolean, revision: number) => ipcRenderer.invoke('backup:setRemindersPaused', scopeId, paused, revision)
  } satisfies import('../shared/portable-backup').PortableBackupApi,
  persistence: {
    ready: () => { void ipcRenderer.invoke('workspace:persistence-ready').catch(() => {}) },
    onPrepareClose: (handler: (id: string) => void) => {
      const listener = (_event: unknown, id: unknown) => { if (typeof id === 'string') handler(id) }
      ipcRenderer.on('workspace:prepare-close', listener)
      return () => ipcRenderer.removeListener('workspace:prepare-close', listener)
    },
    respondClose: (id: string, result: { ok: boolean; error?: string }): Promise<void> =>
      ipcRenderer.invoke('workspace:persistence-respond', id, result),
    onResume: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('workspace:resume', listener)
      return () => ipcRenderer.removeListener('workspace:resume', listener)
    }
  },
  workspace: {
    assistant: (scopeId: string) => ipcRenderer.invoke('workspace:assistant', scopeId),
    clearAssistant: (scopeId: string) => ipcRenderer.invoke('workspace:clearAssistant', scopeId),
    updateAssistant: (scopeId: string, patch: import('../shared/assistant').AssistantProfilePatch) => ipcRenderer.invoke('workspace:updateAssistant', scopeId, patch),
    saveMemory: (scopeId: string, input: import('../shared/assistant').AssistantMemoryInput) => ipcRenderer.invoke('workspace:saveMemory', scopeId, input),
    forgetMemory: (scopeId: string, id: string) => ipcRenderer.invoke('workspace:forgetMemory', scopeId, id),
    saveCommitment: (scopeId: string, input: import('../shared/assistant').AssistantCommitmentInput) => ipcRenderer.invoke('workspace:saveCommitment', scopeId, input),
    deleteCommitment: (scopeId: string, id: string) => ipcRenderer.invoke('workspace:deleteCommitment', scopeId, id),
    prepareDirectory: (input: import('../shared/project-directory').ProjectDirectoryInput) => ipcRenderer.invoke('workspace:prepareDirectory', input),
    upload: (id: string, input: { name: string; data: string }, directory?: string) => ipcRenderer.invoke('workspace:upload', id, input, directory),
    media: (id: string, source: string, directory?: string) => ipcRenderer.invoke('workspace:media', id, source, directory),
    skills: (id: string, directory?: string) => ipcRenderer.invoke('workspace:skills', id, directory),
    readSkill: (id: string, file: string, directory?: string) => ipcRenderer.invoke('workspace:readSkill', id, file, directory),
    createSkill: (id: string, input: { name: string; description: string; scope: SkillScope }, directory?: string) => ipcRenderer.invoke('workspace:createSkill', id, input, directory),
    toggleSkill: (id: string, name: string, disabled: boolean, directory?: string) => ipcRenderer.invoke('workspace:toggleSkill', id, name, disabled, directory),
    providers: (refresh?: boolean, ids?: ProviderId[]) => ipcRenderer.invoke('workspace:providers', refresh, ids),
    start: (request: import('../shared/runtime').RunRequest) => ipcRenderer.invoke('workspace:start', request),
    run: (id: string) => ipcRenderer.invoke('workspace:run', id),
    cancel: (id: string) => ipcRenderer.invoke('workspace:cancel', id),
    permission: (id: string, permissionId: string, option: string) => ipcRenderer.invoke('workspace:permission', id, permissionId, option),
    login: (provider: string) => ipcRenderer.invoke('workspace:login', provider),
    loginStatus: (provider: string) => ipcRenderer.invoke('workspace:loginStatus', provider)
  },
  providers: { inspect: () => ipcRenderer.invoke('providers:inspect') },
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  threads: () => ipcRenderer.invoke('app:threads'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  renameThread: (id: string, cwd: string, title: string) =>
    ipcRenderer.invoke('app:renameThread', id, cwd, title),
  deleteThread: (id: string, cwd: string) => ipcRenderer.invoke('app:deleteThread', id, cwd),
  renameProject: (projectPath: string, name: string) =>
    ipcRenderer.invoke('app:renameProject', projectPath, name),
  removeProject: (projectPath: string) => ipcRenderer.invoke('app:removeProject', projectPath),
  addProjectPath: (folder: string) => ipcRenderer.invoke('app:addProject', folder),
  history: (id: string, cwd: string, cursor?: HistoryCursor | null) =>
    ipcRenderer.invoke('app:history', id, cwd, cursor),
  git: (cwd: string) => ipcRenderer.invoke('app:git', cwd),
  tree: (cwd: string) => ipcRenderer.invoke('app:tree', cwd),
  readFile: (file: string) => ipcRenderer.invoke('app:readFile', file),
  previewFile: (file: string, ctx?: { cwd?: string; sessionId?: string }) =>
    ipcRenderer.invoke('app:previewFile', file, ctx),
  saveMedia: (payload: {
    dataUrl?: string
    path?: string
    name?: string
    cwd?: string
    sessionId?: string
  }) => ipcRenderer.invoke('app:saveMedia', payload),
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  openPath: (target: string) => ipcRenderer.invoke('app:openPath', target),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('app:pickFiles'),
  pickImage: () => ipcRenderer.invoke('app:pickImage'),
  chooseWallpaper: () => ipcRenderer.invoke('app:chooseWallpaper'),
  wallpaperData: () => ipcRenderer.invoke('app:wallpaperData'),
  savePrefs: (patch: Partial<UiPrefs>) => ipcRenderer.invoke('app:savePrefs', patch),
  setWallpaper: (file: string) => ipcRenderer.invoke('app:setWallpaper', file),
  clearWallpaper: () => ipcRenderer.invoke('app:clearWallpaper'),
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized')
  },
  skills: {
    list: (cwd?: string) => ipcRenderer.invoke('skills:list', cwd),
    read: (file: string) => ipcRenderer.invoke('skills:read', file),
    setDisabled: (name: string, disabled: boolean, cwd?: string) =>
      ipcRenderer.invoke('skills:setDisabled', name, disabled, cwd),
    create: (input: { name: string; description: string; scope: SkillScope; cwd?: string }) =>
      ipcRenderer.invoke('skills:create', input)
  },
  usage: {
    fetch: () => ipcRenderer.invoke('usage:fetch')
  },
  pets: {
    list: () => ipcRenderer.invoke('pets:list'),
    snapshot: () => ipcRenderer.invoke('pets:snapshot'),
    wake: () => ipcRenderer.invoke('pets:wake'),
    tuck: () => ipcRenderer.invoke('pets:tuck'),
    select: (id: string) => ipcRenderer.invoke('pets:select', id),
    report: (status: PetLiveStatus) => ipcRenderer.invoke('pets:report', status),
    activate: (threadId?: string | null) => ipcRenderer.invoke('pets:activate', threadId),
    spritesheet: (id: string) => ipcRenderer.invoke('pets:spritesheet', id),
    visual: (id: string, file?: string) => ipcRenderer.invoke('pets:visual', id, file),
    bounds: () => ipcRenderer.invoke('pets:bounds'),
    moveTo: (x: number, y: number) => ipcRenderer.invoke('pets:moveTo', x, y),
    endDrag: () => ipcRenderer.invoke('pets:endDrag'),
    create: (draft: PetDraft) => ipcRenderer.invoke('pets:create', draft),
    update: (id: string, draft: PetDraft) => ipcRenderer.invoke('pets:update', id, draft),
    delete: (id: string) => ipcRenderer.invoke('pets:delete', id),
    addAction: (petId: string, draft: PetActionDraft) =>
      ipcRenderer.invoke('pets:addAction', petId, draft),
    updateAction: (petId: string, actionId: string, draft: PetActionDraft) =>
      ipcRenderer.invoke('pets:updateAction', petId, actionId, draft),
    removeAction: (petId: string, actionId: string) =>
      ipcRenderer.invoke('pets:removeAction', petId, actionId),
    playAction: (actionId: string, petId?: string) => ipcRenderer.invoke('pets:playAction', actionId, petId),
    generateImages: (prompt: string, count?: 1 | 2 | 4) =>
      ipcRenderer.invoke('pets:generateImages', prompt, count),
    extractSubject: (imagePath: string, target?: string, options?: PetSubjectExtractionOptions) =>
      ipcRenderer.invoke('pets:extractSubject', imagePath, target, options),
    generateActionVideo: (petId: string, prompt: string) =>
      ipcRenderer.invoke('pets:generateActionSheet', petId, prompt),
    generateActionSheet: (petId: string, prompt: string, referencePath?: string, options?: PetActionGenerationOptions) =>
      ipcRenderer.invoke('pets:generateActionSheet', petId, prompt, referencePath, options),
    actionJobs: (petId: string) => ipcRenderer.invoke('pets:actionJobs', petId),
    pauseActionGeneration: (petId: string, jobId: string) => ipcRenderer.invoke('pets:pauseActionGeneration', petId, jobId),
    menu: () => ipcRenderer.invoke('pets:menu')
  },
  acp: {
    start: (opts?: { model?: string; effort?: Effort }) => ipcRenderer.invoke('acp:start', opts),
    newSession: (cwd: string, meta?: Record<string, unknown>) =>
      ipcRenderer.invoke('acp:newSession', cwd, meta),
    loadSession: (sessionId: string, cwd: string) =>
      ipcRenderer.invoke('acp:loadSession', sessionId, cwd),
    prompt: (
      text: string,
      sessionId: string,
      attachments?: PromptAttachment[],
      autoApprove?: boolean
    ) => ipcRenderer.invoke('acp:prompt', text, sessionId, attachments, autoApprove),
    cancel: (sessionId: string) => ipcRenderer.invoke('acp:cancel', sessionId),
    setMode: (modeId: string, sessionId?: string) =>
      ipcRenderer.invoke('acp:setMode', modeId, sessionId),
    permission: (id: number | string, optionId: string) =>
      ipcRenderer.invoke('acp:permission', id, optionId),
    deny: (id: number | string) => ipcRenderer.invoke('acp:deny', id)
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) return () => undefined
    const listener = (_event: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('grok', api)

export type GrokAPI = typeof api
