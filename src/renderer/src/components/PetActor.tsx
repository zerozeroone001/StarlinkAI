import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PET_ATLAS,
  type PetAtlas,
  type PetInfo,
  type PetMood,
  type PetMotion,
  type PetVisual
} from '@shared/types'
import { RivePet } from './RivePet'
import { actionPreviewFrame, petSpriteCell, petSpriteSequence } from '@shared/pet-animation'

function moodMotion(mood: PetMood): PetMotion {
  if (mood === 'waving') return 'wave'
  if (mood === 'jumping') return 'jump'
  if (mood === 'running') return 'run'
  if (mood === 'waiting') return 'sit'
  if (mood === 'failed') return 'shy'
  if (mood === 'review') return 'cheer'
  return 'idle'
}

export function SpritePet({
  src,
  mood,
  atlas,
  frameDurationsMs,
  playing = true
}: {
  src: string
  mood: PetMood
  atlas?: PetAtlas
  frameDurationsMs?: number[]
  playing?: boolean
}) {
  const grid = atlas || DEFAULT_PET_ATLAS
  const { start, frames, frameDurationMs } = petSpriteSequence(grid, mood)
  const [frame, setFrame] = useState(0)
  const durationsKey = frameDurationsMs?.join(',') || ''
  const clock = useRef({ src: '', timing: '', elapsed: 0 })
  useEffect(() => {
    const timing = `${start}:${frames}:${frameDurationMs}:${durationsKey}`
    if (clock.current.src !== src || clock.current.timing !== timing) clock.current = { src, timing, elapsed: 0 }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer = 0
    let epoch: number | null = null
    const durations = durationsKey.split(',').map(Number)
    const timed = durations.length === frames && durations.every(value => Number.isFinite(value) && value > 0)
    const update = (elapsed: number) => setFrame(timed ? actionPreviewFrame(elapsed, durations) : Math.floor(elapsed / frameDurationMs) % frames)
    const stop = () => {
      window.cancelAnimationFrame(timer)
      if (epoch !== null) clock.current.elapsed += performance.now() - epoch
      epoch = null
    }
    const restart = () => {
      stop()
      update(clock.current.elapsed)
      if (!playing || media.matches || frames <= 1) return
      epoch = performance.now()
      const tick = (now: number) => {
        update(clock.current.elapsed + now - epoch!)
        timer = window.requestAnimationFrame(tick)
      }
      timer = window.requestAnimationFrame(tick)
    }
    restart()
    media.addEventListener('change', restart)
    return () => { stop(); media.removeEventListener('change', restart) }
  }, [start, frames, frameDurationMs, src, durationsKey, playing])
  const { column, row } = petSpriteCell(grid, frame, mood)
  return (
    <svg
      className="pet-sprite"
      data-frame={frame}
      data-column={column}
      data-row={row}
      viewBox={`0 0 ${grid.cellWidth} ${grid.cellHeight}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <svg width={grid.cellWidth} height={grid.cellHeight} style={{ width: grid.cellWidth, height: grid.cellHeight }} overflow="hidden">
        <image
          href={src}
          x={-column * grid.cellWidth}
          y={-row * grid.cellHeight}
          width={grid.columns * grid.cellWidth}
          height={grid.rows * grid.cellHeight}
          preserveAspectRatio="none"
        />
      </svg>
    </svg>
  )
}

export function PetActor({
  pet,
  mood,
  compact,
  sheet,
  motion,
  overrideSrc,
  overrideVisual,
  playing
}: {
  pet: PetInfo | string
  mood: PetMood
  compact?: boolean
  sheet?: PetVisual | { dataUrl: string; atlas?: PetAtlas } | null
  motion?: PetMotion
  overrideSrc?: string | null
  overrideVisual?: PetVisual | null
  playing?: boolean
}) {
  const id = typeof pet === 'string' ? pet : pet.id
  const info = typeof pet === 'string' ? null : pet
  const [riveFailed, setRiveFailed] = useState(false)
  const [visual, setVisual] = useState<PetVisual | null>(
    sheet?.dataUrl
      ? 'type' in sheet
        ? sheet
        : { type: 'portrait', dataUrl: sheet.dataUrl, atlas: sheet.atlas }
      : null
  )

  useEffect(() => {
    if (sheet?.dataUrl) {
      setVisual('type' in sheet ? sheet : { type: 'portrait', dataUrl: sheet.dataUrl, atlas: sheet.atlas })
      return
    }
    if (typeof window.grok?.pets?.visual !== 'function') return
    let alive = true
    void window.grok.pets.visual(id).then((res) => {
      if (alive) setVisual(res)
    })
    return () => {
      alive = false
    }
  }, [id, sheet, info?.visualVersion])

  useEffect(() => setRiveFailed(false), [id, visual?.dataUrl])

  const activeVisual: PetVisual | null = overrideVisual || (overrideSrc ? { type: /^data:video\//i.test(overrideSrc) ? 'video' : 'portrait', dataUrl: overrideSrc } : visual)
  const src = activeVisual?.dataUrl
  const usedMotion = motion || moodMotion(mood)
  const isSheet = activeVisual?.type === 'sheet'
  const isVideo = activeVisual?.type === 'video'
  const isRive = Boolean(src && activeVisual?.type === 'rive' && activeVisual.rive && !riveFailed)
  const fallbackSrc = riveFailed ? activeVisual?.fallbackDataUrl : undefined

  return (
    <div
      className={'pet-actor' + (compact ? ' compact' : '')}
      data-mood={mood}
      data-motion={usedMotion}
      data-pet={id}
      data-media-type={activeVisual?.type}
    >
      {src && isRive && activeVisual?.rive ? (
        <RivePet
          src={src}
          config={activeVisual.rive}
          mood={mood}
          motion={motion}
          onError={() => setRiveFailed(true)}
        />
      ) : src && isVideo ? (
        <video className="pet-action-video" src={src} autoPlay muted playsInline loop draggable={false} />
      ) : src && isSheet ? (
        <SpritePet src={src} mood={mood} atlas={activeVisual?.atlas || info?.atlas} frameDurationsMs={activeVisual?.frameDurationsMs} playing={playing} />
      ) : fallbackSrc ? (
        <img className="pet-portrait" src={fallbackSrc} alt="" draggable={false} />
      ) : src && activeVisual?.type === 'rive' ? (
        <div className="pet-placeholder">{(info?.name || id).slice(0, 1)}</div>
      ) : src ? (
        <img className="pet-portrait" src={src} alt="" draggable={false} />
      ) : (
        <div className="pet-placeholder">{(info?.name || id).slice(0, 1)}</div>
      )}
    </div>
  )
}
