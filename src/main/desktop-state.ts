import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PET_ID, LEGACY_PET_IDS, type Effort, type Project, type UiPrefs } from '../shared/types'
import { desktopStatePath } from './paths'
import { readBoundedFile } from './file-boundary'

export interface DesktopState extends UiPrefs {
  projects: Project[]
  hiddenProjects: string[]
}

const EFFORTS: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh']

function empty(): DesktopState {
  return {
    projects: [],
    hiddenProjects: [],
    theme: 'dark',
    locale: 'en',
    permissionMode: 'ask',
    wallpaperFile: null,
    wallpaperName: null,
    wallpaperOpacity: 40,
    disabledSkills: [],
    petAwake: false,
    petId: DEFAULT_PET_ID,
    petX: null,
    petY: null
  }
}

const MAX_STATE_BYTES = 16 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value: unknown, max = 32768): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
}

function coerce(raw: unknown, issues: string[] = []): DesktopState {
  const base = empty()
  if (!record(raw)) return base
  const checked = <T>(key: string, valid: boolean, value: T, fallback: T): T => {
    if (valid) return value
    if (raw[key] !== undefined) issues.push(key)
    return fallback
  }
  const projects: Project[] = []
  if (Array.isArray(raw.projects)) {
    for (const candidate of raw.projects) {
      if (!record(candidate) || !safeText(candidate.path)) { issues.push('projects'); continue }
      const project: Project = {
        path: candidate.path,
        id: safeText(candidate.id) ? candidate.id : candidate.path,
        name: safeText(candidate.name) ? candidate.name : path.basename(candidate.path) || candidate.path
      }
      if (!safeText(candidate.id) || !safeText(candidate.name)) issues.push('projects')
      if (candidate.branch !== undefined) {
        if (typeof candidate.branch === 'string') project.branch = candidate.branch
        else issues.push('projects')
      }
      if (candidate.lastActiveAt !== undefined) {
        if (safeText(candidate.lastActiveAt, 100) && Number.isFinite(Date.parse(candidate.lastActiveAt)))
          project.lastActiveAt = candidate.lastActiveAt
        else issues.push('projects')
      }
      projects.push(project)
    }
  } else if (raw.projects !== undefined) issues.push('projects')
  const stringList = (key: string, maximum: number) => {
    const value = raw[key]
    if (!Array.isArray(value)) {
      if (value !== undefined) issues.push(key)
      return []
    }
    const items = value.filter((item): item is string => safeText(item, maximum))
    if (items.length !== value.length) issues.push(key)
    return [...new Set(items)]
  }
  const numeric = (value: unknown) => (typeof value === 'number' ||
    (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value))
  const effort = EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : undefined
  if (raw.effort !== undefined && !effort) issues.push('effort')
  const coordinate = (key: 'petX' | 'petY') => raw[key] === null || raw[key] === undefined
    ? null : checked(key, !!numeric(raw[key]), Math.round(Number(raw[key])), null)
  const petId = checked('petId', safeText(raw.petId, 256), raw.petId as string, DEFAULT_PET_ID)
  return {
    projects,
    hiddenProjects: stringList('hiddenProjects', 32768),
    theme: checked('theme', raw.theme === 'light' || raw.theme === 'dark', raw.theme as DesktopState['theme'], base.theme),
    locale: checked('locale', raw.locale === 'zh-CN' || raw.locale === 'en', raw.locale as DesktopState['locale'], base.locale),
    permissionMode: checked('permissionMode', ['ask', 'auto', 'review'].includes(raw.permissionMode as string), raw.permissionMode as DesktopState['permissionMode'], base.permissionMode),
    model: checked('model', typeof raw.model === 'string' && raw.model.length <= 300, raw.model as string, undefined),
    effort,
    wallpaperFile: checked('wallpaperFile', raw.wallpaperFile === null || safeText(raw.wallpaperFile), raw.wallpaperFile as string | null, null),
    wallpaperName: checked('wallpaperName', raw.wallpaperName === null || typeof raw.wallpaperName === 'string', raw.wallpaperName as string | null, null),
    wallpaperOpacity: checked('wallpaperOpacity', !!numeric(raw.wallpaperOpacity), Math.min(100, Math.max(0, Math.round(Number(raw.wallpaperOpacity)))), 40),
    disabledSkills: stringList('disabledSkills', 256),
    petAwake: checked('petAwake', typeof raw.petAwake === 'boolean', raw.petAwake as boolean, false),
    petId: Object.hasOwn(LEGACY_PET_IDS, petId) ? LEGACY_PET_IDS[petId] : petId,
    petX: coordinate('petX'),
    petY: coordinate('petY')
  }
}

export interface DesktopStateHealth {
  status: 'new' | 'ready' | 'recovered' | 'partial' | 'damaged'
  path: string
  backupPath: string
  message?: string
  invalidFields?: string[]
}

type StateRecord = { status: 'valid'; text: string; state: DesktopState; issues: string[] }
  | { status: 'missing' | 'invalid' }

function readRecord(file: string): StateRecord {
  try {
    const text = readBoundedFile(file, MAX_STATE_BYTES).toString('utf8')
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!record(raw)) return { status: 'invalid' }
    const issues: string[] = []
    return { status: 'valid', text, state: coerce(raw, issues), issues: [...new Set(issues)] }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' }
  }
}

function readState() {
  const file = desktopStatePath(), backupPath = `${file}.bak`
  const primary = readRecord(file)
  const backup = primary.status === 'valid' && !primary.issues.length ? undefined : readRecord(backupPath)
  const selected = primary.status === 'valid' ? primary : backup?.status === 'valid' ? backup : undefined
  let status: DesktopStateHealth['status']
  let message: string | undefined
  if (primary.status === 'valid') {
    status = primary.issues.length ? 'partial' : 'ready'
    if (status === 'partial') message = '桌面设置中部分字段无效，已保留可用项目与设置；原始文件尚未改动。'
  } else if (selected) {
    status = 'recovered'
    message = '桌面设置主文件无法读取，当前使用上一份可用备份；最近一次设置变更可能需要重新进行。'
  } else if (primary.status === 'missing' && backup?.status === 'missing') {
    status = 'new'
  } else {
    status = 'damaged'
    message = '桌面设置及备份均无法读取，当前使用临时默认设置；已停止保存以保留原文件，请先恢复设置文件。'
  }
  const health: DesktopStateHealth = { status, path: file, backupPath,
    ...(message ? { message } : {}), ...(selected?.issues.length ? { invalidFields: selected.issues } : {}) }
  return { state: selected?.state || empty(), health, primary, backup }
}

/** Loading never repairs, replaces, or discards an on-disk recovery candidate. */
export function loadDesktopState(): DesktopState {
  return readState().state
}

export function desktopStateHealth(): DesktopStateHealth {
  return readState().health
}

function atomicStateWrite(file: string, text: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* Replacement consumed the file, or a failed write left no file. */ }
  }
}

export function saveDesktopState(state: DesktopState): void {
  const current = readState()
  if (current.health.status === 'damaged') throw new Error(current.health.message)
  const text = JSON.stringify(coerce(state), null, 2)
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw new Error('桌面设置超过大小限制，尚未写入。')
  if (current.primary.status === 'valid' && !current.primary.issues.length &&
    JSON.stringify(current.primary.state, null, 2) === text) return
  fs.mkdirSync(path.dirname(current.health.path), { recursive: true })
  // A recovery save must never rotate the damaged primary over its only usable backup.
  if (current.primary.status === 'valid' && !current.primary.issues.length)
    atomicStateWrite(current.health.backupPath, current.primary.text)
  else if (current.backup?.status !== 'valid')
    atomicStateWrite(current.health.backupPath, current.primary.status === 'valid' ? current.primary.text : text)
  atomicStateWrite(current.health.path, text)
}

export function patchPrefs(patch: Partial<UiPrefs>): DesktopState {
  const state = loadDesktopState()
  const next = coerce({ ...state, ...patch })
  next.projects = state.projects
  next.hiddenProjects = state.hiddenProjects
  saveDesktopState(next)
  return next
}

export function uiPrefs(state: DesktopState = loadDesktopState()): UiPrefs {
  return {
    theme: state.theme,
    locale: state.locale,
    permissionMode: state.permissionMode,
    model: state.model,
    effort: state.effort,
    wallpaperFile: state.wallpaperFile,
    wallpaperName: state.wallpaperName,
    wallpaperOpacity: state.wallpaperOpacity,
    disabledSkills: state.disabledSkills,
    petAwake: state.petAwake,
    petId: state.petId,
    petX: state.petX,
    petY: state.petY
  }
}

function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

/** User-added folders only. Grok Build session cwd paths never become projects. */
export function mergeProjects(fromThreads: Project[]): Project[] {
  const state = loadDesktopState()
  const hidden = new Set(state.hiddenProjects.map(pathKey))
  const lastActive = new Map<string, string>()
  for (const p of fromThreads) {
    if (p.path && p.lastActiveAt) lastActive.set(pathKey(p.path), p.lastActiveAt)
  }
  return state.projects
    .filter((p) => p.path && !hidden.has(pathKey(p.path)))
    .map((p) => ({
      ...p,
      lastActiveAt: lastActive.get(pathKey(p.path)) || p.lastActiveAt
    }))
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''))
}

export function upsertProject(project: Project): Project[] {
  const state = loadDesktopState()
  const key = pathKey(project.path)
  state.hiddenProjects = state.hiddenProjects.filter((p) => pathKey(p) !== key)
  const idx = state.projects.findIndex((p) => pathKey(p.path) === key)
  if (idx >= 0) state.projects[idx] = { ...state.projects[idx], ...project }
  else state.projects.unshift(project)
  saveDesktopState(state)
  return mergeProjects([])
}

export function importLocalProject(folder: string): Project[] {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder))
    throw new Error('请选择有效的项目文件夹。')
  const resolved = path.resolve(folder)
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('项目文件夹不存在或无法访问，请重新选择。')
  }
  const existing = loadDesktopState().projects.find((p) => pathKey(p.path) === pathKey(resolved))
  return upsertProject({
    id: existing?.id || resolved,
    name: existing?.name || path.basename(resolved) || resolved,
    path: resolved,
    lastActiveAt: new Date().toISOString()
  })
}

export function renameProject(projectPath: string, name: string): void {
  const state = loadDesktopState()
  const key = pathKey(projectPath)
  const idx = state.projects.findIndex((p) => pathKey(p.path) === key)
  if (idx >= 0) state.projects[idx] = { ...state.projects[idx], name }
  else state.projects.push({ id: projectPath, path: projectPath, name })
  saveDesktopState(state)
}

export function hideProject(projectPath: string): void {
  const state = loadDesktopState()
  const key = pathKey(projectPath)
  if (!state.hiddenProjects.some((p) => pathKey(p) === key)) state.hiddenProjects.push(projectPath)
  state.projects = state.projects.filter((p) => pathKey(p.path) !== key)
  saveDesktopState(state)
}
