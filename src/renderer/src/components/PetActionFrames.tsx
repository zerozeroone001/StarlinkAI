import { useId } from 'react'
import type { PetGeneratedMedia } from '@shared/types'
import type { MsgKey } from '@/lib/i18n'

/** Show saved poses in one continuous strip, without cards or duplicating the source image. */
export function PetActionFrames({ media, total, t }: {
  media: PetGeneratedMedia | null
  total: number
  t: (key: MsgKey) => string
}) {
  const imageId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const atlas = media?.atlas
  const indices = media?.frameIndices || Array.from({ length: atlas?.frames || 0 }, (_, i) => i)
  const packed = new Map(indices.map((index, i) => [index, i]))
  return <section className="pet-action-contact-sheet" aria-label={t('pet.actionFrames')}>
    <div className="pet-action-contact-heading"><strong>{t('pet.actionFrames')}</strong><span>{t('pet.actionFramesHint')}</span></div>
    {atlas && media ? <svg width="0" height="0" className="pet-frame-definitions" aria-hidden="true">
      <defs><image id={imageId} href={media.dataUrl} width={atlas.columns * atlas.cellWidth} height={atlas.rows * atlas.cellHeight} /></defs>
    </svg> : null}
    <div className="pet-action-strip" tabIndex={0} aria-label={t('pet.actionFramesHint')}>
      {Array.from({ length: Math.min(128, Math.max(1, total)) }, (_, index) => {
        const cell = packed.get(index)
        if (cell === undefined || !atlas) return null
        return <figure key={index} className="pet-action-frame ready" data-timeline-frame={index + 1}>
          <svg role="img" aria-label={`${t('pet.frame')} ${index + 1}`}
            viewBox={`${cell % atlas.columns * atlas.cellWidth} ${Math.floor(cell / atlas.columns) * atlas.cellHeight} ${atlas.cellWidth} ${atlas.cellHeight}`}
            preserveAspectRatio="xMidYMid meet"><use href={`#${imageId}`} /></svg>
          <figcaption>{String(index + 1).padStart(2, '0')}</figcaption>
        </figure>
      })}
      {!atlas || !indices.length ? <div className="pet-action-strip-empty">{t('pet.sheetEmpty')}</div> : null}
    </div>
  </section>
}
