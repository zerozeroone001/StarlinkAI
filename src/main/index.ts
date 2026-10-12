import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, session, shell, type MenuItemConstructorOptions } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effort, HistoryCursor, Locale, PromptAttachment, RunMode, Theme } from '../shared/types'
import { GrokAcp, type AcpUpdate } from './acp'
import { readAuth } from './auth'
import { fileTree, gitState, readTextFile } from './git'
import { inspectFile, resolveMediaPath, resolveScopedMediaPath } from './preview'
import { findGrokBinary, grokHome } from './paths'
import {
  hideProject,
  importLocalProject,
  loadDesktopState,
  desktopStateHealth,
  mergeProjects,
  patchPrefs,
  renameProject as renameProjectState
} from './desktop-state'
import { deleteThread, listThreads, loadHistoryPage, projectsFromThreads, renameThread } from './sessions'
import { installWallpaper, removeWallpaperFiles, wallpaperPayload } from './wallpaper'
import { createSkill, listSkills, readSkill, setSkillDisabled } from './skills'
import { fetchUsage } from './usage'
import { inspectProviders } from './providers'
import { runtime, closeRuntime, runtimeHasActiveWork } from './runtime/service'
import { createPortableBackupService } from './portable-backup'
import { createProjectRelinkService } from './project-relink'
import { getAssistant, listDueAssistantCommitments, markAssistantCommitmentNotified } from './runtime/assistant-store'
import {
  activateFromPet,
  addPetAction,
  updatePetAction,
  createCustomPet,
  deleteCustomPet,
  destroyPetWindow,
  endPetDrag,
  extractPetSubject,
  generatePetActionSheet,
  generatePetImages,
  listPets,
  loadPetVisual,
  loadSpritesheet,
  movePetWindow,
  notifyPetChrome,
  petPublic,
  petSnapshot,
  petWindowBounds,
  playPetAction,
  petRendererSnapshot,
  petActionJobs,
  pausePetActionGeneration,
  registerPets,
  removePetAction,
  restorePetIfNeeded,
  selectPet,
  setPetStatus,
  showPetMenu,
  tuckPet,
  updateCustomPet,
  wakePet
} from './pets'
import { envProxy } from './http'
import { assertDesktopSender, isDesktopMain, registerDesktopWindow } from './desktop-security'
import { createWorkspaceLifecycle } from './workspace-lifecycle'
import type { PetActionDraft, PetActionGenerationOptions, PetDraft, PetLiveStatus, PetSubjectExtractionOptions, SkillScope } from '../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// productName changed from Grok to StarlinkAI. Keep an existing Chromium profile.
function adoptUserData(): void {
  const appData = app.getPath('appData')
  const next = path.join(appData, 'StarlinkAI')
  const legacy = path.join(appData, 'Grok')
  if (fs.existsSync(next) || !fs.existsSync(legacy)) return
  try {
    fs.renameSync(legacy, next)
  } catch {
    app.setPath('userData', legacy)
  }
}
adoptUserData()

if (is.dev && !app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9229')
}

const cliProxy = envProxy()
if (cliProxy) {
  app.commandLine.appendSwitch('proxy-server', `${cliProxy.hostname}:${cliProxy.port || 80}`)
  app.commandLine.appendSwitch('proxy-bypass-list', 'localhost;127.0.0.1;<local>')
}

let mainWindow: BrowserWindow | null = null
let acp: GrokAcp | null = null
let grokPath: string | null = findGrokBinary()
let starting: Promise<GrokAcp> | null = null
let workspaceLifecycle: ReturnType<typeof createWorkspaceLifecycle> | null = null
let closingRuntime = false
let runtimeClosed = false
let allowAppQuit = false
let runtimeClosing: Promise<void> | undefined
let workspaceMutations = 0
const portableBackup = createPortableBackupService({
  busy: () => closingRuntime || workspaceMutations > 0 || runtimeHasActiveWork() || projectRelink.locked(),
  chooseSourceDirectory: async (name, original) => {
    const options = { title: `确认“${name}”的备份文件来源（仅包含引用文件）`, defaultPath: original, properties: ['openDirectory'] as ('openDirectory')[] }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return selected.canceled ? null : selected.filePaths[0] || null
  },
  chooseArchive: async () => {
    const options = { title: '选择便携工作区备份', filters: [{ name: '便携工作区备份', extensions: ['zip'] }], properties: ['openFile'] as ('openFile')[] }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return selected.canceled ? null : selected.filePaths[0] || null
  },
  chooseDestination: async () => {
    const options = { title: '保存便携工作区备份', defaultPath: `workspace-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: '便携工作区备份', extensions: ['zip'] }] }
    const selected = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    return selected.canceled ? null : selected.filePath || null
  }
})
const projectRelink = createProjectRelinkService({
  busy: () => closingRuntime || workspaceMutations > 0 || runtimeHasActiveWork() || portableBackup.locked(),
  chooseDirectory: async (original) => {
    const options = { title: '重新关联项目源码目录', defaultPath: original, properties: ['openDirectory'] as ('openDirectory')[] }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return selected.canceled ? null : selected.filePaths[0] || null
  },
  chooseSourceDirectory: async (name, original) => {
    const options = { title: `确认“${name}”的原文件来源（仅保存引用附件和图片）`, defaultPath: original, properties: ['openDirectory'] as ('openDirectory')[] }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return selected.canceled ? null : selected.filePaths[0] || null
  }
})
const workspaceWriteChannels = new Set(['workspace:clearAssistant', 'workspace:updateAssistant', 'workspace:saveMemory',
  'workspace:forgetMemory', 'workspace:saveCommitment', 'workspace:deleteCommitment', 'workspace:prepareDirectory',
  'workspace:upload', 'workspace:createSkill', 'workspace:toggleSkill', 'workspace:start', 'workspace:permission', 'backup:setRemindersPaused'])

async function finishApplicationExit(force = false): Promise<void> {
  closingRuntime = true
  acp?.stop()
  if (!runtimeClosing) {
    runtimeClosing = closeRuntime().then(() => { runtimeClosed = true })
    void runtimeClosing.catch(() => {})
  }
  if (!runtimeClosed && !force) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([runtimeClosing, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('后台记录保存尚未确认。')), 10000)
      })])
    } catch {
      throw new Error('后台任务已停止，记录保存尚未确认。保留窗口可导出备份；继续使用需重新启动应用。')
    } finally { clearTimeout(timer) }
  }
  allowAppQuit = true
  app.quit()
}

function guardReloadMenu(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const clone = (items: Electron.MenuItem[]): MenuItemConstructorOptions[] => items.map((item) => {
    const base: MenuItemConstructorOptions = { id: item.id, label: item.label, sublabel: item.sublabel,
      type: item.type, enabled: item.enabled, visible: item.visible, checked: item.checked,
      accelerator: item.accelerator || undefined, icon: item.icon }
    if (item.role === 'reload' || item.role === 'forceReload') return { ...base, click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) void workspaceLifecycle?.request('reload')
    } }
    return { ...base, role: item.role as MenuItemConstructorOptions['role'], click: (menuItem, window, event) => item.click.call(item, menuItem, window, event),
      ...(item.submenu ? { submenu: clone(item.submenu.items) } : {}) }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(clone(menu.items)))
}
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertDesktopSender(event, channel)
    if (workspaceWriteChannels.has(channel)) {
      if (portableBackup.locked() || projectRelink.locked()) throw new Error('正在备份、恢复或关联目录，请完成或取消后重试。')
      workspaceMutations++
      try { return Promise.resolve(listener(event, ...args)).finally(() => { workspaceMutations-- }) }
      catch (error) { workspaceMutations--; throw error }
    }
    return listener(event, ...args)
  })
}

function iconPath(): string {
  const prod = path.join(process.resourcesPath, 'icon.png')
  const dev = path.join(app.getAppPath(), 'resources', 'icon.png')
  if (fs.existsSync(prod)) return prod
  if (fs.existsSync(dev)) return dev
  return path.join(__dirname, '../../resources/icon.png')
}

function overlayFor(theme: Theme) {
  return theme === 'light'
    ? { color: '#f7f7f8', symbolColor: '#0d0d0d', height: 36 }
    : { color: '#171717', symbolColor: '#ececec', height: 36 }
}

function applyChrome(theme: Theme): void {
  if (!mainWindow) return
  mainWindow.setBackgroundColor(theme === 'light' ? '#f7f7f8' : '#171717')
  mainWindow.setTitleBarOverlay(overlayFor(theme))
}

function defaultLocale(): Locale {
  const loc = (app.getLocale() || '').toLowerCase()
  return loc.startsWith('zh') ? 'zh-CN' : 'en'
}

function preloadPath(): string {
  const preload = path.join(__dirname, '../preload/index.cjs')
  if (!fs.existsSync(preload)) throw new Error('桌面组件不完整，请重新安装应用或执行 npm run build。')
  return preload
}

function createWindow(): void {
  const theme = loadDesktopState().theme
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    title: 'StarlinkAI',
    backgroundColor: theme === 'light' ? '#f7f7f8' : '#171717',
    icon: iconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(theme),
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  registerDesktopWindow(mainWindow, {
    role: 'main', entry: path.join(__dirname, '../renderer/index.html'),
    devEntry: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  })
  const window = mainWindow
  const lifecycle = createWorkspaceLifecycle({
    available: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
    prepare: (id) => window.webContents.send('workspace:prepare-close', id),
    resume: () => { if (!window.isDestroyed()) window.webContents.send('workspace:resume') },
    confirmDiscard: async (error, action) => {
      if (window.isDestroyed()) return false
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', title: '工作区尚未确认保存', message: '保留当前窗口以保护未保存的修改？',
        detail: `${error}\n\n选择放弃后，尚未写入磁盘的修改可能丢失。`,
        buttons: ['保留窗口', action === 'reload' ? '放弃未保存内容并重新载入' : '放弃未保存内容并退出'],
        defaultId: 0, cancelId: 0, noLink: true
      })
      return answer.response === 1
    },
    perform: async (action, force) => {
      if (action === 'reload') {
        if (!window.isDestroyed()) window.webContents.reload()
      } else if (action === 'close' && process.platform === 'darwin') {
        if (!window.isDestroyed()) window.close()
      } else await finishApplicationExit(force)
    }
  })
  workspaceLifecycle = lifecycle
  window.on('close', (event) => {
    if (allowAppQuit || lifecycle.canUnload) return
    event.preventDefault()
    void lifecycle.request('close')
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.code === 'F5' || input.key === 'F5' ||
      ((input.control || input.meta) && (input.code === 'KeyR' || input.key.toLowerCase() === 'r')))) return
    event.preventDefault()
    void lifecycle.request('reload')
  })
  window.webContents.on('will-prevent-unload', (event) => {
    if (allowAppQuit || lifecycle.canUnload) { event.preventDefault(); return }
    // Leave the original navigation cancelled while the async save is pending.
    void lifecycle.request('reload')
  })
  window.webContents.on('did-navigate', () => lifecycle.invalidate())
  let recovering = false
  const recover = async (detail: string) => {
    if (recovering || window.isDestroyed()) return
    recovering = true
    try {
      window.show()
      const answer = await dialog.showMessageBox(window, {
        type: 'error', title: '工作区暂时无法显示', message: '重新载入工作区？',
        detail: `${detail}\n已保存的对话和项目仍会保留。后台任务不会自动重复执行。`,
        buttons: ['重新载入', '暂不处理'], defaultId: 0, cancelId: 1, noLink: true
      })
      if (answer.response === 0 && !window.isDestroyed()) await lifecycle.request('reload')
    } finally { recovering = false }
  }
  window.webContents.on('render-process-gone', (_event, details) => {
    lifecycle.invalidate()
    if (details.reason !== 'clean-exit') void recover('页面进程意外退出。').catch(() => {})
  })
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void recover('页面加载失败。').catch(() => {})
  })
  mainWindow.on('ready-to-show', () => window.show())
  mainWindow.on('closed', () => {
    lifecycle.invalidate()
    if (workspaceLifecycle === lifecycle) workspaceLifecycle = null
    mainWindow = null
    destroyPetWindow()
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const url = new URL(target)
      const dev = process.env['ELECTRON_RENDERER_URL']
      const devUrl = dev ? new URL(dev) : null
      const isDevEntry = Boolean(
        devUrl &&
          url.origin === devUrl.origin &&
          (url.pathname === devUrl.pathname || url.pathname === `${devUrl.pathname.replace(/\/$/, '')}/`)
      )
      const isProdEntry = url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(__dirname, '../renderer/index.html')
      if (isDevEntry || isProdEntry) return
      event.preventDefault()
      if (/^https?:$/i.test(url.protocol) && (!devUrl || url.origin !== devUrl.origin)) {
        void shell.openExternal(target).catch(() => {})
      }
    } catch {
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  guardReloadMenu()
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function grokVersion(): string | null {
  const file = path.join(grokHome(), 'version.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }
    return raw.version || null
  } catch {
    return null
  }
}

async function ensureAcp(opts?: { model?: string; effort?: string }): Promise<GrokAcp> {
  grokPath = findGrokBinary()
  if (!grokPath) throw new Error('Grok CLI not found. Install with irm https://x.ai/cli/install.ps1 | iex')
  if (acp?.connected) return acp
  if (starting) return starting
  starting = (async () => {
    if (!acp?.connected) {
      acp?.stop()
      acp = new GrokAcp(grokPath!, opts)
      acp.on('update', (update: AcpUpdate) => send('grok:update', update))
      acp.on('permission', (req) => send('grok:permission', req))
      acp.on('exit', () => send('grok:disconnected', null))
      acp.on('log', (line: string) => send('grok:log', line))
      await acp.start()
      send('grok:connected', { grokPath })
    }
    return acp!
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

function readTomlValue(file: string, key: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, 'm')
    return re.exec(text)?.[1]?.trim() || null
  } catch {
    return null
  }
}

function wallpaperPublic() {
  const state = loadDesktopState()
  if (!state.wallpaperFile || !fs.existsSync(state.wallpaperFile)) return null
  return {
    name: state.wallpaperName || path.basename(state.wallpaperFile),
    opacity: state.wallpaperOpacity
  }
}

async function pickImageFile(): Promise<string | null> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const opts = {
    title: 'Choose background image',
    defaultPath: app.getPath('pictures'),
    properties: ['openFile' as const, 'dontAddToRecent' as const],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const res = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
}

function snapshot() {
  const threads = listThreads()
  const configFile = path.join(grokHome(), 'config.toml')
  if (desktopStateHealth().status === 'new') {
    patchPrefs({ locale: defaultLocale() })
  }
  const prefs = loadDesktopState()
  const projects = mergeProjects(projectsFromThreads(threads))
  return {
    auth: readAuth(),
    desktopStateHealth: desktopStateHealth(),
    grokPath,
    grokVersion: null as string | null,
    connected: Boolean(acp?.connected),
    theme: prefs.theme,
    locale: prefs.locale,
    projects,
    threads,
    model: prefs.model || readTomlValue(configFile, 'default') || 'grok-4.6',
    effort: (prefs.effort || readTomlValue(configFile, 'default_reasoning_effort') || 'xhigh') as Effort,
    runMode: 'local' as RunMode,
    permissionMode: prefs.permissionMode,
    wallpaper: wallpaperPublic(),
    skills: listSkills(projects[0]?.path),
    pet: petPublic()
  }
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  electronApp.setAppUserModelId('ai.starlinkai.desktop')
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && isDesktopMain(contents))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    permission === 'clipboard-sanitized-write' && isDesktopMain(contents))
  if (cliProxy) {
    try {
      await session.defaultSession.setProxy({
        proxyRules: `${cliProxy.hostname}:${cliProxy.port || 80}`,
        proxyBypassRules: 'localhost,127.0.0.1,<local>'
      })
    } catch {
      /* ignore */
    }
  }
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerPets({
    getMain: () => mainWindow,
    preloadPath,
    sendMain: send
  })

  handle('providers:inspect', () => inspectProviders())
  handle('projectRelink:prepare', (_e, text, id) => projectRelink.prepare(text, id))
  handle('projectRelink:commit', (_e, token, allowIncomplete) => projectRelink.commit(token, allowIncomplete))
  handle('projectRelink:finish', (_e, token) => projectRelink.finish(token))
  handle('projectRelink:cancel', (_e, token) => projectRelink.cancel(token))
  handle('projectRelink:status', () => projectRelink.status())
  handle('backup:beginExport', (_e, text) => portableBackup.beginExport(text))
  handle('backup:inspectImport', () => portableBackup.inspectImport())
  handle('backup:writeExport', (_e, token, allowIncomplete) => portableBackup.writeExport(token, allowIncomplete))
  handle('backup:prepareRestore', (_e, token, allowIncomplete) => portableBackup.prepareRestore(token, allowIncomplete))
  handle('backup:prepareRollback', () => portableBackup.prepareRollback())
  handle('backup:reconcile', async (_e, marker, scopes) => {
    await portableBackup.reconcile(marker, scopes)
    await projectRelink.reconcileAfterWorkspaceRead()
    for (const [key, notification] of reminders) if (!portableBackup.activeScopes().some((scope) => key.startsWith(`${scope}:`))) {
      try { notification.close() } catch { /* Old notifications must not keep a retired scope alive. */ }
      reminders.delete(key)
    }
  })
  handle('backup:cancel', (_e, token) => portableBackup.cancel(token))
  handle('backup:status', () => portableBackup.status())
  handle('backup:setRemindersPaused', (_e, scopeId, paused, revision) => portableBackup.setRemindersPaused(scopeId, paused, revision))
  handle('workspace:providers', (_e, refresh, ids) => {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => !['claude', 'codex', 'grok', 'gemini'].includes(id))))
      throw new Error('未知模型提供商')
    return runtime.providers(!!refresh, ids)
  })
  handle('workspace:persistence-ready', (event) => {
    if (event.sender !== mainWindow?.webContents || !isDesktopMain(event.sender)) throw new Error('此页面无权注册工作区保存。')
    workspaceLifecycle?.ready()
  })
  handle('workspace:persistence-respond', (event, id, result) => {
    if (event.sender !== mainWindow?.webContents || !isDesktopMain(event.sender) || !workspaceLifecycle)
      throw new Error('此页面无权确认工作区保存。')
    workspaceLifecycle.receive(id, result)
  })
  handle('workspace:assistant', (_e, scopeId) => runtime.assistant(scopeId))
  handle('workspace:clearAssistant', async (_e, scopeId) => {
    const snapshot = await runtime.clearAssistant(scopeId)
    for (const [key, notification] of reminders) {
      if (!key.startsWith(`${scopeId}:`)) continue
      try { notification.close() } catch { /* The cleared scope remains authoritative. */ }
      reminders.delete(key)
    }
    return snapshot
  })
  handle('workspace:updateAssistant', (_e, scopeId, patch) => runtime.updateAssistant(scopeId, patch))
  handle('workspace:saveMemory', (_e, scopeId, input) => runtime.saveMemory(scopeId, input))
  handle('workspace:forgetMemory', (_e, scopeId, id) => runtime.forgetMemory(scopeId, id))
  handle('workspace:saveCommitment', (_e, scopeId, input) => runtime.saveCommitment(scopeId, input))
  handle('workspace:deleteCommitment', (_e, scopeId, id) => runtime.deleteCommitment(scopeId, id))
  handle('workspace:prepareDirectory', (_e, input) => runtime.prepareDirectory(input))
  handle('workspace:media', (_e, id, source, directory) => runtime.media(id, source, directory))
  handle('workspace:upload', (_e, id, input, directory) => runtime.upload(id, input, directory))
  handle('workspace:skills', (_e, id, directory) => runtime.skills(id, directory))
  handle('workspace:readSkill', (_e, id, file, directory) => runtime.readSkill(id, file, directory))
  handle('workspace:createSkill', (_e, id, input, directory) => runtime.createSkill(id, input, directory))
  handle('workspace:toggleSkill', (_e, id, name, disabled, directory) => runtime.toggleSkill(id, name, disabled, directory))
  handle('workspace:start', (_e, request) => runtime.start(request))
  handle('workspace:run', (_e, id) => runtime.run(id))
  handle('workspace:cancel', (_e, id) => runtime.cancel(id))
  handle('workspace:permission', (_e, id, permissionId, option) => runtime.permission(id, permissionId, option))
  handle('workspace:login', (_e, provider) => runtime.login(provider))
  handle('workspace:loginStatus', (_e, provider) => runtime.loginStatus(provider))
  app.on('before-quit', (event) => {
    if (allowAppQuit) return
    event.preventDefault()
    if (workspaceLifecycle && mainWindow && !mainWindow.isDestroyed()) {
      void workspaceLifecycle.request('quit')
    } else {
      void finishApplicationExit().catch(async () => {
        const answer = await dialog.showMessageBox({ type: 'warning', title: '后台记录尚未确认保存',
          message: '后台记录未能完成保存。', detail: '等待后可重试退出；强制退出可能丢失尚未保存的执行记录。',
          buttons: ['继续等待', '放弃未保存记录并退出'], defaultId: 0, cancelId: 0, noLink: true })
        if (answer.response === 1) await finishApplicationExit(true)
      })
    }
  })
  handle('app:snapshot', async () => {
    const snap = snapshot()
    snap.grokVersion = grokVersion()
    return snap
  })
  handle('app:threads', () => listThreads())
  handle('app:refresh', () => {
    const threads = listThreads()
    return { threads, projects: mergeProjects(projectsFromThreads(threads)) }
  })
  handle('app:renameThread', (_e, id: string, cwd: string, title: string) =>
    renameThread(id, cwd, title)
  )
  handle('app:deleteThread', (_e, id: string, cwd: string) => deleteThread(id, cwd))
  handle('app:renameProject', (_e, projectPath: string, name: string) => {
    renameProjectState(projectPath, name)
    const threads = listThreads()
    return mergeProjects(projectsFromThreads(threads))
  })
  handle('app:removeProject', (_e, projectPath: string) => {
    hideProject(projectPath)
    const threads = listThreads()
    return mergeProjects(projectsFromThreads(threads))
  })
  handle('app:addProject', (_e, folder: string) => {
    importLocalProject(folder)
    const threads = listThreads()
    return mergeProjects(projectsFromThreads(threads))
  })
  handle('app:history', (_e, id: string, cwd: string, cursor?: HistoryCursor | null) =>
    loadHistoryPage(id, cwd, cursor)
  )
  handle('app:git', (_e, cwd: string) => gitState(cwd))
  handle('app:tree', (_e, cwd: string) => fileTree(cwd))
  handle('app:readFile', (_e, file: string) => readTextFile(file))
  handle(
    'app:previewFile',
    (_e, file: string, ctx?: { cwd?: string; sessionId?: string }) => {
      const raw = String(file || '')
      // An automatic preview without a known scope must fail closed. Only the
      // explicit user-selected file flow omits the context argument entirely.
      const scoped = ctx !== undefined
      const resolved = scoped ? resolveScopedMediaPath(raw, ctx?.cwd, ctx?.sessionId) : raw
      if (!resolved) throw new Error('无法预览项目或当前会话之外的文件。')
      return inspectFile(resolved)
    }
  )
  handle(
    'app:saveMedia',
    async (
      _e,
      payload: { dataUrl?: string; path?: string; name?: string; cwd?: string; sessionId?: string }
    ) => {
      const resolved = payload.path && !/^data:image\//i.test(payload.dataUrl || '')
        ? resolveScopedMediaPath(payload.path, payload.cwd, payload.sessionId)
        : null
      const fallbackName =
        payload.name ||
        (resolved ? path.basename(resolved) : 'image.jpg')
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      const res = parent
        ? await dialog.showSaveDialog(parent, {
            title: 'Save image',
            defaultPath: path.join(app.getPath('pictures'), fallbackName),
            filters: [
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
              { name: 'All files', extensions: ['*'] }
            ]
          })
        : await dialog.showSaveDialog({
            title: 'Save image',
            defaultPath: path.join(app.getPath('pictures'), fallbackName),
            filters: [
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
              { name: 'All files', extensions: ['*'] }
            ]
          })
      if (res.canceled || !res.filePath) return null
      if (resolved && fs.existsSync(resolved)) {
        fs.copyFileSync(resolved, res.filePath)
        return res.filePath
      }
      const dataUrl = payload.dataUrl || ''
      if (/^https?:\/\//i.test(dataUrl)) {
        const response = await net.fetch(dataUrl, { signal: AbortSignal.timeout(30000) })
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/') || !response.body)
          throw new Error('无法下载图片')
        const reader = response.body.getReader()
        const chunks: Buffer[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 32 * 1024 * 1024) throw new Error('图片超过 32 MB')
            chunks.push(Buffer.from(value))
          }
        } finally { await reader.cancel() }
        fs.writeFileSync(res.filePath, Buffer.concat(chunks))
        return res.filePath
      }
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
      if (!match) throw new Error('No image data to save')
      fs.writeFileSync(res.filePath, Buffer.from(match[2], 'base64'))
      return res.filePath
    }
  )
  handle('app:openPath', (_e, target: string) => shell.openPath(target))
  handle('app:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      throw new Error('Only http(s) URLs can be opened')
    }
    return shell.openExternal(url)
  })
  handle('app:savePrefs', (_e, patch: Record<string, unknown>) => {
    const next = patchPrefs(patch)
    if (patch.theme === 'dark' || patch.theme === 'light') applyChrome(patch.theme)
    if (patch.theme || patch.locale) notifyPetChrome(next.theme, next.locale)
    return {
      theme: next.theme,
      locale: next.locale,
      permissionMode: next.permissionMode,
      model: next.model,
      effort: next.effort,
      wallpaper: wallpaperPublic()
    }
  })
  handle('skills:list', (_e, cwd?: string) => listSkills(cwd))
  handle('skills:read', (_e, file: string) => readSkill(file))
  handle('skills:setDisabled', (_e, name: string, disabled: boolean, cwd?: string) =>
    setSkillDisabled(String(name || ''), Boolean(disabled), cwd)
  )
  handle(
    'skills:create',
    (
      _e,
      input: { name: string; description: string; scope: SkillScope; cwd?: string }
    ) => createSkill(input)
  )
  handle('pets:list', () => listPets())
  handle('pets:snapshot', () => petRendererSnapshot())
  handle('pets:wake', () => wakePet())
  handle('pets:tuck', () => tuckPet())
  handle('pets:select', (_e, id: string) => selectPet(String(id || '')))
  handle('pets:report', (_e, status: PetLiveStatus) => {
    if (status && typeof status === 'object') setPetStatus(status)
  })
  handle('pets:activate', (_e, threadId?: string | null) => activateFromPet(threadId))
  handle('pets:spritesheet', (_e, id: string) => loadSpritesheet(String(id || '')))
  handle('pets:visual', (_e, id: string, file?: string) =>
    loadPetVisual(String(id || ''), file ? String(file) : undefined)
  )
  handle('pets:bounds', () => petWindowBounds())
  handle('pets:moveTo', (_e, x: number, y: number) => movePetWindow(Number(x), Number(y)))
  handle('pets:endDrag', () => endPetDrag())
  handle('pets:create', (_e, draft: PetDraft) => createCustomPet(draft))
  handle('pets:update', (_e, id: string, draft: PetDraft) => updateCustomPet(String(id || ''), draft))
  handle('pets:delete', (_e, id: string) => deleteCustomPet(String(id || '')))
  handle('pets:addAction', (_e, petId: string, draft: PetActionDraft) =>
    addPetAction(String(petId || ''), draft)
  )
  handle('pets:removeAction', (_e, petId: string, actionId: string) =>
    removePetAction(String(petId || ''), String(actionId || ''))
  )
  handle('pets:updateAction', (_e, petId: string, actionId: string, draft: PetActionDraft) =>
    updatePetAction(String(petId || ''), String(actionId || ''), draft)
  )
  handle('pets:playAction', (_e, actionId: string, petId?: string) => playPetAction(String(actionId || ''), petId ? String(petId) : undefined))
  handle('pets:generateImages', (_e, prompt: string, count?: number) =>
    generatePetImages(String(prompt || ''), Number(count || 4))
  )
  handle('pets:extractSubject', (_e, imagePath: string, target?: string, options?: PetSubjectExtractionOptions) =>
    extractPetSubject(String(imagePath || ''), String(target || ''), { forceRegenerate: options?.forceRegenerate === true })
  )
  const generateActionSheet = (event: Electron.IpcMainInvokeEvent, petId: string, prompt: string, referencePath?: string, options?: PetActionGenerationOptions) =>
    generatePetActionSheet(String(petId || ''), String(prompt || ''), referencePath ? String(referencePath) : undefined, options || {}, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('pets:actionProgress', progress)
    })
  handle('pets:generateActionSheet', generateActionSheet)
  handle('pets:actionJobs', (_e, petId: string) => petActionJobs(String(petId || '')))
  handle('pets:pauseActionGeneration', (_e, petId: string, jobId: string) => pausePetActionGeneration(String(petId || ''), String(jobId || '')))
  // Old preload clients still reach the image-only implementation after a main-process restart.
  handle('pets:generateActionVideo', generateActionSheet)
  handle('pets:menu', () => showPetMenu())
  handle('usage:fetch', () => fetchUsage())
  handle('app:pickImage', () => pickImageFile())
  handle('app:chooseWallpaper', async () => {
    const file = await pickImageFile()
    if (!file) return { wallpaper: null }
    return { wallpaper: installWallpaper(file) }
  })
  handle('app:wallpaperData', () => wallpaperPayload())
  handle('app:setWallpaper', async (_e, file: string) => {
    return { wallpaper: installWallpaper(file) }
  })
  handle('app:clearWallpaper', () => {
    removeWallpaperFiles()
    patchPrefs({ wallpaperFile: null, wallpaperName: null })
    return { wallpaper: null }
  })
  handle('app:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('app:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Rive animations', extensions: ['riv'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('win:minimize', () => mainWindow?.minimize())
  handle('win:maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  handle('win:close', () => mainWindow?.close())
  handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false)

  handle('acp:start', async (_e, opts: { model?: string; effort?: string }) => {
    const client = await ensureAcp(opts)
    return { connected: client.connected, grokPath }
  })
  handle(
    'acp:newSession',
    async (_e, cwd: string, meta: Record<string, unknown>) => {
      const client = await ensureAcp()
      const id = await client.newSession(cwd, meta)
      return { sessionId: id }
    }
  )
  handle('acp:loadSession', async (_e, sessionId: string, cwd: string) => {
    const client = await ensureAcp()
    const id = await client.loadSession(sessionId, cwd)
    return { sessionId: id }
  })
  handle(
    'acp:prompt',
    async (
      _e,
      text: string,
      sessionId: string,
      attachments?: PromptAttachment[],
      autoApprove?: boolean
    ) => {
      if (!sessionId) throw new Error('No session')
      const client = await ensureAcp()
      return client.prompt(text, sessionId, attachments || [], autoApprove)
    }
  )
  handle('acp:cancel', (_e, sessionId?: string) => {
    acp?.cancel(sessionId)
  })
  handle('acp:setMode', (_e, modeId: string, sessionId?: string) =>
    acp?.setMode(modeId, sessionId)
  )
  handle('acp:permission', (_e, id: number | string, optionId: string) => {
    acp?.respondPermission(id, optionId)
  })
  handle('acp:deny', (_e, id: number | string) => acp?.denyPermission(id))

  createWindow()
  // Waking a pet persists its position/preferences. Preserve recovery files
  // until the user has inspected and explicitly changed recovered settings.
  if (['new', 'ready'].includes(desktopStateHealth().status)) restorePetIfNeeded()

  let checkingReminders = false
  const reminders = new Map<string, Notification>()
  const checkReminders = async () => {
    if (checkingReminders || closingRuntime || portableBackup.locked() || !Notification.isSupported()) return
    checkingReminders = true
    try {
      for (const { scopeId, commitment } of await listDueAssistantCommitments(Date.now(), portableBackup.activeScopes())) {
        if (closingRuntime || portableBackup.locked()) break
        const key = `${scopeId}:${commitment.id}`
        if (reminders.has(key)) continue
        const latest = await getAssistant(scopeId)
        const current = latest.commitments.find((item) => item.id === commitment.id)
        if (closingRuntime || portableBackup.locked() || !portableBackup.activeScopes().includes(scopeId) || latest.remindersPaused || !current || current.status !== 'open' || current.notifiedAt || current.dueAt !== commitment.dueAt || Date.parse(current.dueAt!) > Date.now()) continue
        const notification = new Notification({ title: `${latest.profile.name} · 提醒`, body: current.title })
        reminders.set(key, notification)
        notification.once('show', () => {
          void markAssistantCommitmentNotified(scopeId, commitment.id, commitment.dueAt!, new Date().toISOString()).catch(() => {})
        })
        notification.once('click', () => {
          if (!mainWindow) createWindow()
          if (mainWindow?.isMinimized()) mainWindow.restore()
          mainWindow?.show()
          mainWindow?.focus()
        })
        notification.once('close', () => reminders.delete(key))
        notification.once('failed', () => reminders.delete(key))
        try { notification.show() } catch { reminders.delete(key) }
      }
    } catch { /* An unreadable profile must not prevent other desktop features from starting. */ }
    finally { checkingReminders = false }
  }
  void checkReminders()
  const reminderTimer = setInterval(() => void checkReminders(), 30000)
  reminderTimer.unref()
  app.on('will-quit', () => clearInterval(reminderTimer))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(() => {
  dialog.showErrorBox('无法启动桌面应用', '桌面组件加载失败。请重新安装应用；开发环境请先执行 npm run build。已保存的用户数据不会被清除。')
  app.quit()
})

app.on('window-all-closed', () => {
  destroyPetWindow()
  acp?.stop()
  if (process.platform !== 'darwin') app.quit()
})
