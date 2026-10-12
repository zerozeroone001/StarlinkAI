import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { createPortal } from 'react-dom'
import { Download, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
import { useT } from '@/lib/i18n'

export function ImageZoom({
  src,
  className,
  title,
  fileName,
  sourcePath,
  cwd,
  sessionId,
  showActions = false
}: {
  src: string
  className?: string
  title?: string
  fileName?: string
  sourcePath?: string
  cwd?: string
  sessionId?: string
  showActions?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saveError, setSaveError] = useState('')
  const trigger = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
  } | null>(null)

  const enlarge = (e?: MouseEvent) => {
    e?.preventDefault()
    e?.stopPropagation()
    if (failed) { setFailed(false); return }
    setScale(1)
    setPan({ x: 0, y: 0 })
    setOpen(true)
  }

  const close = () => {
    drag.current = null
    setDragging(false)
    setScale(1)
    setPan({ x: 0, y: 0 })
    setOpen(false)
    trigger.current?.focus()
  }

  const zoomWithWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.deltaY === 0) return
    const zoomingIn = event.deltaY < 0
    const nextScale = Math.min(
      5,
      Math.max(1, Math.round((scale + (zoomingIn ? 0.25 : -0.25)) * 100) / 100)
    )

    if (!zoomingIn) {
      drag.current = null
      setDragging(false)
      setPan({ x: 0, y: 0 })
      if (nextScale !== scale) setScale(nextScale)
      return
    }

    if (Math.abs(nextScale - scale) < 0.001) return

    const image = event.currentTarget.querySelector('img')
    if (image) {
      const rect = image.getBoundingClientRect()
      const baseCenterX = rect.left + rect.width / 2 - pan.x
      const baseCenterY = rect.top + rect.height / 2 - pan.y
      const pointX = (event.clientX - baseCenterX - pan.x) / scale
      const pointY = (event.clientY - baseCenterY - pan.y) / scale
      setPan({
        x: event.clientX - baseCenterX - pointX * nextScale,
        y: event.clientY - baseCenterY - pointY * nextScale
      })
    }
    setScale(nextScale)
  }

  const startPan = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y
    }
    setDragging(true)
  }

  const movePan = (event: ReactPointerEvent<HTMLImageElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    event.preventDefault()
    setPan({
      x: start.panX + event.clientX - start.startX,
      y: start.panY + event.clientY - start.startY
    })
  }

  const stopPan = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const save = async (e?: MouseEvent) => {
    e?.preventDefault()
    e?.stopPropagation()
    try {
      setSaveError('')
      let dataUrl = src
      if (/^(https?:|blob:)/i.test(src) && (typeof window.grok?.saveMedia !== 'function' || src.startsWith('blob:'))) {
        const response = await fetch(src)
        if (!response.ok) throw new Error('下载失败')
        const blob = await response.blob()
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }
      const baseName = fileName || (sourcePath ? sourcePath.split(/[\\/]/).pop() : '') || 'image'
      const extension = /^data:image\/jpeg/i.test(dataUrl) ? 'jpg' : /^data:image\/webp/i.test(dataUrl) ? 'webp' : 'png'
      const name = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(baseName) ? baseName : `${baseName}.${extension}`
      if (typeof window.grok?.saveMedia !== 'function') {
        const link = document.createElement('a')
        link.href = dataUrl
        link.download = name
        link.click()
        return
      }
      await window.grok.saveMedia({
        dataUrl,
        path: sourcePath,
        name,
        cwd,
        sessionId
      })
    } catch {
      setSaveError('图片保存失败，请重试。')
    }
  }

  useEffect(() => {
    if (!open) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
      if (e.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
        if (!buttons?.length) return
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow }
  }, [open])
  useEffect(() => { setFailed(false); setSaveError(''); setOpen(false); setScale(1); setPan({ x: 0, y: 0 }) }, [src])

  const changeScale = (value: number) => { setScale(Math.min(5, Math.max(1, value))); setPan({ x: 0, y: 0 }) }

  return (
    <>
      <div
        ref={trigger}
        className={`${className || ''} img-zoom no-drag`.trim()}
        title={title || t('image.zoomHint')}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        role="button"
        tabIndex={0}
        onClick={enlarge}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {failed ? <span className="img-missing" role="status">图片加载失败，点击重试</span> : <img src={src} alt={title || '图片'} draggable={false} onError={() => setFailed(true)} />}
        {showActions ? (
          <div className="img-zoom-bar">
            <button type="button" onClick={enlarge} title={t('image.zoom')}>
              <ZoomIn size={13} /> {t('image.zoom')}
            </button>
            <button type="button" onClick={(e) => void save(e)} title={t('image.save')}>
              <Download size={13} /> {t('image.save')}
            </button>
          </div>
        ) : null}
      </div>
      {open
        ? createPortal(
            <div
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-label="图片预览"
              tabIndex={-1}
              className={`lightbox no-drag${scale > 1 ? ' zoomed' : ''}${dragging ? ' dragging' : ''}`}
              onClick={close}
              onWheel={zoomWithWheel}
            >
              <img
                src={src}
                alt=""
                draggable={false}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={stopPan}
                onPointerCancel={stopPan}
                onDoubleClick={() => changeScale(scale === 1 ? 2 : 1)}
              />
              <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <span className="lightbox-scale">{Math.round(scale * 100)}%</span>
                <button type="button" className="secondary" aria-label="缩小图片" disabled={scale <= 1} onClick={() => changeScale(scale - 0.25)}><ZoomOut size={16} /></button>
                <button type="button" className="secondary" aria-label="放大图片" disabled={scale >= 5} onClick={() => changeScale(scale + 0.25)}><ZoomIn size={16} /></button>
                <button type="button" className="secondary" aria-label="重置缩放" onClick={() => changeScale(1)}><RotateCcw size={16} /></button>
                <button type="button" className="secondary" onClick={(e) => void save(e)}>
                  <Download size={14} /> {t('image.save')}
                </button>
                <button type="button" className="secondary" onClick={close}>
                  {t('action.close')}
                </button>
              </div>
              {saveError && <p className="lightbox-error" role="alert">{saveError}</p>}
            </div>,
            document.body
          )
        : null}
      {!open && saveError && <p className="ws-error" role="alert">{saveError}</p>}
    </>
  )
}
