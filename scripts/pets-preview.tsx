// Isolated UI fixture: no CLI calls, uploads, filesystem writes or real user pet data.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PetActionDraft, PetInfo, PetActionGenerationOptions, PetActionProgress, PetFrameCount, PetSubjectExtractionOptions } from '../src/shared/types'
import { PET_ACTION_ATLAS, actionAtlasFor, actionAnchorIndices, actionInbetweenOrder, actionPreviewDurations } from '../src/shared/pet-animation'
import { PetEditorModal } from '../src/renderer/src/components/SettingsModal'
import { SpritePet } from '../src/renderer/src/components/PetActor'
import { translate } from '../src/renderer/src/lib/i18n'
import '../src/renderer/src/styles.css'

document.documentElement.dataset.theme = 'dark'
const a = PET_ACTION_ATLAS
const canvas = document.createElement('canvas')
canvas.width = a.columns * a.cellWidth
canvas.height = a.rows * a.cellHeight
const c = canvas.getContext('2d')!
for (let frame = 0; frame < a.frames; frame++) {
  c.save()
  c.translate(frame % a.columns * a.cellWidth + 96, Math.floor(frame / a.columns) * a.cellHeight)
  c.fillStyle = '#dab49b'
  c.beginPath(); c.arc(0, 55, 22, 0, Math.PI * 2); c.fill()
  c.fillStyle = '#9d82e3'; c.fillRect(-25, 83, 50, 85)
  c.strokeStyle = '#9d82e3'; c.lineWidth = 13; c.lineCap = 'round'
  const angle = Math.sin(frame / 16 * Math.PI * 2) * 0.8 - 0.8
  c.beginPath(); c.moveTo(22, 95); c.lineTo(22 + Math.cos(angle) * 50, 95 + Math.sin(angle) * 50); c.stroke()
  c.beginPath(); c.moveTo(-22, 95); c.lineTo(-40, 140); c.stroke()
  c.strokeStyle = '#667eb7'
  c.beginPath(); c.moveTo(-13, 169); c.lineTo(-17, 223); c.moveTo(13, 169); c.lineTo(17, 223); c.stroke()
  c.restore()
}
const sheetUrl = canvas.toDataURL('image/png')
const portrait = document.createElement('canvas')
portrait.width = a.cellWidth; portrait.height = a.cellHeight
portrait.getContext('2d')!.drawImage(canvas, 0, 0, a.cellWidth, a.cellHeight, 0, 0, a.cellWidth, a.cellHeight)
const portraitUrl = portrait.toDataURL('image/png')
let lastReference = ''
const extractionRequests: PetSubjectExtractionOptions[] = []
const generationRequests: Array<{ prompt: string; count: number }> = []
const listeners = new Set<(payload: unknown) => void>()
const jobs = new Map<string, PetActionProgress>()
const paused = new Set<string>()
function previewFrames(frames: number, total: number, upgrade = false) {
  const anchors = actionAnchorIndices(upgrade ? 16 : 4, total)
  const indices = [...anchors, ...actionInbetweenOrder(anchors, total)].slice(0, frames).sort((a, b) => a - b)
  const atlas = actionAtlasFor(frames, 2000)
  const partial = document.createElement('canvas')
  partial.width = atlas.columns * atlas.cellWidth; partial.height = atlas.rows * atlas.cellHeight
  const paint = partial.getContext('2d')!
  for (let i = 0; i < frames; i++) {
    const source = Math.floor(indices[i] * 16 / total) % 16
    paint.drawImage(canvas, source % 4 * a.cellWidth, Math.floor(source / 4) * a.cellHeight, a.cellWidth, a.cellHeight,
      i % atlas.columns * a.cellWidth, Math.floor(i / atlas.columns) * a.cellHeight, a.cellWidth, a.cellHeight)
  }
  return { atlas, dataUrl: partial.toDataURL('image/png'), frameIndices: indices, frameDurationsMs: actionPreviewDurations(indices, total, 2000) }
}
window.grok = {
  on: (_channel: string, listener: (payload: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  pickImage: async () => portraitUrl,
  pets: {
    visual: async (_id: string, file?: string) => file ? ({ type: 'sheet', dataUrl: sheetUrl, atlas: a }) : ({ type: 'portrait', dataUrl: portraitUrl }),
    generateImages: async (prompt: string, count: number) => {
      generationRequests.push({ prompt, count })
      if (prompt.includes('无效')) throw new Error('PET_SUBJECT_INVALID')
      return Array.from({ length: count }, (_, i) => ({ path: `/fixture/direct-${i}.png`, dataUrl: portraitUrl, mime: 'image/png', transparency: prompt.includes('原生') ? 'native-alpha' : 'local-key' }))
    },
    extractSubject: async (_file: string, _target: string, options: PetSubjectExtractionOptions = {}) => {
      extractionRequests.push(options)
      return { path: `/fixture/standing-${extractionRequests.length}.png`, dataUrl: portraitUrl, mime: 'image/png' }
    },
    actionJobs: async () => [...jobs.values()],
    pauseActionGeneration: async (_petId: string, id: string) => { paused.add(id) },
    generateActionSheet: async (_petId: string, prompt: string, reference: string, options: PetActionGenerationOptions = {}) => {
      lastReference = reference || 'saved portrait'
      const id = options.resumeJobId || crypto.randomUUID()
      const old = jobs.get(id)
      const total = (old?.targetFrames || options.frameCount || 16) as PetFrameCount
      const progress: PetActionProgress = { requestId: options.requestId || '', jobId: id, petId: 'test', prompt: old?.prompt || prompt, sourceActionId: old?.sourceActionId || options.sourceActionId, replaceActionId: old?.replaceActionId || options.replaceActionId,
        targetFrames: total, completedFrames: old?.completedFrames || (options.sourceActionId ? 16 : 0), state: 'running' }
      paused.delete(id)
      const publish = () => { jobs.set(id, { ...progress }); for (const listener of listeners) listener({ ...progress }) }
      publish()
      if (prompt.includes('超时') && !options.resumeJobId) {
        await new Promise(resolve => setTimeout(resolve, 300))
        progress.state = 'failed'; progress.error = 'PET_MEDIA_TIMEOUT: StarlinkAI generation timed out'; publish()
        throw new Error(progress.error)
      }
      while (progress.completedFrames < total) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (paused.has(id)) { progress.state = 'paused'; publish(); throw new Error('PET_JOB_PAUSED') }
        progress.completedFrames = Math.min(total, progress.completedFrames + 1)
        progress.media = { path: `/fixture/${id}.png`, mime: 'image/png', ...previewFrames(progress.completedFrames, total, Boolean(options.sourceActionId)),
          jobId: id, complete: false, durationMs: 2000, transparency: 'local-key' }
        publish()
      }
      if (prompt.includes('无效')) { progress.state = 'failed'; publish(); throw new Error('PET_SHEET_INVALID') }
      progress.state = 'complete'; progress.media!.complete = true; publish()
      return progress.media
    }
  }
} as unknown as typeof window.grok

function Preview() {
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState<PetActionDraft | null>(null)
  const [updated, setUpdated] = useState<{ id: string; draft: PetActionDraft } | null>(null)
  const [deleted, setDeleted] = useState<string[]>([])
  const [pet, setPet] = useState<PetInfo>({ id: 'test', name: '测试角色', description: '隔离测试素材，不使用真实账号。', kind: 'custom', defaultActions: { work: 'wave' }, actions: [
    { id: 'wave', name: '挥手', prompt: '协调自然地挥手', mediaType: 'sheet', file: 'action.png', atlas: a, custom: true }
  ] })
  return <>
    <div style={{ padding: 24 }}>
      <h1>动作图集隔离测试</h1>
      <button onClick={() => setOpen(true)}>重新编辑</button>
      <pre id="saved-action">{JSON.stringify({ saved, updated, deleted, actions: pet.actions, defaults: pet.defaultActions, reference: lastReference, extractionRequests, generationRequests }, null, 2)}</pre>
      <div className="pet-actor" data-media-type="sheet" style={{ width: 192, height: 256 }}>
        <SpritePet src={sheetUrl} mood="idle" atlas={a} />
      </div>
    </div>
    {open && <PetEditorModal mode="edit" pet={pet} locale="zh-CN" t={(key) => translate('zh-CN', key)}
      onClose={() => setOpen(false)} onCreate={async () => {}} onUpdate={async () => {}}
      onDelete={async () => {}} onPlayAction={async () => {}}
      onRemoveAction={async (_id, actionId) => {
        setDeleted(current => [...current, actionId])
        setPet(current => ({ ...current, actions: current.actions!.filter(action => action.id !== actionId),
          defaultActions: Object.fromEntries(Object.entries(current.defaultActions || {}).filter(([, value]) => value !== actionId)) }))
      }}
      onUpdateAction={async (_id, actionId, draft) => {
        setUpdated({ id: actionId, draft })
        if (draft.generationJobId) jobs.delete(draft.generationJobId)
        setPet(current => ({ ...current, actions: current.actions!.map(action => action.id === actionId ? {
          ...action, name: draft.name, prompt: draft.prompt, ...(draft.spritesheetPath ? { file: draft.spritesheetPath, atlas: draft.atlas } : {})
        } : action) }))
      }}
      onAddAction={async (_id, draft) => {
        setSaved(draft)
        if (draft.generationJobId) jobs.delete(draft.generationJobId)
        setPet((current) => ({ ...current, actions: [...current.actions!.filter(a => a.id !== draft.replaceActionId), {
          id: draft.replaceActionId || `test-${current.actions!.length}`, name: draft.name, prompt: draft.prompt, mediaType: 'sheet', file: 'action.png', atlas: draft.atlas, custom: true
        }] }))
      }} />}
  </>
}
createRoot(document.getElementById('root')!).render(<Preview />)
