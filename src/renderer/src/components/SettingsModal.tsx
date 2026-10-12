import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Film,
  Image as ImageIcon,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
  SlidersHorizontal,
  Blocks,
  Palette,
  Moon,
  Sun,
  ShieldCheck,
  PawPrint
} from 'lucide-react'
import {
  BUILTIN_PETS,
  EFFORTS,
  type Locale,
  type PermissionMode,
  type PetDraft,
  type PetActionDraft,
  type PetDefaultAction,
  type PetDefaultActions,
  type PetInfo,
  type PetGeneratedMedia,
  type PetActionProgress,
  type PetFrameCount,
  type PetVisual,
  type SettingsTab
} from '@shared/types'
import { useApp } from '@/stores/app'
import { useT, type MsgKey } from '@/lib/i18n'
import { PetActor } from './PetActor'
import { PetActionFrames } from './PetActionFrames'
import { actionDurationMs, parseActionAtlas, PET_FRAME_COUNTS } from '@shared/pet-animation'
import { ResolvedImage } from './Markdown'
import { SkillsPanel } from './SkillsModal'
import { ProviderSettings } from './ProviderSettings'
import { ModelPicker } from './ModelPicker'
import { useProviders } from '@/stores/providers'
import { WorkspaceDataSettings } from './WorkspaceDataSettings'

const PET_NAME: Record<string, MsgKey> = {
  ragdoll: 'pet.ragdoll',
  shiba: 'pet.shiba',
  imp: 'pet.imp',
  elf: 'pet.elf',
  xiaomei: 'pet.xiaomei',
  secretary: 'pet.secretary'
}

const PET_HINT: Record<string, MsgKey> = {
  ragdoll: 'pet.ragdollHint',
  shiba: 'pet.shibaHint',
  imp: 'pet.impHint',
  elf: 'pet.elfHint',
  xiaomei: 'pet.xiaomeiHint',
  secretary: 'pet.secretaryHint'
}

const DEFAULT_ACTION_SLOTS: Array<{ id: PetDefaultAction; label: MsgKey }> = [
  { id: 'work', label: 'pet.defaultWork' },
  { id: 'report', label: 'pet.defaultReport' },
  { id: 'rest', label: 'pet.defaultRest' },
  { id: 'play', label: 'pet.defaultPlay' }
]

function petRelabeled(pet: PetInfo): boolean {
  const builtin = BUILTIN_PETS.find((item) => item.id === pet.id)
  return Boolean(builtin && pet.description !== builtin.description)
}

async function invokePetMedia<T>(
  method: 'generateImages' | 'extractSubject' | 'generateActionSheet',
  ...args: unknown[]
): Promise<T> {
  const pets = window.grok?.pets as unknown as Record<string, unknown> | undefined
  const direct = pets?.[method]
  try {
    if (typeof direct === 'function')
      return await (direct as (...values: unknown[]) => Promise<T>)(...args)
    if (typeof window.grok?.invoke === 'function')
      return (await window.grok.invoke(`pets:${method}`, ...args)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (!/No handler registered|blocked:|not a function/i.test(message)) throw error
  }
  throw new Error('PET_MEDIA_API_RESTART_REQUIRED')
}

const TABS: { id: SettingsTab; label: MsgKey }[] = [
  { id: 'providers', label: 'settings.tabProviders' },
  { id: 'basics', label: 'settings.tabBasics' },
  { id: 'skills', label: 'settings.tabSkills' },
  { id: 'pets', label: 'settings.tabPets' }
]

const MIN_W = 720
const MIN_H = 560

function readSettingsSize(): { w: number; h: number } {
  try {
    const w = Number(localStorage.getItem('grok.settingsW'))
    const h = Number(localStorage.getItem('grok.settingsH'))
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { w: Math.max(MIN_W, Math.round(w)), h: Math.max(MIN_H, Math.round(h)) }
    }
  } catch {
    /* ignore */
  }
  return { w: 1080, h: 800 }
}

export function SettingsModal() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const t = useT()
  const picking = useRef(false)
  const [busy, setBusy] = useState(false)
  const [wallpaperError, setWallpaperError] = useState<string | null>(null)
  const [size, setSize] = useState(readSettingsSize)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const resize = useRef<{
    edge: 'se' | 'e' | 's'
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const {
    settingsOpen,
    settingsTab,
    setSettings,
    setSettingsTab,
    theme,
    setTheme,
    locale,
    setLocale,
    model,
    setModel,
    effort,
    setEffort,
    permissionMode,
    setPermissionMode,
    wallpaperName,
    wallpaperOpacity,
    wallpaperDataUrl,
    setWallpaperOpacity,
    chooseWallpaper,
    clearWallpaper,
    pets,
    petId,
    petAwake,
    selectPet,
    wakePet,
    tuckPet,
    createPet,
    updatePet,
    deletePet,
    addPetAction,
    updatePetAction,
    removePetAction,
    playPetAction,
    loadSkills
  } = useApp()

  useEffect(() => {
    if (settingsOpen && !TABS.some((tab) => tab.id === settingsTab)) setSettingsTab('providers')
    if (settingsOpen && settingsTab === 'skills') void loadSkills()
  }, [settingsOpen, settingsTab])

  useEffect(() => {
    if (settingsOpen) dialogRef.current?.showModal()
  }, [settingsOpen])

  if (!settingsOpen) return null

  const applySize = (w: number, h: number) => {
    const maxW = Math.max(MIN_W, window.innerWidth - 48)
    const maxH = Math.max(MIN_H, window.innerHeight - 48)
    const next = {
      w: Math.round(Math.min(maxW, Math.max(MIN_W, w))),
      h: Math.round(Math.min(maxH, Math.max(MIN_H, h)))
    }
    setSize(next)
    sizeRef.current = next
  }

  const onResizeDown = (edge: 'se' | 'e' | 's') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    resize.current = {
      edge,
      x: e.clientX,
      y: e.clientY,
      w: sizeRef.current.w,
      h: sizeRef.current.h
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = resize.current
    if (!d) return
    const dw = e.clientX - d.x
    const dh = e.clientY - d.y
    applySize(d.edge === 's' ? d.w : d.w + dw, d.edge === 'e' ? d.h : d.h + dh)
  }

  const onResizeUp = () => {
    if (!resize.current) return
    resize.current = null
    try {
      localStorage.setItem('grok.settingsW', String(sizeRef.current.w))
      localStorage.setItem('grok.settingsH', String(sizeRef.current.h))
    } catch {
      /* ignore */
    }
  }

  const pick = async () => {
    if (picking.current || busy) return
    picking.current = true
    setBusy(true)
    setWallpaperError(null)
    try {
      await chooseWallpaper()
    } catch (err) {
      setWallpaperError(err instanceof Error ? err.message : t('settings.wallpaperError'))
    } finally {
      setBusy(false)
      window.setTimeout(() => {
        picking.current = false
      }, 400)
    }
  }

  return (
    <dialog
      className="settings-dialog"
      ref={dialogRef}
      aria-label={t('settings.title')}
      onCancel={() => setSettings(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSettings(false)
      }}
    >
      <div
        className="modal settings-shell settings-redesign"
        style={{ width: size.w, height: size.h }}
      >
        <div className="settings-head">
          <div>
            <div className="settings-title">{t('settings.title')}</div>
            <div className="settings-subtitle">{t('settings.subtitle')}</div>
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={() => setSettings(false)}
            title={t('action.close')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="settings-workbench">
          <nav className="settings-tabs" aria-label="设置分类">
            {TABS.map((tab) => {
              const Icon = {
                providers: Blocks,
                basics: SlidersHorizontal,
                skills: Sparkles,
                pets: PawPrint
              }[tab.id]
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={settingsTab === tab.id ? 'settings-tab on' : 'settings-tab'}
                  aria-current={settingsTab === tab.id ? 'page' : undefined}
                  onClick={() => setSettingsTab(tab.id)}
                >
                  <Icon size={16} />
                  {t(tab.label)}
                </button>
              )
            })}
            <div className="settings-nav-caption">
              GROK DESKTOP<span>多模型协作工作台</span>
            </div>
          </nav>
          <div className={'settings-body' + (settingsTab === 'skills' ? ' fill' : '')}>
            {settingsTab === 'providers' ? <ProviderSettings /> : null}
            {settingsTab === 'basics' ? (
              <BasicsTab
                t={t}
                locale={locale}
                setLocale={setLocale}
                theme={theme}
                setTheme={setTheme}
                wallpaperDataUrl={wallpaperDataUrl}
                wallpaperName={wallpaperName}
                wallpaperOpacity={wallpaperOpacity}
                wallpaperError={wallpaperError}
                busy={busy}
                pick={pick}
                clearWallpaper={clearWallpaper}
                setWallpaperOpacity={setWallpaperOpacity}
                model={model}
                setModel={setModel}
                effort={effort}
                setEffort={setEffort}
                permissionMode={permissionMode}
                setPermissionMode={setPermissionMode}
              />
            ) : null}
            {settingsTab === 'skills' ? <SkillsPanel /> : null}
            {settingsTab === 'pets' ? (
              <PetsTab
                t={t}
                locale={locale}
                pets={pets}
                petId={petId}
                petAwake={petAwake}
                selectPet={selectPet}
                wakePet={wakePet}
                tuckPet={tuckPet}
                createPet={createPet}
                updatePet={updatePet}
                deletePet={deletePet}
                addPetAction={addPetAction}
                updatePetAction={updatePetAction}
                removePetAction={removePetAction}
                playPetAction={playPetAction}
              />
            ) : null}
          </div>
        </div>
        <div className="settings-foot">
          <span className="settings-save-hint">设置即时生效 · 账号信息仅在本机展示</span>
          <button className="primary" type="button" onClick={() => setSettings(false)}>
            {t('action.done')}
          </button>
        </div>
        <div
          className="settings-resize e"
          onPointerDown={onResizeDown('e')}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <div
          className="settings-resize s"
          onPointerDown={onResizeDown('s')}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <div
          className="settings-resize se"
          onPointerDown={onResizeDown('se')}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
      </div>
    </dialog>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-copy">
        <div className="settings-field-label">{label}</div>
        {hint ? <div className="settings-field-hint">{hint}</div> : null}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-title">{icon}{title}</div>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function BasicsTab({
  t,
  locale,
  setLocale,
  theme,
  setTheme,
  wallpaperDataUrl,
  wallpaperName,
  wallpaperOpacity,
  wallpaperError,
  busy,
  pick,
  clearWallpaper,
  setWallpaperOpacity,
  model,
  setModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode
}: {
  t: (k: MsgKey) => string
  locale: Locale
  setLocale: (v: Locale) => void
  theme: 'dark' | 'light'
  setTheme: (v: 'dark' | 'light') => void
  wallpaperDataUrl: string | null
  wallpaperName: string | null
  wallpaperOpacity: number
  wallpaperError: string | null
  busy: boolean
  pick: () => Promise<void>
  clearWallpaper: () => Promise<void>
  setWallpaperOpacity: (n: number) => void
  model: string
  setModel: (v: string) => void
  effort: (typeof EFFORTS)[number]['id']
  setEffort: (v: (typeof EFFORTS)[number]['id']) => void
  permissionMode: PermissionMode
  setPermissionMode: (v: PermissionMode) => void
}) {
  return (
    <div className="general-settings">
      <div className="general-page-head">
        <div>
          <h2>{t('settings.tabBasics')}</h2>
          <p>{t('settings.generalHint')}</p>
        </div>
        <span className="settings-autosave"><Check size={13} />{t('settings.autoSave')}</span>
      </div>
      <Section title={t('settings.sectionLook')} icon={<Palette size={17} />}>
        <Field label={t('settings.language')} hint={t('settings.languageHint')}>
          <select
            aria-label={t('settings.language')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="settings-select"
          >
            <option value="en">{t('settings.langEn')}</option>
            <option value="zh-CN">{t('settings.langZh')}</option>
          </select>
        </Field>
        <div className="settings-field stack">
          <div className="settings-field-copy">
            <div className="settings-field-label">{t('settings.appearance')}</div>
            <div className="settings-field-hint">{t('settings.themeHint')}</div>
          </div>
          <div className="theme-options" role="group" aria-label={t('settings.appearance')}>
            <button
              type="button"
              className={`theme-option dark${theme === 'dark' ? ' selected' : ''}`}
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme('dark')}
            >
              <span className="theme-preview" aria-hidden="true"><i /><span><b /><b /><b /></span></span>
              <span className="theme-option-label"><Moon size={15} />{t('settings.themeDark')}<span className="theme-option-check">{theme === 'dark' && <Check size={12} />}</span></span>
            </button>
            <button
              type="button"
              className={`theme-option light${theme === 'light' ? ' selected' : ''}`}
              aria-pressed={theme === 'light'}
              onClick={() => setTheme('light')}
            >
              <span className="theme-preview" aria-hidden="true"><i /><span><b /><b /><b /></span></span>
              <span className="theme-option-label"><Sun size={15} />{t('settings.themeLight')}<span className="theme-option-check">{theme === 'light' && <Check size={12} />}</span></span>
            </button>
          </div>
        </div>
      </Section>
      <Section title={t('settings.background')} icon={<ImageIcon size={17} />}>
        <div className="settings-field stack">
          <div className="settings-field-copy">
            <div className="settings-field-label">{t('settings.wallpaperTitle')}</div>
            <div className="settings-field-hint">{window.grok ? t('settings.wallpaperHint') : '预览背景仅在当前页面有效，支持 PNG、JPEG、WebP。'}</div>
          </div>
          <div className="wallpaper-row">
            <div
              className={'wallpaper-thumb' + (wallpaperDataUrl ? ' on' : '')}
              style={
                wallpaperDataUrl ? { backgroundImage: `url("${wallpaperDataUrl}")` } : undefined
              }
            >
              {!wallpaperDataUrl && <ImageIcon size={24} />}
            </div>
            <div className="wallpaper-meta">
              <div className="wallpaper-name">{wallpaperName || t('settings.noWallpaper')}</div>
              {wallpaperError ? <div className="settings-error">{wallpaperError}</div> : null}
              <div className="wallpaper-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void pick()}
                >
                  <Upload size={14} />
                  {busy ? t('settings.choosingImage') : t('settings.chooseImage')}
                </button>
                {wallpaperName ? (
                  <button
                    className="ghost-mini"
                    type="button"
                    disabled={busy}
                    onClick={() => void clearWallpaper()}
                  >
                    {t('settings.removeImage')}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <label className="wallpaper-intensity">
            <span>{t('settings.intensity')}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={wallpaperOpacity}
              disabled={!wallpaperDataUrl}
              onChange={(e) => setWallpaperOpacity(Number(e.target.value))}
            />
            <span className="wallpaper-pct">{wallpaperOpacity}%</span>
          </label>
        </div>
      </Section>

      <WorkspaceDataSettings />
      {window.grok && <Section title={`${t('settings.sectionAgent')} · Grok 原生会话`} icon={<ShieldCheck size={17} />}>
        <ModelPicker provider="grok" value={{ model, effort }} onChange={choice => {
          const catalog = useProviders.getState().diagnostics.find(p => p.id === 'grok')?.models || []
          const selected = choice.model ? catalog.find(m => m.id === choice.model) : catalog.find(m => m.isDefault)
          if (selected) { setModel(selected.id); setEffort((choice.effort || selected.defaultEffort || 'high') as typeof effort) }
        }} />
        <Field label={t('settings.permissions')} hint={t('settings.permissionsHint')}>
          <select
            aria-label={t('settings.permissions')}
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
            title={t('settings.permissionsHint')}
            className="settings-select"
          >
            <option value="ask">{t('composer.ask')}</option>
            <option value="review">{t('composer.review')}</option>
            <option value="auto">{t('composer.full')}</option>
          </select>
        </Field>
      </Section>}
    </div>
  )
}

function PetsTab({
  t,
  locale,
  pets,
  petId,
  petAwake,
  selectPet,
  wakePet,
  tuckPet,
  createPet,
  updatePet,
  deletePet,
  addPetAction,
  updatePetAction,
  removePetAction,
  playPetAction
}: {
  t: (k: MsgKey) => string
  locale: Locale
  pets: PetInfo[]
  petId: string
  petAwake: boolean
  selectPet: (id: string) => Promise<void>
  wakePet: () => Promise<void>
  tuckPet: () => Promise<void>
  createPet: (draft: PetDraft) => Promise<unknown>
  updatePet: (id: string, draft: PetDraft) => Promise<unknown>
  deletePet: (id: string) => Promise<unknown>
  addPetAction: (petId: string, draft: PetActionDraft) => Promise<unknown>
  removePetAction: (petId: string, actionId: string) => Promise<unknown>
  updatePetAction: (petId: string, actionId: string, draft: PetActionDraft) => Promise<unknown>
  playPetAction: (actionId: string, petId?: string) => Promise<void>
}) {
  const selected = pets.find((p) => p.id === petId) || pets[0]
  const [editor, setEditor] = useState<'off' | 'create' | 'edit'>('off')
  const [editingPetId, setEditingPetId] = useState<string | null>(null)
  const editingPet = pets.find((pet) => pet.id === editingPetId) || selected

  const openCreate = () => {
    setEditingPetId(null)
    setEditor('create')
  }

  const openEdit = (target: PetInfo | undefined = selected) => {
    if (!target) return
    setEditingPetId(target.id)
    setEditor('edit')
  }

  return (
    <Section title={t('settings.pets')}>
      <div className="pet-module-head">
        <div>
          <div className="settings-field-label">{t('pet.chooseTitle')}</div>
          <div className="settings-field-hint">{t('pet.hint')}</div>
        </div>
        <button className="secondary" type="button" onClick={openCreate}>
          <Plus size={13} /> {t('pet.add')}
        </button>
      </div>
      <div className="pet-picker">
        {pets.map((pet) => (
          <div className="pet-card-wrap" key={pet.id}>
            <button
              type="button"
              className={'pet-card' + (petId === pet.id ? ' on' : '')}
              onClick={() => void selectPet(pet.id)}
              onDoubleClick={() => {
                void selectPet(pet.id)
                openEdit(pet)
              }}
            >
              <span className="pet-card-visual">
                <PetActor pet={pet} mood="idle" compact />
              </span>
              <span className="pet-card-name">{pet.name}</span>
              {petId === pet.id ? (
                <span className="pet-card-check">
                  <Check size={11} />
                </span>
              ) : null}
            </button>
            <button
              className="pet-card-edit"
              type="button"
              title={t('pet.edit')}
              aria-label={t('pet.edit')}
              onClick={() => {
                void selectPet(pet.id)
                openEdit(pet)
              }}
            >
              <Pencil size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="pet-card pet-card-add" onClick={openCreate}>
          <span className="pet-add-plus">
            <Plus size={22} />
          </span>
          <span>{t('pet.add')}</span>
        </button>
      </div>
      {selected ? (
        <div className="pet-selected">
          <div>
            <div className="settings-field-label">{selected.name}</div>
            <div className="settings-field-hint">
              {!petRelabeled(selected) && locale === 'en' && PET_HINT[selected.id]
                ? t(PET_HINT[selected.id])
                : selected.description}
            </div>
          </div>
          <div className="wallpaper-actions">
            <button className="ghost-mini" type="button" onClick={() => openEdit()}>
              <Pencil size={12} /> {t('pet.edit')}
            </button>
            {petAwake ? (
              <button className="secondary" type="button" onClick={() => void tuckPet()}>
                {t('pet.tuck')}
              </button>
            ) : (
              <button className="secondary" type="button" onClick={() => void wakePet()}>
                {t('pet.wake')}
              </button>
            )}
            <span className={'status-pill' + (petAwake ? ' ok' : ' off')}>
              {petAwake ? t('pet.awake') : t('pet.tucked')}
            </span>
          </div>
        </div>
      ) : null}
      {editor !== 'off' ? (
        <PetEditorModal
          key={`${editor}-${editor === 'edit' ? editingPet?.id : 'new'}`}
          mode={editor}
          pet={editor === 'edit' ? editingPet : undefined}
          locale={locale}
          t={t}
          onClose={() => setEditor('off')}
          onCreate={createPet}
          onUpdate={updatePet}
          onDelete={async () => {
            if (!editingPet?.deletable || !window.confirm(t('pet.confirmDelete'))) return
            await deletePet(editingPet.id)
            setEditor('off')
          }}
          onAddAction={addPetAction}
          onUpdateAction={updatePetAction}
          onRemoveAction={removePetAction}
          onPlayAction={playPetAction}
        />
      ) : null}
    </Section>
  )
}

export function PetEditorModal({
  mode,
  pet,
  locale,
  t,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onAddAction,
  onUpdateAction,
  onRemoveAction,
  onPlayAction
}: {
  mode: 'create' | 'edit'
  pet?: PetInfo
  locale: Locale
  t: (k: MsgKey) => string
  onClose: () => void
  onCreate: (draft: PetDraft) => Promise<unknown>
  onUpdate: (id: string, draft: PetDraft) => Promise<unknown>
  onDelete: () => Promise<void>
  onAddAction: (petId: string, draft: PetActionDraft) => Promise<unknown>
  onRemoveAction: (petId: string, actionId: string) => Promise<unknown>
  onUpdateAction: (petId: string, actionId: string, draft: PetActionDraft) => Promise<unknown>
  onPlayAction: (actionId: string, petId?: string) => Promise<void>
}) {
  const [name, setName] = useState(pet?.name || '')
  const [description, setDescription] = useState(pet?.description || '')
  const [source, setSource] = useState<'generate' | 'upload' | 'rive'>('generate')
  const [rivePath, setRivePath] = useState<string | null>(null)
  const [uploadOriginalPath, setUploadOriginalPath] = useState<string | null>(null)
  const [extractTarget, setExtractTarget] = useState('')
  const [extracted, setExtracted] = useState<PetGeneratedMedia | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractRequested, setExtractRequested] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [generationCount, setGenerationCount] = useState<1 | 2 | 4>(4)
  const [generated, setGenerated] = useState<PetGeneratedMedia[]>([])
  const [generatedIndex, setGeneratedIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionOpen, setActionOpen] = useState(false)
  const [actionName, setActionName] = useState('')
  const [actionPrompt, setActionPrompt] = useState('')
  const [actionMedia, setActionMedia] = useState<PetGeneratedMedia | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionFrameCount, setActionFrameCount] = useState<PetFrameCount>(16)
  const [upgradingActionId, setUpgradingActionId] = useState<string | undefined>()
  const [editingActionId, setEditingActionId] = useState<string | undefined>()
  const [editingVisual, setEditingVisual] = useState<PetVisual | null>(null)
  const [deletingActionId, setDeletingActionId] = useState<string | null>(null)
  const [actionProgress, setActionProgress] = useState<PetActionProgress | null>(null)
  const [actionJobs, setActionJobs] = useState<PetActionProgress[]>([])
  const actionRequest = useRef<string | null>(null)
  const [defaultActions, setDefaultActions] = useState<PetDefaultActions>(pet?.defaultActions || {})

  const pickedPath =
    source === 'upload'
      ? extracted?.path || null
      : source === 'generate'
        ? generated[generatedIndex]?.path || null
        : null
  const actionRevision = useRef(0)
  const [actionPreviewPlaying, setActionPreviewPlaying] = useState(true)
  const invalidateAction = () => {
    actionRevision.current++
    actionRequest.current = null
    setActionMedia(null)
    setActionProgress(null)
    setActionPreviewPlaying(true)
  }
  useEffect(invalidateAction, [pickedPath, source, pet?.id])
  const refreshActionJobs = () => {
    if (pet && window.grok.pets.actionJobs)
      void window.grok.pets
        .actionJobs(pet.id)
        .then(setActionJobs)
        .catch(() => {})
  }
  const actionFailure = (message: string) =>
    /PET_JOB_PAUSED/.test(message)
      ? null
      : message === 'PET_MEDIA_API_RESTART_REQUIRED'
        ? t('pet.generatorRestart')
        : /PET_ACTION_NEEDS_SUBJECT/.test(message)
          ? t('pet.needExtract')
          : /PET_SHEET_STATIC/.test(message)
            ? t('pet.sheetStatic')
            : /PET_SHEET_INVALID|PET_SHEET_MISSING/.test(message)
              ? t('pet.sheetInvalid')
              : /PET_MEDIA_TIMEOUT|PET_SHEET_TIMEOUT|timed out/i.test(message)
                ? t('pet.sheetTimeout')
                : message || t('pet.sheetFailed')
  useEffect(refreshActionJobs, [pet?.id])
  useEffect(
    () =>
      window.grok.on('pets:actionProgress', (payload) => {
        const progress = payload as PetActionProgress
        const restored = actionRequest.current === `job:${progress.jobId}`
        if (
          progress.petId !== pet?.id ||
          (!restored && progress.requestId !== actionRequest.current)
        )
          return
        setActionProgress(progress)
        setActionMedia(progress.media || null)
        if (restored && progress.state !== 'running') {
          setActionBusy(false)
          setActionError(progress.error ? actionFailure(progress.error) : null)
        }
      }),
    [pet?.id]
  )
  const actionLabel = (action: NonNullable<PetInfo['actions']>[number]) =>
    locale === 'zh-CN' ? action.nameZh || action.name : action.name
  const transparencyLabel = (media: PetGeneratedMedia | null | undefined) =>
    media?.transparency
      ? t(
          media.transparency === 'native-alpha'
            ? 'pet.nativeAlpha'
            : media.transparency === 'local-key'
              ? 'pet.localAlpha'
              : 'pet.mixedAlpha'
        )
      : null
  const savedAction = pet?.actions?.find((action) => action.id === editingActionId)
  const savedPreview: PetGeneratedMedia | null =
    editingVisual?.type === 'sheet' && editingVisual.atlas
      ? {
          path: '',
          dataUrl: editingVisual.dataUrl,
          mime: 'image/png',
          atlas: editingVisual.atlas,
          durationMs: actionDurationMs(editingVisual.atlas),
          complete: true
        }
      : null
  const previewMedia = actionMedia || (!actionProgress ? savedPreview : null)
  const canSaveMetadata = Boolean(editingActionId && !actionMedia && !actionProgress)

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !generating && !extracting && !actionBusy) onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [busy, generating, extracting, actionBusy, onClose])

  const extractPortrait = async (
    file = uploadOriginalPath || (extractRequested ? pet?.id : null),
    forceRegenerate = false
  ) => {
    if (!file || extracting || actionBusy) return
    setExtracting(true)
    setExtracted(null)
    setError(null)
    try {
      setExtracted(
        await invokePetMedia<PetGeneratedMedia>('extractSubject', file, extractTarget.trim(), {
          forceRegenerate
        })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        message === 'PET_MEDIA_API_RESTART_REQUIRED'
          ? t('pet.generatorRestart')
          : /PET_MEDIA_TIMEOUT|timed out/i.test(message)
            ? t('pet.extractTimeout')
            : /generation limit|max turns/i.test(message)
              ? t('pet.extractLimit')
              : /transparent subject cutout|image missing/i.test(message)
                ? t('pet.extractFailed')
                : message || t('pet.extractFailed')
      )
    } finally {
      setExtracting(false)
    }
  }

  const pickPortrait = async () => {
    if (actionBusy) return
    const file = await window.grok.pickImage()
    if (!file) return
    setSource('upload')
    setUploadOriginalPath(file)
    setExtracted(null)
    setExtractRequested(true)
    setError(null)
    await extractPortrait(file)
  }

  const pickRive = async () => {
    if (actionBusy) return
    const files = await window.grok.pickFiles()
    const file = files.find((candidate) => /\.riv$/i.test(candidate))
    if (!file) {
      setError(t('pet.riveInvalid'))
      return
    }
    setSource('rive')
    setRivePath(file)
    setError(null)
  }

  const extractCurrentPortrait = async () => {
    if (!pet) return
    setSource('upload')
    setUploadOriginalPath(null)
    setExtracted(null)
    setExtractRequested(true)
    await extractPortrait(pet.id)
  }

  const generatePortraits = async () => {
    if (!prompt.trim() || generating || actionBusy) {
      if (!prompt.trim()) setError(t('pet.needPrompt'))
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const items = await invokePetMedia<PetGeneratedMedia[]>(
        'generateImages',
        prompt.trim(),
        generationCount
      )
      setGenerated(items.slice(0, generationCount))
      setGeneratedIndex(0)
      setSource('generate')
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        message === 'PET_MEDIA_API_RESTART_REQUIRED'
          ? t('pet.generatorRestart')
          : /PET_SUBJECT_INVALID|PET_SUBJECT_MISSING/.test(message)
            ? t('pet.directCutoutFailed')
            : message || t('pet.generateFailed')
      )
    } finally {
      setGenerating(false)
    }
  }

  const save = async () => {
    if (busy) return
    const trimmed = name.trim()
    if (!trimmed) return setError(t('pet.needName'))
    if (source === 'upload' && extractRequested && !extracted) return setError(t('pet.needExtract'))
    if (mode === 'create' && !pickedPath && !rivePath) return setError(t('pet.needImage'))
    setBusy(true)
    setError(null)
    try {
      if (mode === 'create') {
        await onCreate({
          name: trimmed,
          description,
          imagePath: pickedPath,
          rivePath,
          defaultActions
        })
      } else if (pet) {
        await onUpdate(pet.id, {
          name: trimmed,
          description,
          imagePath: pickedPath,
          rivePath,
          defaultActions
        })
      }
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        /not a function|reopen|invoke|重启/i.test(message)
          ? t('pet.needRestart')
          : message || t('pet.needName')
      )
    } finally {
      setBusy(false)
    }
  }

  const generateAction = async (resumeJobId?: string) => {
    if (!pet || !actionPrompt.trim() || actionBusy) {
      if (!actionPrompt.trim()) setActionError(t('pet.needActionPrompt'))
      return
    }
    setActionBusy(true)
    setActionError(null)
    if (!resumeJobId) {
      setActionMedia(null)
      setActionProgress(null)
    }
    const requestId = crypto.randomUUID()
    actionRequest.current = requestId
    const revision = actionRevision.current
    try {
      if (extracting || generating || (source === 'upload' && extractRequested && !pickedPath)) {
        throw new Error('PET_ACTION_NEEDS_SUBJECT')
      }
      const result = await invokePetMedia<PetGeneratedMedia>(
        'generateActionSheet',
        pet.id,
        actionPrompt.trim(),
        pickedPath || undefined,
        {
          frameCount: actionFrameCount,
          requestId,
          sourceActionId: upgradingActionId,
          replaceActionId: editingActionId,
          resumeJobId
        }
      )
      if (!parseActionAtlas(result.atlas) || !result.mime.startsWith('image/') || !result.complete)
        throw new Error('PET_SHEET_INVALID')
      if (revision === actionRevision.current) setActionMedia(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (revision === actionRevision.current) setActionError(actionFailure(message))
    } finally {
      setActionBusy(false)
      actionRequest.current = null
      refreshActionJobs()
    }
  }

  const saveAction = async () => {
    if (!pet || !actionName.trim()) return setActionError(t('pet.needName'))
    if (
      !canSaveMetadata &&
      (!actionMedia?.complete ||
        !parseActionAtlas(actionMedia.atlas) ||
        actionMedia.atlas?.frames !== actionFrameCount)
    )
      return setActionError(t('pet.needSheet'))
    setActionBusy(true)
    setActionError(null)
    try {
      const draft: PetActionDraft = canSaveMetadata
        ? { name: actionName.trim(), prompt: actionPrompt }
        : {
            name: actionName.trim(),
            motion: 'idle',
            spritesheetPath: actionMedia!.path,
            atlas: actionMedia!.atlas,
            durationMs: actionDurationMs(actionMedia!.atlas!),
            prompt: actionPrompt,
            replaceActionId: upgradingActionId,
            generationJobId: actionMedia!.jobId
          }
      if (editingActionId) await onUpdateAction(pet.id, editingActionId, draft)
      else await onAddAction(pet.id, draft)
      setActionOpen(false)
      setActionName('')
      setActionPrompt('')
      setActionMedia(null)
      setActionProgress(null)
      setUpgradingActionId(undefined)
      setEditingActionId(undefined)
      setEditingVisual(null)
      refreshActionJobs()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('pet.sheetFailed'))
    } finally {
      setActionBusy(false)
    }
  }

  const loadActionJob = (job: PetActionProgress) => {
    actionRevision.current++
    setActionPreviewPlaying(true)
    actionRequest.current = job.state === 'running' ? `job:${job.jobId}` : null
    setActionOpen(true)
    setActionFrameCount(job.targetFrames)
    setActionPrompt(job.prompt)
    setUpgradingActionId(job.sourceActionId)
    setEditingActionId(job.replaceActionId)
    setEditingVisual(null)
    setActionName(
      pet?.actions?.find((a) => a.id === (job.replaceActionId || job.sourceActionId))?.name ||
        job.prompt.slice(0, 30)
    )
    setActionProgress(job)
    setActionMedia(job.media || null)
    setActionBusy(job.state === 'running')
    setActionError(job.error ? actionFailure(job.error) : null)
  }

  const upgradeAction = (action: NonNullable<PetInfo['actions']>[number]) => {
    const next = PET_FRAME_COUNTS.find((n) => n > (action.atlas?.frames || 0))
    if (!next) return
    invalidateAction()
    setEditingActionId(undefined)
    setEditingVisual(null)
    setUpgradingActionId(action.id)
    setActionFrameCount(next)
    setActionName(actionLabel(action))
    setActionPrompt(action.prompt || actionLabel(action))
    setActionError(null)
    setActionOpen(true)
  }

  const editAction = async (action: NonNullable<PetInfo['actions']>[number]) => {
    if (!pet || actionBusy) return
    invalidateAction()
    const revision = actionRevision.current
    setEditingActionId(action.id)
    setUpgradingActionId(undefined)
    setEditingVisual(null)
    setActionFrameCount(
      PET_FRAME_COUNTS.includes(action.atlas?.frames as PetFrameCount)
        ? (action.atlas!.frames as PetFrameCount)
        : 16
    )
    setActionName(actionLabel(action))
    setActionPrompt(action.prompt || '')
    setActionError(null)
    setActionOpen(true)
    if (action.file)
      try {
        const visual = await window.grok.pets.visual(pet.id, action.file)
        if (revision === actionRevision.current) setEditingVisual(visual)
      } catch (err) {
        if (revision === actionRevision.current)
          setActionError(err instanceof Error ? err.message : t('pet.sheetFailed'))
      }
  }

  const pauseAction = async () => {
    if (!pet || !actionProgress) return
    try {
      await window.grok.pets.pauseActionGeneration(pet.id, actionProgress.jobId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('pet.sheetFailed'))
    }
  }

  const removeAction = async (actionId: string) => {
    if (!pet || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      await onRemoveAction(pet.id, actionId)
      setDeletingActionId(null)
      if (editingActionId === actionId || upgradingActionId === actionId) {
        invalidateAction()
        setEditingActionId(undefined)
        setEditingVisual(null)
        setUpgradingActionId(undefined)
        setActionOpen(false)
      }
      setDefaultActions((current) => {
        const next = { ...current }
        for (const slot of DEFAULT_ACTION_SLOTS) {
          if (next[slot.id] === actionId) delete next[slot.id]
        }
        return next
      })
      refreshActionJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pet.actionDeleteFailed'))
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <div
      className="pet-editor-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !busy &&
          !generating &&
          !extracting &&
          !actionBusy
        )
          onClose()
      }}
    >
      <div
        className="pet-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? t('pet.add') : t('pet.edit')}
      >
        <div className="pet-editor-head">
          <div>
            <div className="pet-editor-title">
              {mode === 'create' ? t('pet.createTitle') : t('pet.editTitle')}
            </div>
            <div className="settings-field-hint">
              {mode === 'create' ? t('pet.createHint') : t('pet.editHint')}
            </div>
          </div>
          <button
            className="settings-close"
            type="button"
            onClick={onClose}
            disabled={busy || generating || extracting || actionBusy}
            title={t('action.close')}
            aria-label={t('action.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="pet-editor-scroll">
          <div className="pet-editor-layout" inert={actionBusy}>
            <div className="pet-editor-main">
              <div className="pet-form-grid">
                <label className="pet-editor-field">
                  <span>{t('pet.name')}</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </label>
                <label className="pet-editor-field">
                  <span>{t('pet.desc')}</span>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
              </div>

              <div className="pet-editor-section">
                <div className="pet-editor-section-head">
                  <div>
                    <div className="settings-field-label">{t('pet.image')}</div>
                    <div className="settings-field-hint">{t('pet.imageHint')}</div>
                  </div>
                  <div className="pet-source-tabs">
                    <button
                      type="button"
                      disabled={extracting || generating || actionBusy}
                      className={source === 'generate' ? 'on' : ''}
                      onClick={() => setSource('generate')}
                    >
                      <Sparkles size={12} /> {t('pet.generate')}
                    </button>
                    <button
                      type="button"
                      disabled={extracting || generating || actionBusy}
                      className={source === 'upload' ? 'on' : ''}
                      onClick={() => setSource('upload')}
                    >
                      <Upload size={12} /> {t('pet.upload')}
                    </button>
                    <button
                      type="button"
                      disabled={extracting || generating || actionBusy}
                      className={source === 'rive' ? 'on' : ''}
                      onClick={() => setSource('rive')}
                    >
                      <Film size={12} /> {t('pet.rive')}
                    </button>
                  </div>
                </div>

                {source === 'generate' ? (
                  <div className="pet-generation-panel">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={t('pet.promptPlaceholder')}
                      rows={3}
                    />
                    <div className="pet-generation-actions">
                      <div className="pet-count-picker" aria-label={t('pet.imageCount')}>
                        <span>{t('pet.imageCount')}</span>
                        <div>
                          {([1, 2, 4] as const).map((count) => (
                            <button
                              type="button"
                              key={count}
                              className={generationCount === count ? 'on' : ''}
                              disabled={generating || actionBusy}
                              onClick={() => {
                                setGenerationCount(count)
                                setGenerated([])
                                setGeneratedIndex(0)
                              }}
                            >
                              {count}
                            </button>
                          ))}
                        </div>
                      </div>
                      <button
                        className="secondary"
                        type="button"
                        disabled={generating || actionBusy}
                        onClick={() => void generatePortraits()}
                      >
                        <Sparkles size={13} className={generating ? 'spin' : ''} />
                        {generating
                          ? t('pet.generating')
                          : `${generated.length ? t('pet.regenerateImages') : t('pet.generateImages')} · ${generationCount}`}
                      </button>
                    </div>
                    {generated.length ? (
                      <div className="pet-generated-grid" data-count={generated.length}>
                        {generated.map((item, index) => (
                          <button
                            type="button"
                            key={item.path}
                            className={generatedIndex === index ? 'on' : ''}
                            disabled={actionBusy}
                            onClick={() => setGeneratedIndex(index)}
                          >
                            <img src={item.dataUrl} alt={`${t('pet.option')} ${index + 1}`} />
                            <span>
                              {generatedIndex === index ? <Check size={12} /> : index + 1}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="pet-generation-empty">
                        <ImageIcon size={22} />
                        <span>{generating ? t('pet.generatingHint') : t('pet.generateEmpty')}</span>
                      </div>
                    )}
                    <div className="settings-field-hint">{t('pet.directCutoutHint')}</div>
                    {transparencyLabel(generated[generatedIndex]) ? (
                      <div className="settings-field-hint pet-transparency-status">
                        {transparencyLabel(generated[generatedIndex])}
                      </div>
                    ) : null}
                  </div>
                ) : source === 'upload' ? (
                  <div className="pet-upload-panel">
                    <button
                      className="pet-upload-drop compact"
                      type="button"
                      disabled={extracting || actionBusy}
                      onClick={() => void pickPortrait()}
                    >
                      <Upload size={22} />
                      <strong>
                        {uploadOriginalPath
                          ? uploadOriginalPath.split(/[\\/]/).pop()
                          : t('pet.uploadTitle')}
                      </strong>
                      <span>{t('pet.uploadHint')}</span>
                    </button>
                    {extractRequested ? (
                      <>
                        <div className="pet-extract-controls">
                          <label className="pet-editor-field">
                            <span>{t('pet.extractTarget')}</span>
                            <input
                              value={extractTarget}
                              disabled={extracting || actionBusy}
                              onChange={(event) => setExtractTarget(event.target.value)}
                              placeholder={t('pet.extractTargetPlaceholder')}
                            />
                          </label>
                          <button
                            className="secondary"
                            type="button"
                            disabled={extracting || actionBusy}
                            onClick={() => void extractPortrait(undefined, true)}
                          >
                            <Sparkles size={13} className={extracting ? 'spin' : ''} />
                            {extracting
                              ? t('pet.extracting')
                              : extracted
                                ? t('pet.reextract')
                                : t('pet.extract')}
                          </button>
                        </div>
                        <div className="pet-extract-compare">
                          <div>
                            <span>{t('pet.originalImage')}</span>
                            <div className="pet-extract-preview original">
                              {uploadOriginalPath ? (
                                <ResolvedImage
                                  src={uploadOriginalPath}
                                  alt={t('pet.originalImage')}
                                  userSelected
                                />
                              ) : pet ? (
                                <PetActor pet={pet} mood="idle" />
                              ) : null}
                            </div>
                          </div>
                          <div className="pet-extract-arrow">→</div>
                          <div>
                            <span>{t('pet.extractedSubject')}</span>
                            <div className="pet-extract-preview cutout">
                              {extracted ? (
                                <img src={extracted.dataUrl} alt={t('pet.extractedSubject')} />
                              ) : (
                                <div className="pet-extract-empty">
                                  <Sparkles size={18} className={extracting ? 'spin' : ''} />
                                  <span>
                                    {extracting ? t('pet.extractingHint') : t('pet.extractEmpty')}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="pet-upload-panel">
                    <button
                      className="pet-upload-drop compact"
                      type="button"
                      onClick={() => void pickRive()}
                    >
                      <Film size={22} />
                      <strong>
                        {rivePath ? rivePath.split(/[\\/]/).pop() : t('pet.riveTitle')}
                      </strong>
                      <span>{t('pet.riveHint')}</span>
                    </button>
                    <div className="settings-field-hint">{t('pet.riveContract')}</div>
                  </div>
                )}
              </div>
            </div>

            <aside className="pet-editor-preview-card">
              <span className="settings-field-hint">{t('pet.preview')}</span>
              <div className="pet-editor-actor">
                {source === 'generate' && generated[generatedIndex] ? (
                  <img src={generated[generatedIndex].dataUrl} alt="" />
                ) : source === 'upload' && extracted ? (
                  <img src={extracted.dataUrl} alt="" />
                ) : source === 'upload' && extracting ? (
                  <div className="pet-preview-placeholder">
                    <Sparkles size={24} className="spin" />
                  </div>
                ) : source === 'rive' && rivePath ? (
                  <div className="pet-preview-placeholder" title={rivePath}>
                    <Film size={24} />
                  </div>
                ) : pet ? (
                  <PetActor pet={pet} mood="idle" />
                ) : (
                  <div className="pet-preview-placeholder">
                    <ImageIcon size={24} />
                  </div>
                )}
              </div>
              <strong>{name || t('pet.unnamed')}</strong>
              <span className="pet-preview-description">
                {description || t('pet.noDescription')}
              </span>
              {pet && source === 'generate' && !generated.length ? (
                <button
                  className="ghost-mini pet-preview-extract"
                  type="button"
                  disabled={extracting || actionBusy}
                  onClick={() => void extractCurrentPortrait()}
                >
                  <Sparkles size={12} /> {t('pet.extractCurrent')}
                </button>
              ) : null}
            </aside>
          </div>

          {mode === 'edit' && pet ? (
            <section className="pet-action-editor">
              <div className="pet-actions-head">
                <div>
                  <div className="settings-field-label">{t('pet.actions')}</div>
                  <div className="settings-field-hint">{t('pet.actionsHint')}</div>
                </div>
                <button
                  className="secondary"
                  type="button"
                  disabled={actionBusy}
                  onClick={() => {
                    invalidateAction()
                    setEditingActionId(undefined)
                    setEditingVisual(null)
                    setDeletingActionId(null)
                    setUpgradingActionId(undefined)
                    setActionFrameCount(16)
                    setActionName('')
                    setActionPrompt('')
                    setActionError(null)
                    setActionOpen(true)
                  }}
                >
                  <Plus size={12} /> {t('pet.actionAdd')}
                </button>
              </div>
              <div className="pet-default-actions" inert={actionBusy}>
                {DEFAULT_ACTION_SLOTS.map((slot) => (
                  <label className="pet-editor-field" key={slot.id}>
                    <span>{t(slot.label)}</span>
                    <select
                      value={defaultActions[slot.id] || ''}
                      onChange={(event) => {
                        const actionId = event.target.value
                        setDefaultActions((current) => {
                          const next = { ...current }
                          if (actionId) next[slot.id] = actionId
                          else delete next[slot.id]
                          return next
                        })
                      }}
                    >
                      <option value="">{t('pet.defaultActionEmpty')}</option>
                      {(pet.actions || []).map((action) => (
                        <option value={action.id} key={action.id}>
                          {actionLabel(action)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="pet-action-list editor-list">
                {(pet.actions || []).map((action) => (
                  <div className="pet-action-row" key={action.id}>
                    <button
                      className="ghost-mini pet-action-play"
                      type="button"
                      onClick={() =>
                        void onPlayAction(action.id, pet.id).catch((err) =>
                          setError(err instanceof Error ? err.message : t('pet.sheetFailed'))
                        )
                      }
                    >
                      {action.mediaType === 'video' ? <Film size={11} /> : <Play size={11} />}{' '}
                      {actionLabel(action)}
                      {action.atlas?.frames ? (
                        <span className="pet-action-frame-badge">
                          {action.atlas.frames} {t('pet.frames')}
                        </span>
                      ) : null}
                    </button>
                    {action.custom ? (
                      <button
                        className="ghost-mini"
                        type="button"
                        disabled={actionBusy}
                        aria-label={`${t('pet.actionEdit')} ${actionLabel(action)}`}
                        onClick={() => void editAction(action)}
                      >
                        <Pencil size={12} /> {t('pet.actionEdit')}
                      </button>
                    ) : null}
                    {action.atlas && action.atlas.frames! < 108 ? (
                      <button
                        className="ghost-mini"
                        type="button"
                        disabled={actionBusy}
                        title={t('pet.upgradeFrames')}
                        aria-label={`${t('pet.upgradeFrames')} ${actionLabel(action)}`}
                        onClick={() => upgradeAction(action)}
                      >
                        <Sparkles size={11} /> {t('pet.upgradeFrames')}
                      </button>
                    ) : null}
                    {action.custom ? (
                      <button
                        className="danger-ghost"
                        type="button"
                        disabled={actionBusy}
                        aria-label={`${t('pet.delete')} ${actionLabel(action)}`}
                        onClick={() => setDeletingActionId(action.id)}
                      >
                        <Trash2 size={12} /> {t('pet.delete')}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {deletingActionId && pet.actions?.some((action) => action.id === deletingActionId) ? (
                <div className="pet-action-delete-confirm" role="alert">
                  <span>
                    {t('pet.actionDeleteConfirm').replace(
                      '{name}',
                      actionLabel(pet.actions.find((action) => action.id === deletingActionId)!)
                    )}
                  </span>
                  <button
                    className="ghost-mini"
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setDeletingActionId(null)}
                  >
                    {t('action.cancel')}
                  </button>
                  <button
                    className="danger-ghost"
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void removeAction(deletingActionId)}
                  >
                    {t('pet.actionDeleteConfirmButton')}
                  </button>
                </div>
              ) : null}
              {actionJobs.length ? (
                <div className="pet-action-drafts">
                  <span className="settings-field-hint">{t('pet.savedGenerations')}</span>
                  {actionJobs.map((job) => (
                    <button
                      className="secondary"
                      type="button"
                      disabled={actionBusy}
                      key={job.jobId}
                      onClick={() => loadActionJob(job)}
                    >
                      <span>{job.prompt.slice(0, 28)}</span>
                      <span>
                        {job.completedFrames}/{job.targetFrames} {t('pet.frames')} ·{' '}
                        {t(job.state === 'complete' ? 'pet.viewDraft' : 'pet.resumeDraft')}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {actionOpen ? (
                <div className="pet-action-generator">
                  <div className="pet-action-form">
                    {editingActionId ? (
                      <div className="settings-field-hint">
                        {t('pet.actionEditHint').replace(
                          '{name}',
                          savedAction ? actionLabel(savedAction) : actionName
                        )}
                      </div>
                    ) : null}
                    {upgradingActionId ? (
                      <div className="pet-action-upgrade-hint">{t('pet.upgradeHint')}</div>
                    ) : null}
                    <label className="pet-editor-field">
                      <span>{t('pet.actionName')}</span>
                      <input
                        value={actionName}
                        disabled={actionBusy}
                        onChange={(e) => setActionName(e.target.value)}
                        placeholder={t('pet.actionNamePlaceholder')}
                      />
                    </label>
                    <label className="pet-editor-field">
                      <span>{t('pet.actionPrompt')}</span>
                      <textarea
                        value={actionPrompt}
                        disabled={actionBusy}
                        onChange={(e) => {
                          invalidateAction()
                          setActionPrompt(e.target.value)
                        }}
                        rows={3}
                        placeholder={t('pet.actionPromptPlaceholder')}
                      />
                    </label>
                    <label className="pet-editor-field pet-frame-count">
                      <span>{t('pet.frameCount')}</span>
                      <select
                        value={actionFrameCount}
                        disabled={actionBusy}
                        onChange={(e) => {
                          invalidateAction()
                          setActionFrameCount(Number(e.target.value) as PetFrameCount)
                        }}
                      >
                        {PET_FRAME_COUNTS.map((count) => (
                          <option
                            key={count}
                            value={count}
                            disabled={
                              !!upgradingActionId &&
                              count <=
                                (pet.actions?.find((a) => a.id === upgradingActionId)?.atlas
                                  ?.frames || 0)
                            }
                          >
                            {count} {t('pet.frames')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="pet-generation-actions">
                      <span className="settings-field-hint">{t('pet.sheetHint')}</span>
                      <button
                        className="secondary"
                        type="button"
                        disabled={actionBusy || extracting || generating}
                        onClick={() => void generateAction()}
                      >
                        <Sparkles size={13} className={actionBusy ? 'spin' : ''} />
                        {actionBusy
                          ? t('pet.sheetGenerating')
                          : actionProgress || actionMedia || editingActionId
                            ? t('pet.sheetRegenerate')
                            : t('pet.sheetGenerate')}
                      </button>
                    </div>
                  </div>
                  {actionProgress ? (
                    <div className="pet-action-progress" aria-live="polite">
                      <div>
                        <span>
                          {t('pet.framesSaved')} {actionProgress.completedFrames}/
                          {actionProgress.targetFrames}
                        </span>
                        <span>
                          {t(
                            actionProgress.state === 'complete'
                              ? 'pet.generationComplete'
                              : actionProgress.state === 'paused'
                                ? 'pet.generationPaused'
                                : actionProgress.state === 'failed'
                                  ? actionProgress.completedFrames
                                    ? 'pet.generationInterrupted'
                                    : 'pet.generationFailedEmpty'
                                  : 'pet.sheetGenerating'
                          )}
                        </span>
                      </div>
                      <progress
                        aria-label={t('pet.framesSaved')}
                        max={actionProgress.targetFrames}
                        value={actionProgress.completedFrames}
                      />
                      {!actionMedia?.complete ? (
                        <span className="settings-field-hint">{t('pet.partialPreview')}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="pet-action-sheet-preview">
                    {previewMedia ? (
                      previewMedia.atlas?.frames === 1 ? (
                        <img
                          className="pet-action-sheet-image"
                          src={previewMedia.dataUrl}
                          alt={t('pet.showSheet')}
                        />
                      ) : (
                        <PetActor
                          pet={pet}
                          mood="idle"
                          motion="idle"
                          playing={actionPreviewPlaying}
                          overrideVisual={{
                            type: 'sheet',
                            dataUrl: previewMedia.dataUrl,
                            atlas: previewMedia.atlas,
                            frameDurationsMs: previewMedia.frameDurationsMs
                          }}
                        />
                      )
                    ) : editingVisual && !actionProgress ? (
                      <PetActor
                        pet={pet}
                        mood="idle"
                        motion="idle"
                        overrideVisual={editingVisual}
                      />
                    ) : (
                      <div>
                        <ImageIcon size={22} />
                        <span>{actionBusy ? t('pet.sheetGenerating') : t('pet.sheetEmpty')}</span>
                      </div>
                    )}
                  </div>
                  {previewMedia?.atlas ? (
                    <div className="pet-action-sheet-details">
                      <span>
                        {previewMedia.atlas.frames}
                        {actionProgress ? `/${actionFrameCount}` : ''} {t('pet.frames')} ·{' '}
                        {Math.round(
                          ((actionProgress ? actionFrameCount : previewMedia.atlas.frames!) *
                            1000) /
                            (previewMedia.durationMs || 2000)
                        )}{' '}
                        FPS · {(previewMedia.durationMs || 2000) / 1000}s
                      </span>
                      <button
                        type="button"
                        className="ghost-mini"
                        onClick={() => setActionPreviewPlaying((value) => !value)}
                      >
                        {t(actionPreviewPlaying ? 'pet.pausePreview' : 'pet.playPreview')}
                      </button>
                    </div>
                  ) : null}
                  {transparencyLabel(actionMedia) ? (
                    <div className="settings-field-hint pet-action-motion-hint pet-transparency-status">
                      {transparencyLabel(actionMedia)}
                    </div>
                  ) : null}
                  <PetActionFrames
                    media={previewMedia}
                    total={
                      actionProgress
                        ? actionFrameCount
                        : previewMedia?.atlas?.frames || actionFrameCount
                    }
                    t={t}
                  />
                  <div className="settings-field-hint pet-action-motion-hint">
                    {t('pet.motionReviewHint')}
                  </div>
                  {actionError ? (
                    <div className="settings-error pet-action-error">{actionError}</div>
                  ) : null}
                  <div className="pet-action-generator-foot">
                    <button
                      className="ghost-mini"
                      type="button"
                      disabled={actionBusy}
                      onClick={() => setActionOpen(false)}
                    >
                      {t('action.cancel')}
                    </button>
                    {actionBusy && actionProgress ? (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => void pauseAction()}
                      >
                        {t('pet.pauseGeneration')}
                      </button>
                    ) : null}
                    {!actionBusy && actionProgress && actionProgress.state !== 'complete' ? (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => void generateAction(actionProgress.jobId)}
                      >
                        {t('pet.resumeGeneration')}
                      </button>
                    ) : null}
                    <button
                      className="primary"
                      type="button"
                      disabled={
                        actionBusy ||
                        !actionName.trim() ||
                        (!canSaveMetadata && !actionMedia?.complete)
                      }
                      onClick={() => void saveAction()}
                    >
                      {t(
                        canSaveMetadata
                          ? 'pet.actionSaveMetadata'
                          : upgradingActionId
                            ? 'pet.saveUpgrade'
                            : 'pet.actionSave'
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          {error ? <div className="settings-error pet-editor-error">{error}</div> : null}
        </div>

        <div className="pet-editor-foot">
          {mode === 'edit' && pet?.deletable ? (
            <button
              className="danger-ghost"
              type="button"
              disabled={actionBusy}
              onClick={() => void onDelete()}
            >
              <Trash2 size={12} /> {t('pet.delete')}
            </button>
          ) : (
            <span />
          )}
          <div className="wallpaper-actions">
            <button
              className="ghost-mini"
              type="button"
              disabled={busy || generating || extracting || actionBusy}
              onClick={onClose}
            >
              {t('action.cancel')}
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy || generating || extracting || actionBusy}
              onClick={() => void save()}
            >
              {busy ? t('pet.saving') : t('pet.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
