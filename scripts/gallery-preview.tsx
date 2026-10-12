// Isolated gallery fixtures: all execution, uploads and permissions are simulated locally.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Gallery } from '../src/renderer/src/components/Gallery'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { CommandPalette } from '../src/renderer/src/components/CommandPalette'
import { CollaborationWorkspace } from '../src/renderer/src/components/CollaborationWorkspace'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { useCollaboration, isActive } from '../src/renderer/src/stores/collaboration'
import { useProviders } from '../src/renderer/src/stores/providers'
import { useApp } from '../src/renderer/src/stores/app'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import type { RunSnapshot } from '../src/shared/runtime'
import type { ChatImage } from '../src/shared/types'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/workspace.css'

const params = new URLSearchParams(location.search)
useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const sampleImage = (n: number, landscape = false) => {
  const canvas = document.createElement('canvas')
  canvas.width = 480; canvas.height = landscape ? 320 : 720
  const context = canvas.getContext('2d')!
  const gradient = context.createLinearGradient(0, 0, 480, canvas.height)
  gradient.addColorStop(0, ['#607c75', '#81705f', '#586879'][n % 3]); gradient.addColorStop(1, '#192b2e')
  context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#ddd4b3'; context.globalAlpha = .65
  context.beginPath(); context.arc(160 + (n % 4) * 38, canvas.height * .3, 64, 0, Math.PI * 2); context.fill()
  context.globalAlpha = 1; context.fillStyle = '#253f3f'
  context.beginPath(); context.moveTo(0, canvas.height * .85); context.lineTo(160, canvas.height * .47)
  context.lineTo(300, canvas.height * .72); context.lineTo(390, canvas.height * .6)
  context.lineTo(480, canvas.height * .85); context.lineTo(480, canvas.height); context.lineTo(0, canvas.height); context.fill()
  context.fillStyle = '#d1d6d7'; context.font = '12px sans-serif'; context.fillText(`预览作品 ${n + 1}`, 18, canvas.height - 18)
  return canvas.toDataURL('image/png')
}
const team = createWorkspace('conversation', 'grok', '画廊验收对话')
const collection = createWorkspace('conversation', 'grok', '画廊 · 晨雾中的山间湖泊')
collection.gallery = { prompt: '晨雾中的山间湖泊', ratio: '2:3', count: 4, createdAt: '2026-10-08T02:00:00Z' }
if (!params.has('empty')) {
  collection.messages = [{ id: 'landscape-images', author: collection.members[0].id, text: '',
    images: Array.from({ length: params.has('pair') ? 2 : 4 }, (_, i) => ({ dataUrl: sampleImage(i), alt: `湖畔晨光 ${i + 1}` })),
    to: 'all', time: '10:00', kind: 'message', sample: false, status: 'completed' }]
  team.messages = [{ id: 'conversation-images', author: team.members[0].id, text: '',
    images: Array.from({ length: 4 }, (_, i) => ({ dataUrl: sampleImage(i + 4, true), alt: '不同光影下的远山' })),
    to: 'all', time: '10:00', kind: 'message', sample: false, status: 'completed' }]
}
useProviders.setState({ checked: true })
useApp.setState({ rightOpen: false, locale: 'zh-CN', paletteOpen: false })
useCollaboration.setState({ teams: params.has('empty') ? [team] : [team, collection], activeTeamId: team.id, page: 'gallery',
  runs: {}, drafts: {}, attachmentDrafts: {}, deletedGalleryKeys: [], connectionErrors: {}, runtimeError: null, storageError: false })
const snapshots = new Map<string, RunSnapshot>()
const outputs = new Map<string, ChatImage[]>()
let imageIndex = 20
runtimeClient.start = async (request) => {
  const settings = useCollaboration.getState().teams.find((team) => team.id === request.workspaceId)?.gallery
  const images = Array.from({ length: settings?.count || 1 }, () => ({ dataUrl: sampleImage(imageIndex++), alt: settings?.prompt || '创作结果' }))
  outputs.set(request.id, images)
  const status = params.has('pending') ? 'running' : 'completed'
  const run: RunSnapshot = { id: request.id, workspaceId: request.workspaceId, status, revision: 1, permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false,
    replies: [{ employeeId: request.employees[0].id, provider: request.employees[0].provider, model: 'fixture', status,
      text: status === 'completed' ? '生成完成。' : '', images: status === 'completed' ? images : [] }] }
  snapshots.set(run.id, run)
  return run
}
runtimeClient.run = async (id) => snapshots.get(id)!
runtimeClient.upload = async (workspaceId, input) => ({ id: 'fixture-upload', name: input.name, path: `/${workspaceId}/original.png`, size: 1024, mime: 'image/png' })
runtimeClient.cancel = async (id) => {
  const run = snapshots.get(id)!
  const stopped: RunSnapshot = { ...run, status: 'cancelled', revision: (run.revision || 0) + 1, permissions: [], replies: run.replies.map((reply) => ({ ...reply, status: 'cancelled' })) }
  snapshots.set(id, stopped)
  return stopped
}
runtimeClient.permission = async (id) => {
  const run = snapshots.get(id)!
  snapshots.set(id, { ...run, permissions: [], status: 'running', revision: (run.revision || 0) + 1 })
}
function advance(mode: 'partial' | 'completed' | 'failed' | 'needs_permission') {
  const run = [...snapshots.values()].filter((run) => isActive(run.status)).at(-1)
  if (!run) return
  const status = mode === 'partial' ? 'running' : mode
  const next: RunSnapshot = { ...run, status, revision: (run.revision || 0) + 1,
    permissions: mode === 'needs_permission' ? [{ id: 'fixture-permission', employeeId: run.replies[0].employeeId, title: '保存生成图片', detail: '本地验收模拟，不会写入文件。', options: [{ id: 'allow_once', label: '允许本次' }, { id: 'reject_once', label: '拒绝本次' }] }] : [],
    error: mode === 'failed' ? '模拟服务失败，请调整后重试。' : undefined,
    replies: run.replies.map((reply) => ({ ...reply, status, text: mode === 'failed' ? '模型服务暂时不可用。' : '',
      images: mode === 'completed' ? outputs.get(run.id) : mode === 'partial' ? outputs.get(run.id)?.slice(0, 1) : reply.images })) }
  snapshots.set(run.id, next); useCollaboration.getState().applyRun(next)
}
document.documentElement.dataset.theme = params.get('theme') || 'dark'
function Fixture() {
  const page = useCollaboration((s) => s.page)
  const narrow = params.has('narrow')
  const hideSidebar = narrow || params.has('full')
  return <div className="app-shell workspace-shell" style={{ gridTemplateColumns: hideSidebar ? 'minmax(0, 1fr)' : '260px minmax(0, 1fr)', height: '100vh', maxWidth: narrow ? 480 : undefined }}>
    {!hideSidebar && <Sidebar />}{page === 'gallery' ? <Gallery /> : <CollaborationWorkspace />}<CommandPalette />
    {params.has('controls') && <div aria-label="本地模拟验收" style={{ position: 'fixed', left: 8, bottom: 4, zIndex: 20, display: 'flex', gap: 12, padding: 4, fontSize: 11, background: '#222', color: '#fff' }}>
      <button onClick={() => advance('partial')}>模拟返回一张</button><button onClick={() => advance('completed')}>模拟完成</button>
      <button onClick={() => advance('failed')}>模拟失败</button><button onClick={() => advance('needs_permission')}>模拟权限确认</button>
    </div>}
  </div>
}
const root = createRoot(document.getElementById('root')!)
import.meta.hot?.dispose(() => root.unmount())
root.render(<Fixture />)
