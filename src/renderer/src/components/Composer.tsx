import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Clock3,
  Globe,
  Paperclip,
  Square,
  X
} from 'lucide-react'
import { EFFORTS, MODELS, type PermissionMode, type PromptAttachment } from '@shared/types'
import { isImageAttachment } from '@/lib/files'
import { ImageZoom } from './ImageZoom'
import { useApp } from '@/stores/app'
import { useT, type MsgKey } from '@/lib/i18n'
import { skillBlurb } from '@/lib/skill-i18n'
import { handleComposerEnter } from '@/lib/composer-keyboard'

const PERMISSIONS: { id: PermissionMode; label: MsgKey; hint: MsgKey }[] = [
  { id: 'ask', label: 'composer.ask', hint: 'composer.askDesc' },
  { id: 'review', label: 'composer.review', hint: 'composer.legacyReviewDesc' },
  { id: 'auto', label: 'composer.full', hint: 'composer.fullDesc' }
]

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
    : [minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function Menu({
  open,
  onClose,
  children
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="menu" style={{ bottom: 44, left: 0 }}>
        {children}
      </div>
    </>
  )
}

export function Composer({ centered = false }: { centered?: boolean }) {
  const {
    draft,
    setDraft,
    send,
    cancel,
    running,
    messages,
    model,
    setModel,
    effort,
    setEffort,
    permissionMode,
    setPermissionMode,
    git,
    cwd,
    activeThreadId,
    skills,
    setSkillsOpen,
    wakePet,
    tuckPet,
    petAwake,
    locale
  } = useApp()
  const t = useT()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const permTrigger = useRef<HTMLButtonElement>(null)
  const permMenu = useRef<HTMLDivElement>(null)
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const fallbackRunStartedAt = useRef<number | null>(null)
  const selectedPermission = PERMISSIONS.find((item) => item.id === permissionMode) || PERMISSIONS[0]

  useEffect(() => {
    if (permOpen) permMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [permOpen])

  const closePermissions = () => {
    setPermOpen(false)
    permTrigger.current?.focus()
  }

  const onPermissionKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      event.stopPropagation()
      closePermissions()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  if (!running) fallbackRunStartedAt.current = null
  else if (fallbackRunStartedAt.current === null) fallbackRunStartedAt.current = Date.now()
  const runStartedAt = useMemo(() => {
    if (!running) return null
    const lastUserMessage = [...messages].reverse().find((message) => message.kind === 'user')
    const timestamp = lastUserMessage ? Date.parse(lastUserMessage.createdAt) : Number.NaN
    return Number.isFinite(timestamp) ? timestamp : fallbackRunStartedAt.current
  }, [running, messages])
  const elapsed = runStartedAt === null ? 0 : Math.max(0, Math.floor((now - runStartedAt) / 1000))

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, runStartedAt])

  const slashQuery =
    draft.startsWith('/') && !draft.includes('\n') && !draft.includes(' ') ? draft.slice(1).toLowerCase() : null

  const slashItems = useMemo(() => {
    if (slashQuery === null) return []
    const builtins = [
      { id: 'cmd:pet', name: 'pet', hint: t('slash.petHint') },
      { id: 'cmd:skills', name: 'skills', hint: t('slash.skillsHint') }
    ]
    const fromSkills = skills
      .filter((s) => s.userInvocable && !s.disabled)
      .map((s) => ({ id: `skill:${s.name}`, name: s.name, hint: skillBlurb(s, locale) }))
    return [...builtins, ...fromSkills].filter(
      (item) => !slashQuery || item.name.startsWith(slashQuery) || item.name.includes(slashQuery)
    )
  }, [slashQuery, skills, t, locale])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

  const pickSlash = (item: { id: string; name: string }) => {
    if (item.id === 'cmd:pet') {
      if (petAwake) void tuckPet()
      else void wakePet()
      setDraft('')
      return
    }
    if (item.id === 'cmd:skills') {
      setSkillsOpen(true)
      setDraft('')
      return
    }
    const skill = skills.find((s) => s.name === item.name)
    setDraft(`/${item.name}${skill?.argumentHint ? ' ' : ''}`)
    ref.current?.focus()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [draft])

  useEffect(() => {
    setAttachments([])
  }, [activeThreadId])

  const submit = () => {
    if (!draft.trim() && !attachments.length) return
    void send(draft, attachments)
    setAttachments([])
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if ((e.ctrlKey || e.metaKey) && handleComposerEnter(e, setDraft, submit)) return
    if (slashItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.repeat)) {
        e.preventDefault()
        pickSlash(slashItems[slashIndex] || slashItems[0])
        return
      }
    }
    if (handleComposerEnter(e, setDraft, submit)) return
    if (e.key === 'Escape' && running) void cancel()
  }

  const attach = async () => {
    const files = await window.grok.pickFiles()
    if (!files.length) return
    const chips: PromptAttachment[] = []
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() || file
      let dataUrl: string | undefined
      let mime: string | undefined
      try {
        const preview = await window.grok.previewFile(file)
        dataUrl = preview.dataUrl
        mime = preview.mime
      } catch {
        /* ignore */
      }
      chips.push({ path: file, name, dataUrl, mime })
    }
    setAttachments((prev) => [...prev, ...chips])
    ref.current?.focus()
  }

  return (
    <div className={centered ? 'composer-centered' : 'composer-dock'}>
      {running ? (
        <div className="runtime-row" aria-live="off">
          <span className="runtime-chip" title={t('thread.elapsed')} aria-label={t('thread.elapsed')}>
            <Clock3 size={13} />
            <span>{formatElapsed(elapsed)}</span>
          </span>
        </div>
      ) : null}
      <div className="composer relative">
        {attachments.length ? (
          <div className="attach-strip">
            {attachments.map((a) => (
              <div className="attach-chip" key={a.path}>
                {a.dataUrl && isImageAttachment(a) ? (
                  <ImageZoom src={a.dataUrl} className="attach-thumb" />
                ) : (
                  <Paperclip size={14} />
                )}
                <span>{a.name}</span>
                <button
                  className="icon-btn"
                  title={t('composer.remove')}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {slashItems.length ? (
          <div className="slash-menu">
            {slashItems.slice(0, 12).map((item, i) => (
              <button
                type="button"
                key={item.id}
                className={'slash-item' + (i === slashIndex ? ' on' : '')}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickSlash(item)
                }}
              >
                <span>/{item.name}</span>
                <span className="hint">{item.hint}</span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={cwd ? t('composer.placeholder') : t('composer.placeholderNoProject')}
          title={t('composer.keyboardHint')}
          rows={2}
        />
        <div className="composer-tools">
          {git?.branch ? (
            <span className="chip">
              <Globe size={13} />
              {git.branch}
            </span>
          ) : null}
          <div className="relative">
            <button className="chip-btn" onClick={() => setModelOpen((v) => !v)}>
              {MODELS.find((m) => m.id === model)?.label || model}
              <ChevronDown size={12} />
            </button>
            <Menu open={modelOpen} onClose={() => setModelOpen(false)}>
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setModel(m.id)
                    setModelOpen(false)
                  }}
                >
                  {m.label} <span className="hint">{m.hint}</span>
                </button>
              ))}
            </Menu>
          </div>
          <div className="relative">
            <button className="chip-btn" onClick={() => setEffortOpen((v) => !v)}>
              {EFFORTS.find((e) => e.id === effort)?.label}
              <ChevronDown size={12} />
            </button>
            <Menu open={effortOpen} onClose={() => setEffortOpen(false)}>
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  onClick={() => {
                    setEffort(e.id)
                    setEffortOpen(false)
                  }}
                >
                  {e.label}
                </button>
              ))}
            </Menu>
          </div>
          <div className="relative">
            <button
              ref={permTrigger}
              className="chip-btn"
              aria-label={`${t('composer.permissions')}: ${t(selectedPermission.label)}`}
              aria-haspopup="menu"
              aria-expanded={permOpen}
              title={t(selectedPermission.hint)}
              onClick={() => setPermOpen((v) => !v)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setPermOpen(true)
                }
              }}
            >
              {t(selectedPermission.label)}
              <ChevronDown size={12} />
            </button>
            <Menu open={permOpen} onClose={closePermissions}>
              <div
                ref={permMenu}
                role="menu"
                aria-label={t('composer.permissions')}
                onKeyDown={onPermissionKey}
                style={{ width: 260 }}
              >
                {PERMISSIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={permissionMode === item.id}
                    tabIndex={permissionMode === item.id ? 0 : -1}
                    onClick={() => {
                      setPermissionMode(item.id)
                      closePermissions()
                    }}
                  >
                    <Check size={14} style={{ flexShrink: 0, opacity: permissionMode === item.id ? 1 : 0 }} />
                    <span>
                      {t(item.label)}
                      <span className="hint" style={{ display: 'block', marginLeft: 0, marginTop: 3, lineHeight: 1.4 }}>
                        {t(item.hint)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </Menu>
          </div>
          <div className="spacer" />
          <button className="icon-btn" title={t('composer.attach')} onClick={() => void attach()}>
            <Paperclip size={16} />
          </button>
          <button className="icon-btn" title={t('composer.mention')} onClick={() => void attach()}>
            <AtSign size={16} />
          </button>
          {running ? (
            <button className="send stop" onClick={() => void cancel()} title={t('composer.stop')}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send"
              disabled={!draft.trim() && !attachments.length}
              onClick={submit}
              title={`${t('composer.send')} · ${t('composer.keyboardHint')}`}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
