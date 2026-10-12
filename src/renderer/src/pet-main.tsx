import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type {
  Locale,
  PetDefaultAction,
  PetActionEvent,
  PetLiveStatus,
  PetMood,
  PetMotion,
  PetSnapshot,
  PetVisual,
  Theme
} from '@shared/types'
import { PetActor } from './components/PetActor'
import { translate, type MsgKey } from './lib/i18n'
import './styles.css'

document.documentElement.classList.add('pet-root')

type PlayingAction = { petId: string; motion: PetMotion; visual: PetVisual | null; playbackId?: number }

function defaultActionSlot(mood: PetMood): PetDefaultAction {
  if (mood === 'running') return 'work'
  if (mood === 'waiting' || mood === 'review' || mood === 'failed') return 'report'
  if (mood === 'waving' || mood === 'jumping') return 'play'
  return 'rest'
}

function PetApp() {
  const [snap, setSnap] = useState<PetSnapshot | null>(null)
  const [status, setStatus] = useState<PetLiveStatus | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')
  const [locale, setLocale] = useState<Locale>('en')
  const [sheet, setSheet] = useState<PetVisual | null>(null)
  const [flourish, setFlourish] = useState<PetMood | null>(null)
  const [action, setAction] = useState<PlayingAction | null>(null)
  const [defaultAction, setDefaultAction] = useState<PlayingAction | null>(null)
  const actionTimer = useRef<number | undefined>(undefined)
  const playbackId = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
  }, [theme, locale])

  useEffect(() => {
    if (typeof window.grok === 'undefined') return
    const offStatus = window.grok.on('pets:status', (payload) => setStatus(payload as PetLiveStatus))
    const offSnap = window.grok.on('pets:snapshot', (payload) => {
      const next = payload as PetSnapshot
      setSnap(next)
      setStatus(next.status)
      setTheme(next.theme)
      setLocale(next.locale)
    })
    const offChrome = window.grok.on('pets:chrome', (payload) => {
      const chrome = payload as { theme?: Theme; locale?: Locale }
      if (chrome.theme) setTheme(chrome.theme)
      if (chrome.locale) setLocale(chrome.locale)
    })
    const offAction = window.grok.on('pets:action', (payload) => {
      const next = payload as PetActionEvent
      window.clearTimeout(actionTimer.current)
      const visual = next.visual || (next.dataUrl ? {
        type: /^data:video\//i.test(next.dataUrl) ? 'video' as const : 'portrait' as const,
        dataUrl: next.dataUrl
      } : null)
      setAction({ petId: next.petId, motion: next.motion || 'idle', visual, playbackId: ++playbackId.current })
      actionTimer.current = window.setTimeout(() => setAction(null), Math.max(100, next.durationMs || 1800))
    })
    // Request readiness only after listeners exist, so a first-wake action is not lost.
    void window.grok.pets.snapshot().then((s) => {
      setSnap(s)
      setStatus(s.status)
      setTheme(s.theme)
      setLocale(s.locale)
    })
    return () => {
      offStatus()
      offSnap()
      offChrome()
      offAction()
      window.clearTimeout(actionTimer.current)
    }
  }, [])

  const pet = useMemo(
    () => snap?.pets.find((p) => p.id === snap.petId) || snap?.pets[0] || null,
    [snap]
  )

  useEffect(() => {
    if (!pet || typeof window.grok === 'undefined') {
      setSheet(null)
      return
    }
    let alive = true
    setSheet(null)
    void window.grok.pets.visual(pet.id).then((res) => {
      if (alive) setSheet(res)
    })
    return () => {
      alive = false
    }
  }, [pet?.id, pet?.visualVersion])

  useEffect(() => {
    setAction((current) => {
      if (current && current.petId !== pet?.id) {
        window.clearTimeout(actionTimer.current)
        return null
      }
      return current
    })
  }, [pet?.id])

  useEffect(() => {
    if (!status) return
    if (status.mood === 'running' || status.mood === 'waiting') {
      setFlourish('jumping')
      const t = window.setTimeout(() => setFlourish(null), 700)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [status?.mood, status?.threadId])

  const t = (key: MsgKey) => translate(locale, key)
  const mood: PetMood = flourish || status?.mood || 'idle'
  const live = status || {
    mood: 'idle' as const,
    title: 'StarlinkAI',
    hint: t('pet.ready'),
    threadId: null,
    runningCount: 0,
    needsInput: false
  }

  useEffect(() => {
    if (!pet || typeof window.grok === 'undefined') {
      setDefaultAction(null)
      return
    }
    const slot = defaultActionSlot(mood)
    const actionId = pet.defaultActions?.[slot]
    const selected = actionId ? pet.actions?.find((item) => item.id === actionId) : null
    if (!selected) {
      setDefaultAction(null)
      return
    }
    let alive = true
    setDefaultAction(null)
    if (!selected.file) {
      setDefaultAction({ petId: pet.id, motion: selected.motion || 'idle', visual: null })
      return
    }
    void window.grok.pets.visual(pet.id, selected.file).then((visual) => {
      if (alive && visual) setDefaultAction({ petId: pet.id, motion: selected.motion || 'idle', visual })
    }).catch(() => { if (alive) setDefaultAction(null) })
    return () => {
      alive = false
    }
  }, [mood, pet])

  const activeAction = (action?.petId === pet?.id ? action : null) || (defaultAction?.petId === pet?.id ? defaultAction : null)

  const activate = () => {
    if (typeof window.grok === 'undefined') return
    void window.grok.pets.activate(live.threadId)
  }

  const drag = React.useRef<{
    pointer: number
    sx: number
    sy: number
    wx: number
    wy: number
    moved: boolean
  } | null>(null)
  const [grabbing, setGrabbing] = useState(false)

  const onPointerDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || typeof window.grok === 'undefined') return
    const bounds = await window.grok.pets.bounds()
    drag.current = {
      pointer: e.pointerId,
      sx: e.screenX,
      sy: e.screenY,
      wx: bounds.x,
      wy: bounds.y,
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setGrabbing(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    const dx = e.screenX - d.sx
    const dy = e.screenY - d.sy
    if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true
    if (d.moved) void window.grok.pets.moveTo(d.wx + dx, d.wy + dy)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    drag.current = null
    setGrabbing(false)
    if (typeof window.grok !== 'undefined') void window.grok.pets.endDrag()
    if (!d.moved) activate()
  }

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault()
    if (typeof window.grok === 'undefined') return
    void window.grok.pets.menu()
  }

  return (
    <div
      className={'pet-page' + (grabbing ? ' grabbing' : '')}
      data-mood={live.mood}
      data-motion={activeAction?.motion || undefined}
      onPointerDown={(e) => void onPointerDown(e)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContext}
      title={t('pet.clickHint')}
    >
      <div className="pet-hit">
        {pet ? (
          <PetActor
            key={activeAction?.playbackId || pet.id}
            pet={pet}
            mood={mood}
            sheet={sheet}
            motion={activeAction?.motion}
            overrideVisual={activeAction?.visual}
          />
        ) : null}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PetApp />
  </React.StrictMode>
)
