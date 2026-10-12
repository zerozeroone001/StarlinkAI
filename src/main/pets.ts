import { app, BrowserWindow, Menu, nativeImage, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_PETS,
  DEFAULT_PET_ATLAS,
  DEFAULT_PET_ID,
  LEGACY_PET_IDS,
  type Locale,
  type PetAction,
  type PetActionDraft,
  type PetActionEvent,
  type PetActionGenerationOptions,
  type PetActionProgress,
  type PetAtlas,
  type PetDraft,
  type PetDefaultActions,
  type PetGeneratedMedia,
  type PetInfo,
  type PetLiveStatus,
  type PetMotion,
  type PetRiveConfig,
  type PetSnapshot,
  type PetSubjectExtractionOptions,
  type PetVisual,
  type Theme
} from '../shared/types'
import { findGrokBinary, grokHome, readJson, writeJson } from './paths'
import { registerDesktopWindow } from './desktop-security'
import { loadDesktopState, patchPrefs } from './desktop-state'
import { actionDurationMs, parseActionAtlas } from '../shared/pet-animation'
import { validatePetActionSheet } from './pet-action-sheet'
import { subjectExtractionPrompt, SUBJECT_POSE_VERSION } from './pet-prompts'
import { writeColorSafeCutout } from './pet-cutout'
import { runGrokMediaJob } from './pet-media-job'
import { runPetPortraitGeneration } from './pet-portraits'
import { listPetActionJobs, pausePetActionJob, runPetActionGeneration, validatePetActionJobSave, markPetActionJobSaved } from './pet-action-jobs'

const PET_W = 248
const PET_H = 332
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov'])
const RIVE_EXTS = new Set(['.riv'])

interface PetsHost {
  getMain: () => BrowserWindow | null
  preloadPath: () => string
  sendMain: (channel: string, payload: unknown) => void
}

let host: PetsHost | null = null
let petWindow: BrowserWindow | null = null
let petRendererReady = false
let pendingPetAction: PetActionEvent | null = null
let lastStatus: PetLiveStatus = {
  mood: 'idle',
  title: 'StarlinkAI',
  hint: 'Ready',
  threadId: null,
  runningCount: 0,
  needsInput: false
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.riv') return 'application/octet-stream'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/webp'
}

function parseRiveConfig(raw: Record<string, unknown> | null, fallbackFile = ''): PetRiveConfig | null {
  if (!raw) return fallbackFile ? defaultRiveConfig(fallbackFile) : null
  const value = raw.rive
  const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const file = String(
    (typeof value === 'string' ? value : '') || rec.file || raw.rivePath || raw.riveFile || fallbackFile
  ).trim()
  if (!file) return null
  const triggers: Partial<Record<PetMotion, string>> = {}
  const rawTriggers = rec.triggers
  if (rawTriggers && typeof rawTriggers === 'object') {
    for (const [motion, input] of Object.entries(rawTriggers as Record<string, unknown>)) {
      if (typeof input === 'string' && input.trim()) {
        triggers[motion as PetMotion] = input.trim()
      }
    }
  }
  return {
    file,
    artboard: typeof rec.artboard === 'string' && rec.artboard.trim() ? rec.artboard.trim() : undefined,
    stateMachine:
      typeof rec.stateMachine === 'string' && rec.stateMachine.trim()
        ? rec.stateMachine.trim()
        : 'PetState',
    moodInput:
      typeof rec.moodInput === 'string' && rec.moodInput.trim() ? rec.moodInput.trim() : 'mood',
    motionInput:
      typeof rec.motionInput === 'string' && rec.motionInput.trim()
        ? rec.motionInput.trim()
        : 'motion',
    triggers: Object.keys(triggers).length ? triggers : undefined
  }
}

function defaultRiveConfig(file: string): PetRiveConfig {
  return {
    file,
    stateMachine: 'PetState',
    moodInput: 'mood',
    motionInput: 'motion'
  }
}

function parseAtlas(raw: Record<string, unknown> | null): PetAtlas {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PET_ATLAS }
  const cell = raw.cellSize as { width?: number; height?: number } | undefined
  const grid = raw.grid as { columns?: number; rows?: number } | undefined
  const statesRaw = raw.states as Record<string, { rows?: number[]; frames?: number }> | undefined
  const states: PetAtlas['states'] = {}
  if (statesRaw && typeof statesRaw === 'object') {
    for (const [key, value] of Object.entries(statesRaw)) {
      const row = Array.isArray(value?.rows) ? Number(value.rows[0]) : NaN
      const frames = Number(value?.frames)
      if (Number.isFinite(row) && Number.isFinite(frames)) states[key] = { row, frames }
    }
  }
  return {
    columns: Number(grid?.columns) || DEFAULT_PET_ATLAS.columns,
    rows: Number(grid?.rows) || DEFAULT_PET_ATLAS.rows,
    cellWidth: Number(cell?.width) || DEFAULT_PET_ATLAS.cellWidth,
    cellHeight: Number(cell?.height) || DEFAULT_PET_ATLAS.cellHeight,
    states: Object.keys(states).length ? states : undefined
  }
}

function parseActions(raw: unknown): PetAction[] {
  if (!Array.isArray(raw)) return []
  const out: PetAction[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = String(rec.id || rec.name || '').trim()
    const name = String(rec.name || rec.displayName || id).trim()
    if (!id || !name) continue
    const motion = typeof rec.motion === 'string' ? (rec.motion as PetMotion) : undefined
    const durationMs = Number(rec.durationMs)
    const atlas = parseActionAtlas(rec.atlas)
    if (rec.mediaType === 'sheet' && !atlas) continue
    out.push({
      id: id.replace(/[^\p{Letter}\p{Number}_.-]+/gu, '-').slice(0, 48),
      name,
      nameZh: typeof rec.nameZh === 'string' ? rec.nameZh : undefined,
      motion,
      file: typeof rec.file === 'string' ? rec.file : undefined,
      mediaType:
        atlas ? 'sheet' : rec.mediaType === 'video' ||
        (typeof rec.file === 'string' && VIDEO_EXTS.has(path.extname(rec.file).toLowerCase()))
          ? 'video'
          : 'image',
      atlas: atlas || undefined,
      durationMs: atlas ? actionDurationMs(atlas) : Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
      custom: rec.custom !== false,
      prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
      history: Array.isArray(rec.history) ? rec.history.flatMap((entry) => {
        const old = entry as Record<string, unknown>
        const oldAtlas = parseActionAtlas(old?.atlas)
        return typeof old?.file === 'string' && oldAtlas ? [{ file: old.file, atlas: oldAtlas, durationMs: actionDurationMs(oldAtlas) }] : []
      }) : undefined
    })
  }
  return out
}

function mergeActions(extra: PetAction[] = []): PetAction[] {
  const map = new Map<string, PetAction>()
  for (const action of extra) map.set(action.id, { ...map.get(action.id), ...action })
  return [...map.values()]
}

function parseDefaultActions(raw: unknown): PetDefaultActions {
  if (!raw || typeof raw !== 'object') return {}
  const rec = raw as Record<string, unknown>
  const out: PetDefaultActions = {}
  for (const key of ['work', 'report', 'rest', 'play'] as const) {
    const actionId = typeof rec[key] === 'string' ? rec[key].trim() : ''
    if (actionId) out[key] = actionId
  }
  return out
}

function customRoot(): string {
  return path.join(grokHome(), 'pets')
}

function customRoots(): string[] {
  return [customRoot(), path.join(os.homedir(), '.codex', 'pets'), path.join(os.homedir(), '.petdex', 'pets')]
}

function bundledPetsDir(): string {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'pets'),
    path.join(process.resourcesPath, 'pets'),
    path.join(process.cwd(), 'resources', 'pets')
  ]
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0]
}

function builtinPortrait(id: string): string | null {
  const file = path.join(bundledPetsDir(), `${id}.png`)
  return fs.existsSync(file) ? file : null
}

function builtinRive(id: string): string | null {
  const file = path.join(bundledPetsDir(), `${id}.riv`)
  return fs.existsSync(file) ? file : null
}

function scanPetDir(dir: string): PetInfo | null {
  const manifest = path.join(dir, 'pet.json')
  if (!fs.existsSync(manifest)) return null
  const raw = readJson<Record<string, unknown>>(manifest)
  if (!raw) return null
  const id = String(raw.id || path.basename(dir)).trim()
  if (!id) return null
  const sheetName = String(raw.spritesheetPath || '')
  const portraitName = String(raw.portrait || raw.portraitPath || 'portrait.png')
  const rive = parseRiveConfig(raw, fs.existsSync(path.join(dir, 'pet.riv')) ? 'pet.riv' : '')
  const hasSheet = Boolean(sheetName && fs.existsSync(path.join(dir, sheetName)))
  const hasRive = Boolean(rive && fs.existsSync(path.join(dir, rive.file)))
  const hasPortrait =
    fs.existsSync(path.join(dir, portraitName)) ||
    fs.existsSync(path.join(dir, 'portrait.png')) ||
    hasSheet ||
    hasRive
  return {
    id,
    name: String(raw.displayName || raw.name || id),
    description: String(raw.description || 'Custom pet'),
    kind: 'custom',
    atlas: hasSheet ? parseAtlas(raw) : undefined,
    portrait: hasPortrait,
    actions: mergeActions(parseActions(raw.actions)),
    defaultActions: parseDefaultActions(raw.defaultActions),
    deletable: true,
    rive: hasRive,
    visualVersion: Number(raw.updatedAt) || fs.statSync(manifest).mtimeMs
  }
}

function overlayFor(id: string): Record<string, unknown> | null {
  for (const root of customRoots()) {
    const manifest = path.join(root, id, 'pet.json')
    const raw = readJson<Record<string, unknown>>(manifest)
    if (raw) {
      return {
        ...raw,
        __visualVersion: fs.existsSync(manifest) ? fs.statSync(manifest).mtimeMs : undefined
      }
    }
  }
  return null
}

function applyOverlay(base: PetInfo, raw: Record<string, unknown> | null): PetInfo {
  if (!raw) {
    return {
      ...base,
      actions: mergeActions(base.actions),
      defaultActions: base.defaultActions || {},
      portrait: base.portrait || Boolean(builtinPortrait(base.id)),
      rive: Boolean(builtinRive(base.id)),
      deletable: base.kind === 'custom'
    }
  }
  const extra = parseActions(raw.actions)
  return {
    ...base,
    name: String(raw.displayName || raw.name || base.name),
    description: String(raw.description || base.description),
    actions: mergeActions(extra),
    defaultActions: parseDefaultActions(raw.defaultActions),
    portrait: true,
    deletable: base.kind === 'custom',
    rive: Boolean(parseRiveConfig(raw)) || Boolean(builtinRive(base.id)),
    visualVersion: Number(raw.updatedAt || raw.__visualVersion) || undefined
  }
}

export function listPets(): PetInfo[] {
  const builtins = BUILTIN_PETS.map((pet) => applyOverlay(pet, overlayFor(pet.id)))
  const seen = new Set<string>(builtins.map((p) => p.id))
  const customs: PetInfo[] = []
  for (const root of customRoots()) {
    if (!fs.existsSync(root)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const info = scanPetDir(path.join(root, entry.name))
      if (!info || seen.has(info.id)) continue
      seen.add(info.id)
      customs.push(info)
    }
  }
  return [...builtins, ...customs.sort((a, b) => a.name.localeCompare(b.name))]
}

function findPetDir(id: string): string | null {
  for (const root of customRoots()) {
    const direct = path.join(root, id)
    if (fs.existsSync(path.join(direct, 'pet.json'))) return direct
    if (!fs.existsSync(root)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const raw = readJson<{ id?: string }>(path.join(dir, 'pet.json'))
      if (raw?.id === id) return dir
    }
  }
  return null
}

function fileToDataUrl(file: string): string {
  const buf = fs.readFileSync(file)
  return `data:${mimeFor(file)};base64,${buf.toString('base64')}`
}

export function loadSpritesheet(id: string): { dataUrl: string; atlas: PetAtlas } | null {
  const visual = loadPetVisual(id)
  if (!visual || visual.type !== 'sheet') return null
  return { dataUrl: visual.dataUrl, atlas: visual.atlas || DEFAULT_PET_ATLAS }
}

export function loadPetVisual(id: string, file?: string): PetVisual | null {
  const dir = findPetDir(id)
  if (dir) {
    const raw = readJson<Record<string, unknown>>(path.join(dir, 'pet.json'))
    const rive = parseRiveConfig(raw, fs.existsSync(path.join(dir, 'pet.riv')) ? 'pet.riv' : '')
    const wanted = file || rive?.file || String(raw?.spritesheetPath || raw?.portrait || raw?.portraitPath || 'portrait.png')
    const named = path.join(dir, wanted)
    const relative = path.relative(dir, named)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    if (fs.existsSync(named)) {
      const isRive = RIVE_EXTS.has(path.extname(named).toLowerCase())
      const isVideo = VIDEO_EXTS.has(path.extname(named).toLowerCase())
      const sheetName = String(raw?.spritesheetPath || '')
      const action = parseActions(raw?.actions).find((item) => item.file === wanted)
      const isSheet = Boolean(action?.mediaType === 'sheet' || (sheetName && path.basename(named) === path.basename(sheetName)))
      const displayFile = isRive || isVideo || isSheet ? named : displayReadyImage(named)
      return {
        type: isRive ? 'rive' : isVideo ? 'video' : isSheet ? 'sheet' : 'portrait',
        dataUrl: fileToDataUrl(displayFile),
        atlas: isSheet ? action?.atlas || parseAtlas(raw) : undefined,
        file: wanted,
        fallbackDataUrl: isRive
          ? ['portrait.png', 'portrait.webp', 'portrait.jpg']
              .map((name) => path.join(dir, name))
              .find((candidate) => fs.existsSync(candidate))
              ? fileToDataUrl(
                  displayReadyImage(
                    ['portrait.png', 'portrait.webp', 'portrait.jpg']
                      .map((name) => path.join(dir, name))
                      .find((candidate) => fs.existsSync(candidate))!
                  )
                )
              : builtinPortrait(id)
                ? fileToDataUrl(builtinPortrait(id)!)
                : undefined
          : undefined,
        rive: isRive ? rive || defaultRiveConfig(wanted) : undefined
      }
    }
    if (file) return null
    for (const fallback of ['portrait.png', 'portrait.webp', 'portrait.gif', 'spritesheet.webp', 'spritesheet.png']) {
      const p = path.join(dir, fallback)
      if (!fs.existsSync(p)) continue
      const isSheet = fallback.startsWith('spritesheet')
      const displayFile = isSheet ? p : displayReadyImage(p)
      return {
        type: isSheet ? 'sheet' : 'portrait',
        dataUrl: fileToDataUrl(displayFile),
        atlas: isSheet ? parseAtlas(raw) : undefined,
        file: fallback
      }
    }
  }
  if (!file) {
    const bundledRive = builtinRive(id)
    if (bundledRive) {
      const portrait = builtinPortrait(id)
      return {
        type: 'rive',
        dataUrl: fileToDataUrl(bundledRive),
        fallbackDataUrl: portrait ? fileToDataUrl(portrait) : undefined,
        file: path.basename(bundledRive),
        rive: defaultRiveConfig(path.basename(bundledRive))
      }
    }
    const bundled = builtinPortrait(id)
    if (bundled) return { type: 'portrait', dataUrl: fileToDataUrl(bundled), file: path.basename(bundled) }
  }
  return null
}

function defaultPoint(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width - PET_W - 18),
    y: Math.round(area.y + area.height - PET_H - 18)
  }
}

function petBounds(): { x: number; y: number } {
  const prefs = loadDesktopState()
  const fallback = defaultPoint()
  const x = prefs.petX
  const y = prefs.petY
  if (x == null || y == null) return fallback
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    return x + 40 < a.x + a.width && x + PET_W - 40 > a.x && y + 40 < a.y + a.height && y + PET_H - 40 > a.y
  })
  return onScreen ? { x, y } : fallback
}

function rendererUrl(file: string): string | null {
  const base = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && base) return `${base.replace(/\/$/, '')}/${file}`
  return null
}

function loadPetPage(win: BrowserWindow): void {
  const url = rendererUrl('pet.html')
  if (url) {
    void win.loadURL(url)
    return
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  void win.loadFile(path.join(here, '../renderer/pet.html'))
}

function sendPet(channel: string, payload: unknown): void {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send(channel, payload)
}

function resolvedPetId(id?: string): string {
  const pets = listPets()
  const mapped = id ? LEGACY_PET_IDS[id] || id : ''
  if (mapped && pets.some((p) => p.id === mapped)) return mapped
  if (pets.some((p) => p.id === DEFAULT_PET_ID)) return DEFAULT_PET_ID
  return pets[0]?.id || DEFAULT_PET_ID
}

export function petPublic(): { awake: boolean; petId: string; pets: PetInfo[] } {
  const prefs = loadDesktopState()
  const pets = listPets()
  const petId = resolvedPetId(prefs.petId)
  return {
    awake: Boolean(prefs.petAwake && petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
    petId,
    pets
  }
}

export function petSnapshot(): PetSnapshot {
  const prefs = loadDesktopState()
  const pub = petPublic()
  return {
    awake: pub.awake,
    petId: pub.petId,
    pets: pub.pets,
    theme: prefs.theme,
    locale: prefs.locale,
    status: lastStatus
  }
}

/** Called by the pet renderer after its action listener is registered. */
export function petRendererSnapshot(): PetSnapshot {
  const snap = petSnapshot()
  petRendererReady = true
  const pending = pendingPetAction
  pendingPetAction = null
  if (pending?.petId === snap.petId) sendPet('pets:action', pending)
  return snap
}

function persistPosition(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const [x, y] = petWindow.getPosition()
  patchPrefs({ petX: x, petY: y })
}

function broadcast(): PetSnapshot {
  const snap = petSnapshot()
  sendPet('pets:snapshot', snap)
  host?.sendMain('pets:prefs', petPublic())
  return snap
}

export function petWindowBounds(): { x: number; y: number; width: number; height: number } {
  if (petWindow && !petWindow.isDestroyed()) {
    const b = petWindow.getBounds()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }
  const p = petBounds()
  return { x: p.x, y: p.y, width: PET_W, height: PET_H }
}

export function movePetWindow(x: number, y: number): { x: number; y: number } {
  if (!petWindow || petWindow.isDestroyed()) return petWindowBounds()
  const nx = Math.round(x)
  const ny = Math.round(y)
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    return nx + PET_W > a.x + 24 && nx < a.x + a.width - 24 && ny + PET_H > a.y + 24 && ny < a.y + a.height - 24
  })
  const pos = onScreen ? { x: nx, y: ny } : petBounds()
  petWindow.setPosition(pos.x, pos.y)
  return pos
}

export function endPetDrag(): { x: number; y: number } {
  persistPosition()
  const b = petWindowBounds()
  return { x: b.x, y: b.y }
}

export function createPetWindow(): BrowserWindow {
  if (petWindow && !petWindow.isDestroyed()) return petWindow
  const { x, y } = petBounds()
  const win = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    movable: true,
    thickFrame: false,
    webPreferences: {
      preload: host?.preloadPath() || '',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  registerDesktopWindow(win, {
    role: 'pet', entry: path.join(path.dirname(fileURLToPath(import.meta.url)), '../renderer/pet.html'),
    devEntry: rendererUrl('pet.html') || undefined
  })
  win.setAlwaysOnTop(true, 'floating', 1)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setMenuBarVisibility(false)
  win.webContents.on('did-start-loading', () => { petRendererReady = false })
  win.webContents.on('did-finish-load', () => {
    sendPet('pets:snapshot', petSnapshot())
  })
  win.on('moved', persistPosition)
  win.on('closed', () => {
    petWindow = null
    petRendererReady = false
    pendingPetAction = null
    patchPrefs({ petAwake: false })
    host?.sendMain('pets:prefs', petPublic())
  })
  loadPetPage(win)
  petWindow = win
  return win
}

export function wakePet(): PetSnapshot {
  const win = createPetWindow()
  patchPrefs({ petAwake: true })
  if (win.isMinimized()) win.restore()
  win.showInactive()
  win.setAlwaysOnTop(true, 'floating', 1)
  return broadcast()
}

export function tuckPet(): PetSnapshot {
  patchPrefs({ petAwake: false })
  if (petWindow && !petWindow.isDestroyed()) {
    persistPosition()
    petWindow.hide()
  }
  host?.sendMain('pets:prefs', petPublic())
  return petSnapshot()
}

export function selectPet(id: string): PetSnapshot {
  const next = resolvedPetId(id)
  patchPrefs({ petId: next })
  return broadcast()
}

export function setPetStatus(status: PetLiveStatus): void {
  lastStatus = status
  sendPet('pets:status', status)
}

export function notifyPetChrome(theme: Theme, locale: Locale): void {
  sendPet('pets:chrome', { theme, locale })
}

export function destroyPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    persistPosition()
    petWindow.close()
  }
  petWindow = null
}

export function restorePetIfNeeded(): void {
  if (loadDesktopState().petAwake) wakePet()
}

export function activateFromPet(threadId?: string | null): void {
  const main = host?.getMain()
  if (!main || main.isDestroyed()) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
  if (threadId) host?.sendMain('grok:open-thread', threadId)
}

function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned || `pet-${Date.now().toString(36)}`
}

function uniqueId(base: string): string {
  const pets = listPets()
  if (!pets.some((p) => p.id === base)) return base
  for (let i = 2; i < 50; i++) {
    const id = `${base}-${i}`
    if (!pets.some((p) => p.id === id)) return id
  }
  return `${base}-${Date.now().toString(36)}`
}

function assertSafeId(id: string): string {
  const next = id.trim()
  if (!next || next.includes('..') || /[\\/]/.test(next)) throw new Error('invalid pet id')
  return next
}

function copyImage(src: string, destDir: string, stem: string): string {
  if (!src || !fs.existsSync(src)) throw new Error('image missing')
  const ext = path.extname(src).toLowerCase()
  const cutoutFilename = `${stem}.png`
  const cutoutDestination = path.join(destDir, cutoutFilename)
  fs.mkdirSync(destDir, { recursive: true })
  if (writeColorSafeCutout(src, cutoutDestination)) return cutoutFilename
  const safe = IMAGE_EXTS.has(ext) ? ext : '.png'
  const filename = `${stem}${safe}`
  fs.copyFileSync(src, path.join(destDir, filename))
  return filename
}

function copyActionMedia(src: string, destDir: string, stem: string): string {
  if (!src || !fs.existsSync(src)) throw new Error('media missing')
  const ext = path.extname(src).toLowerCase()
  const safe = VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext) ? ext : '.mp4'
  fs.mkdirSync(destDir, { recursive: true })
  const filename = `${stem}${safe}`
  fs.copyFileSync(src, path.join(destDir, filename))
  return filename
}

function copyRive(src: string, destDir: string): string {
  if (!src || !fs.existsSync(src) || !RIVE_EXTS.has(path.extname(src).toLowerCase())) {
    throw new Error('Rive file missing or invalid')
  }
  fs.mkdirSync(destDir, { recursive: true })
  const filename = 'pet.riv'
  const destination = path.join(destDir, filename)
  if (path.resolve(src) !== path.resolve(destination)) fs.copyFileSync(src, destination)
  return filename
}

function generationRoot(): string {
  return path.join(grokHome(), 'desktop', 'pet-generations')
}

function generationDir(kind: 'portraits' | 'subjects' | 'actions'): string {
  const dir = path.join(
    generationRoot(),
    `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function generatedFiles(dir: string, extensions: Set<string>): string[] {
  const files: { file: string; mtime: number }[] = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(file)
      else if (extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push({ file, mtime: fs.statSync(file).mtimeMs })
      }
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime).map((item) => item.file)
}

function generatedMedia(file: string): PetGeneratedMedia {
  return { path: file, dataUrl: fileToDataUrl(file), mime: mimeFor(file) }
}

function displayReadyImage(source: string): string {
  const stat = fs.statSync(source)
  const cacheDir = path.join(grokHome(), 'desktop', 'pet-cache')
  const key = createHash('sha256')
    .update(`pet-cutout-v5-color-safe\0${path.resolve(source).toLowerCase()}`)
    .digest('hex')
    .slice(0, 24)
  const cached = path.join(cacheDir, `${key}.png`)
  if (fs.existsSync(cached) && fs.statSync(cached).mtimeMs >= stat.mtimeMs) return cached
  return writeColorSafeCutout(source, cached) ? cached : source
}


function recoveredCutout(dir: string, source: string, stem: string): string | null {
  const destination = path.join(dir, `${stem}.png`)
  return writeColorSafeCutout(source, destination) ? destination : null
}

function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function recoverPreviousSubject(source: string, target: string): PetGeneratedMedia | null {
  const root = generationRoot()
  if (!fs.existsSync(root)) return null
  const sourceHash = fileHash(source)
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('subjects-'))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 6)
  for (const dir of dirs) {
    const request = readJson<{ poseVersion: string; target: string; sourceHash: string }>(path.join(dir, 'subject-request.json'))
    if (request?.poseVersion !== SUBJECT_POSE_VERSION || request.target !== target || request.sourceHash !== sourceHash) continue
    const original = generatedFiles(dir, IMAGE_EXTS).find((file) => /^source\./i.test(path.basename(file)))
    if (!original || fileHash(original) !== sourceHash) continue
    const candidates = generatedFiles(dir, IMAGE_EXTS)
      .filter((file) => file !== original)
      .filter((file) => !/(?:alpha.debug|checker|mask|face|hair|hand|shoe|magenta)/i.test(path.basename(file)))
      .sort((a, b) => {
        const rank = (file: string) =>
          /cutout|final|subject/i.test(path.basename(file)) ? 0 : /preview.rgba/i.test(path.basename(file)) ? 1 : 2
        return rank(a) - rank(b)
      })
    for (let index = 0; index < candidates.length; index += 1) {
      const cutout = recoveredCutout(dir, candidates[index], `recovered-cache-${index + 1}`)
      if (cutout) return generatedMedia(cutout)
    }
  }
  return null
}

function filesCompletionKey(files: string[]): string | null {
  if (!files.length || files.some((file) => !fs.existsSync(file))) return null
  return files
    .map((file) => {
      const stat = fs.statSync(file)
      return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}`
    })
    .join('|')
}

function portraitSource(id: string): string | null {
  const dir = findPetDir(id)
  if (dir) {
    const raw = readManifest(dir)
    const candidates = [
      String(raw.portrait || raw.portraitPath || ''),
      'portrait.png',
      'portrait.webp',
      'portrait.jpg'
    ].filter(Boolean)
    for (const candidate of candidates) {
      const file = path.join(dir, candidate)
      if (fs.existsSync(file) && IMAGE_EXTS.has(path.extname(file).toLowerCase())) {
        return displayReadyImage(file)
      }
    }
  }
  return builtinPortrait(id)
}

export async function generatePetImages(userPrompt: string, requestedCount = 4): Promise<PetGeneratedMedia[]> {
  const description = String(userPrompt || '').trim().slice(0, 4000)
  if (!description) throw new Error('prompt required')
  const count = [1, 2, 4].includes(Number(requestedCount)) ? Number(requestedCount) : 4
  return runPetPortraitGeneration(generationDir('portraits'), description, count, runGrokMediaJob)
}

export async function extractPetSubject(
  imagePathOrPetId: string,
  targetPrompt = '',
  options: PetSubjectExtractionOptions = {}
): Promise<PetGeneratedMedia> {
  const requested = String(imagePathOrPetId || '').trim()
  let source: string | null = null
  const resolved = path.resolve(requested)
  if (fs.existsSync(resolved) && IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) {
    source = resolved
  } else if (requested && !/[\\/]/.test(requested)) {
    source = portraitSource(assertSafeId(requested))
  }
  if (!source) {
    throw new Error('image missing')
  }
  const target = String(targetPrompt || '').trim().slice(0, 1000)
  const previous = options.forceRegenerate ? null : recoverPreviousSubject(source, target)
  if (previous) return previous
  const dir = generationDir('subjects')
  const reference = path.join(dir, `source${path.extname(source).toLowerCase() || '.png'}`)
  fs.copyFileSync(source, reference)
  writeJson(path.join(dir, 'subject-request.json'), { poseVersion: SUBJECT_POSE_VERSION, target, sourceHash: fileHash(source) })
  const output = path.join(dir, 'pet-cutout.png')
  const prompt = subjectExtractionPrompt(path.basename(reference), target)
  let jobError: unknown = null
  try {
    await runGrokMediaJob(dir, prompt, {
      maxTurns: 8, disableWebSearch: true,
      rules: 'Generate one image edit with the full pose requirements. The app saves the image returned by the tool; no terminal commands, manual copying or output inspection are needed.',
      acceptImage: (file) => {
        if (!writeColorSafeCutout(file, output)) throw new Error('PET_SUBJECT_INVALID: no usable transparent subject cutout')
        return true
      },
      completionKey: () => {
        const validated = path.join(dir, 'validated-cutout.png')
        return fs.existsSync(output) && writeColorSafeCutout(output, validated) ? filesCompletionKey([output]) : null
      }
    })
  } catch (error) {
    jobError = error
  }
  const candidates = [output, ...generatedFiles(dir, IMAGE_EXTS).filter((file) => file !== reference)]
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => !/(?:alpha.debug|checker|mask|face|hair|hand|shoe|magenta)/i.test(path.basename(file)))
    .sort((a, b) => {
      const rank = (file: string) =>
        file === output ? 0 : /cutout|final|subject/i.test(path.basename(file)) ? 1 : /preview.rgba/i.test(path.basename(file)) ? 2 : 3
      return rank(a) - rank(b)
    })
  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index]
    if (!fs.existsSync(file)) continue
    const cutout = recoveredCutout(dir, file, `recovered-cutout-${index + 1}`)
    if (cutout) return generatedMedia(cutout)
  }
  if (jobError) {
    throw jobError
  }
  throw new Error('StarlinkAI did not return a transparent subject cutout. Try a clearer image or specify the target.')
}

export async function generatePetActionSheet(
  petId: string,
  userPrompt: string,
  referencePath?: string,
  options: PetActionGenerationOptions = {},
  onProgress?: (progress: PetActionProgress) => void
): Promise<PetGeneratedMedia> {
  const safeId = assertSafeId(petId)
  let seed: { id: string; file: string; atlas: PetAtlas } | undefined
  let replacement: { id: string; file?: string } | undefined
  let description = String(userPrompt || '').trim().slice(0, 4000)
  if (options.sourceActionId && options.replaceActionId) throw new Error('PET_JOB_INVALID')
  if (options.replaceActionId && !options.resumeJobId) {
    const dir = findPetDir(safeId)
    const action = dir ? parseActions(readManifest(dir).actions).find(a => a.id === options.replaceActionId) : undefined
    if (!dir || !action) throw new Error('PET_ACTION_MISSING')
    if (!action.custom) throw new Error('PET_ACTION_READ_ONLY')
    const file = action.file ? path.resolve(dir, action.file) : undefined
    if (file && !file.startsWith(path.resolve(dir) + path.sep)) throw new Error('PET_ACTION_INVALID')
    replacement = { id: action.id, file }
    description ||= action.prompt || action.name
  }
  if (options.sourceActionId && !options.resumeJobId) {
    const dir = findPetDir(safeId)
    const action = dir ? parseActions(readManifest(dir).actions).find(a => a.id === options.sourceActionId) : undefined
    if (!dir || !action?.file || !action.atlas) throw new Error('PET_UPGRADE_REQUIRES_SHEET')
    const file = path.resolve(dir, action.file)
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error('PET_UPGRADE_REQUIRES_SHEET')
    validatePetActionSheet(file, action.atlas)
    seed = { id: action.id, file, atlas: action.atlas }
    description ||= action.prompt || action.name
  }
  const source = options.resumeJobId ? undefined : referencePath ? path.resolve(referencePath) : portraitSource(safeId)
  return runPetActionGeneration({ root: generationRoot(), petId: safeId, prompt: description, reference: source, seed, replacement, options }, runGrokMediaJob, onProgress)
}

export function petActionJobs(petId: string): PetActionProgress[] {
  return listPetActionJobs(generationRoot(), assertSafeId(petId))
}

export function pausePetActionGeneration(petId: string, jobId: string): void {
  pausePetActionJob(generationRoot(), assertSafeId(petId), jobId)
}

function writeManifest(dir: string, info: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true })
  writeJson(path.join(dir, 'pet.json'), { ...info, updatedAt: Date.now() })
}

function overlayDir(id: string): string {
  const existing = findPetDir(id)
  if (existing) return existing
  return path.join(customRoot(), id)
}

function readManifest(dir: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(dir, 'pet.json')) || {}
}

export function createCustomPet(draft: PetDraft): PetSnapshot {
  const name = String(draft.name || '').trim()
  if (!name) throw new Error('name required')
  const id = uniqueId(assertSafeId(draft.id || slugify(name)))
  const dir = path.join(customRoot(), id)
  const portrait = draft.imagePath ? copyImage(draft.imagePath, dir, 'portrait') : undefined
  const riveFile = draft.rivePath ? copyRive(draft.rivePath, dir) : undefined
  if (!portrait && !riveFile) throw new Error('portrait or Rive file required')
  writeManifest(dir, {
    id,
    displayName: name,
    description: String(draft.description || '').trim() || 'Custom pet',
    portrait: portrait || 'portrait.png',
    rive: riveFile ? defaultRiveConfig(riveFile) : undefined,
    defaultActions: {},
    actions: []
  })
  patchPrefs({ petId: id })
  return broadcast()
}

export function updateCustomPet(id: string, draft: PetDraft): PetSnapshot {
  const safe = assertSafeId(id)
  const builtin = BUILTIN_PETS.find((p) => p.id === safe)
  const dir = overlayDir(safe)
  const prev = readManifest(dir)
  const name = String(draft.name || prev.displayName || prev.name || builtin?.name || safe).trim()
  const description = String(
    draft.description ?? prev.description ?? builtin?.description ?? 'Custom pet'
  ).trim()
  let portrait = String(prev.portrait || prev.portraitPath || 'portrait.png')
  if (draft.imagePath) portrait = copyImage(draft.imagePath, dir, 'portrait')
  const rive = draft.rivePath ? defaultRiveConfig(copyRive(draft.rivePath, dir)) : prev.rive
  const defaultActions =
    draft.defaultActions === undefined
      ? parseDefaultActions(prev.defaultActions)
      : parseDefaultActions(draft.defaultActions)
  writeManifest(dir, {
    ...prev,
    id: safe,
    displayName: name,
    description,
    portrait,
    rive,
    defaultActions,
    actions: prev.actions || []
  })
  return broadcast()
}

export function deleteCustomPet(id: string): PetSnapshot {
  const safe = assertSafeId(id)
  if (BUILTIN_PETS.some((p) => p.id === safe)) throw new Error('cannot delete builtin pet')
  const dir = findPetDir(safe)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  const prefs = loadDesktopState()
  if (prefs.petId === safe) patchPrefs({ petId: DEFAULT_PET_ID })
  return broadcast()
}

export function addPetAction(petId: string, draft: PetActionDraft): PetSnapshot {
  const safe = assertSafeId(petId)
  const dir = overlayDir(safe)
  const prev = readManifest(dir)
  const builtin = BUILTIN_PETS.find((p) => p.id === safe)
  const actions = parseActions(prev.actions)
  const name = String(draft.name || '').trim()
  if (!name) throw new Error('name required')
  const replaced = draft.replaceActionId ? actions.find(a => a.id === draft.replaceActionId) : undefined
  if (draft.replaceActionId && !replaced?.atlas) throw new Error('PET_UPGRADE_REQUIRES_SHEET')
  const id = replaced?.id || uniqueActionId(
    slugify(name),
    actions.map((a) => a.id)
  )
  let file: string | undefined
  let atlas: PetAtlas | undefined
  if (draft.spritesheetPath) atlas = validatePetActionSheet(draft.spritesheetPath, draft.atlas)
  else if (draft.atlas) throw new Error('PET_SHEET_INVALID: spritesheet path required')
  if (replaced && (!atlas || atlas.frames! <= replaced.atlas!.frames!)) throw new Error('PET_UPGRADE_FRAME_COUNT')
  if (draft.generationJobId) validatePetActionJobSave(generationRoot(), safe, draft.generationJobId, draft.spritesheetPath || '', replaced?.id, replaced?.file ? path.join(dir, replaced.file) : undefined)
  const mediaPath = draft.spritesheetPath || draft.videoPath || draft.imagePath
  if (mediaPath) file = copyActionMedia(mediaPath, dir, `action-${id}${replaced ? '-' + Date.now().toString(36) : ''}`)
  const nextAction: PetAction = {
    id,
    name,
    motion: atlas ? 'idle' : draft.motion || 'wave',
    file,
    mediaType: atlas ? 'sheet' : file && VIDEO_EXTS.has(path.extname(file).toLowerCase()) ? 'video' : 'image',
    atlas,
    durationMs: atlas ? actionDurationMs(atlas) : draft.durationMs || 1800,
    custom: true,
    prompt: String(draft.prompt || replaced?.prompt || '').slice(0, 4000),
    history: replaced?.file && replaced.atlas ? [...(replaced.history || []), { file: replaced.file, atlas: replaced.atlas, durationMs: actionDurationMs(replaced.atlas) }] : undefined
  }
  if (replaced) actions.splice(actions.findIndex(a => a.id === replaced.id), 1, nextAction)
  else actions.push(nextAction)
  writeManifest(dir, {
    ...prev,
    id: safe,
    displayName: prev.displayName || prev.name || builtin?.name || safe,
    description: prev.description || builtin?.description || 'Custom pet',
    portrait: prev.portrait || prev.portraitPath || 'portrait.png',
    actions
  })
  if (draft.generationJobId) {
    try { markPetActionJobSaved(generationRoot(), safe, draft.generationJobId, id) }
    catch { /* The action is saved; a stale draft marker must not cause a duplicate on retry. */ }
  }
  return broadcast()
}

/** Metadata edits never regenerate or rewrite media. A replacement is committed only after validation. */
export function updatePetAction(petId: string, actionId: string, draft: PetActionDraft): PetSnapshot {
  const safe = assertSafeId(petId), dir = findPetDir(safe)
  if (!dir) throw new Error('PET_ACTION_MISSING')
  const prev = readManifest(dir), actions = parseActions(prev.actions)
  const index = actions.findIndex(action => action.id === actionId), old = actions[index]
  if (!old) throw new Error('PET_ACTION_MISSING')
  if (!old.custom) throw new Error('PET_ACTION_READ_ONLY')
  const name = String(draft.name || '').trim().slice(0, 120)
  if (!name) throw new Error('name required')
  const next: PetAction = { ...old, name, nameZh: old.nameZh === undefined ? undefined : name,
    prompt: draft.prompt === undefined ? old.prompt : String(draft.prompt).slice(0, 4000) }
  if (draft.spritesheetPath) {
    const atlas = validatePetActionSheet(draft.spritesheetPath, draft.atlas)
    if (draft.generationJobId) validatePetActionJobSave(generationRoot(), safe, draft.generationJobId, draft.spritesheetPath, old.id, old.file ? path.join(dir, old.file) : undefined)
    next.file = copyActionMedia(draft.spritesheetPath, dir, `action-${old.id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
    next.atlas = atlas; next.mediaType = 'sheet'; next.motion = 'idle'; next.durationMs = actionDurationMs(atlas)
    next.history = old.file && old.atlas ? [...(old.history || []), { file: old.file, atlas: old.atlas, durationMs: actionDurationMs(old.atlas) }] : old.history
  } else if (draft.atlas || draft.generationJobId || draft.imagePath || draft.videoPath) throw new Error('PET_SHEET_INVALID: spritesheet path required')
  actions[index] = next
  writeManifest(dir, { ...prev, actions })
  if (draft.generationJobId) {
    try { markPetActionJobSaved(generationRoot(), safe, draft.generationJobId, old.id) }
    catch { /* Saved media is authoritative even if the draft marker cannot be updated. */ }
  }
  return broadcast()
}

export function removePetAction(petId: string, actionId: string): PetSnapshot {
  const safe = assertSafeId(petId)
  const dir = findPetDir(safe)
  if (!dir) return petSnapshot()
  const prev = readManifest(dir)
  const removed = parseActions(prev.actions).find((a) => a.id === actionId)
  if (!removed) return petSnapshot()
  if (!removed.custom) throw new Error('PET_ACTION_READ_ONLY')
  const actions = parseActions(prev.actions).filter((a) => a.id !== actionId)
  const defaultActions = parseDefaultActions(prev.defaultActions)
  for (const key of ['work', 'report', 'rest', 'play'] as const) {
    if (defaultActions[key] === actionId) delete defaultActions[key]
  }
  writeManifest(dir, { ...prev, actions, defaultActions })
  const retained = new Set([prev.portrait, prev.portraitPath, prev.spritesheetPath,
    ...actions.flatMap(action => [action.file, ...(action.history || []).map(item => item.file)])]
    .filter((file): file is string => typeof file === 'string').map(file => path.resolve(dir, file).toLowerCase()))
  // Only unlink this app's generated files inside this pet; imported/shared media are retained.
  for (const name of new Set([removed.file, ...(removed.history || []).map(item => item.file)])) {
    if (!name || !/^action-[^\\/]+\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(name)) continue
    const file = path.resolve(dir, name)
    if (!file.startsWith(path.resolve(dir) + path.sep) || retained.has(file.toLowerCase())) continue
    try { fs.unlinkSync(file) } catch { /* The action is deleted even if media cleanup is unavailable. */ }
  }
  return broadcast()
}

function uniqueActionId(base: string, used: string[]): string {
  const set = new Set(used)
  const stem = base || `act-${Date.now().toString(36)}`
  if (!set.has(stem)) return stem
  for (let i = 2; i < 50; i++) {
    const id = `${stem}-${i}`
    if (!set.has(id)) return id
  }
  return `${stem}-${Date.now().toString(36)}`
}

export function playPetAction(actionId: string, requestedPetId?: string): PetSnapshot {
  const snap = petSnapshot()
  const pet = listPets().find((p) => p.id === (requestedPetId || snap.petId))
  const action = pet?.actions?.find((a) => a.id === actionId)
  if (!action) return petSnapshot()
  let visual: PetVisual | null = null
  if (action.file && pet) {
    visual = loadPetVisual(pet.id, action.file)
    if (!visual) throw new Error('pet action media missing')
  }
  if (pet!.id !== snap.petId) selectPet(pet!.id)
  if (!snap.awake) wakePet()
  const event: PetActionEvent = {
    id: action.id,
    petId: pet!.id,
    motion: action.motion || 'wave',
    durationMs: action.durationMs || 1800,
    visual,
    dataUrl: visual?.dataUrl || null
  }
  if (petRendererReady) sendPet('pets:action', event)
  else pendingPetAction = event
  return petSnapshot()
}

export function showPetMenu(): void {
  const snap = petSnapshot()
  const zh = snap.locale === 'zh-CN'
  const pet = snap.pets.find((p) => p.id === snap.petId)
  const actions = pet?.actions || []
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: zh ? '打开 StarlinkAI' : 'Open StarlinkAI',
      click: () => activateFromPet(lastStatus.threadId)
    }
  ]
  if (actions.length) {
    template.push({ type: 'separator' }, {
      label: zh ? '动作' : 'Actions',
      submenu: actions.map((action) => ({
        label: zh ? action.nameZh || action.name : action.name,
        click: () => playPetAction(action.id)
      }))
    })
  }
  template.push(
    { type: 'separator' },
    {
      label: zh ? '收起' : 'Tuck away',
      click: () => {
        tuckPet()
      }
    }
  )
  const menu = Menu.buildFromTemplate(template)
  const win = petWindow && !petWindow.isDestroyed() ? petWindow : undefined
  menu.popup({ window: win })
}

export function registerPets(next: PetsHost): void {
  host = next
}
