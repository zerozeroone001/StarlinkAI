// Isolated, deterministic UI fixture: no account requests and no persisted user changes.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborationWorkspace } from '../src/renderer/src/components/CollaborationWorkspace'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { useProviders } from '../src/renderer/src/stores/providers'
import { useApp } from '../src/renderer/src/stores/app'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import type { RunSnapshot } from '../src/shared/runtime'
import image from '../resources/icon.png?url'
import wallpaper from '../resources/pets/elf.png?url'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/workspace.css'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const team = createWorkspace('conversation', 'grok', '消息与图片交互验收')
const lead = team.members[0]
team.messages = [
  { id: 'user-test', author: 'you', text: '生成图片并展示预览。', to: lead.id, time: '14:30', kind: 'message', sample: false, runId: 'fixture', status: 'completed' },
  { id: 'assistant-test', author: lead.id, text: `图片预览与交互测试。\n\n![图片测试](${image})`, to: 'all', time: '14:31', kind: 'message', sample: false, runId: 'fixture', sourceMessageId: 'user-test', status: 'completed' }
]
useProviders.setState({ checked: true })
useApp.setState({ rightOpen: false, locale: 'zh-CN' })
useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: {}, attachmentDrafts: {} })
let latest: RunSnapshot
const uploads = new Map<string, { name: string; dataUrl: string; mime: string; size: number }>()
runtimeClient.upload = async (workspaceId, input) => {
  const id = crypto.randomUUID(), path = `/fixture/${workspaceId}/${id}/${input.name}`
  const mime = /\.(png|jpe?g|webp)$/i.test(input.name) ? `image/${/\.png$/i.test(input.name) ? 'png' : /\.webp$/i.test(input.name) ? 'webp' : 'jpeg'}` : 'application/octet-stream'
  const size = atob(input.data).length
  uploads.set(path, { name: input.name, dataUrl: `data:${mime};base64,${input.data}`, mime, size })
  return { id, name: input.name, path, size, mime }
}
runtimeClient.media = async (_id, source) => {
  const upload = uploads.get(source)
  if (upload) return { path: source, kind: 'image', ext: 'png', ...upload }
  const blob = await fetch(image).then((r) => r.blob())
  const dataUrl = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob) })
  return { path: image, name: 'icon.png', kind: 'image', ext: 'png', size: blob.size, mime: 'image/png', dataUrl }
}
runtimeClient.start = async (request) => {
  latest = { id: request.id, workspaceId: team.id, status: 'completed', permissions: [], createdAt: new Date().toISOString(), contextTrimmed: false,
    replies: [{ employeeId: lead.id, provider: 'grok', model: 'fixture', status: 'completed', text: `已收到 ${request.attachments?.length || 0} 个附件。重新生成完成：${request.prompt}\n\n![图片测试](${image})` }] }
  return latest
}
runtimeClient.run = async () => latest
document.documentElement.dataset.theme = 'dark'
function Fixture() {
  const sidebar = new URLSearchParams(location.search).has('sidebar')
  const [paper, setPaper] = React.useState(true)
  const [theme, setTheme] = React.useState('dark')
  return <div className={`app-shell${paper ? ' has-wallpaper' : ''}`} style={{ display: 'grid', gridTemplateColumns: sidebar ? '280px minmax(0, 1fr)' : 'minmax(0, 1fr)', height: '100vh' }}>
    {paper && <><img className="wallpaper-layer" src={wallpaper} alt="测试壁纸" /><div className="wallpaper-dim" style={{ opacity: .65 }} /></>}
    {sidebar && <Sidebar />}
    <CollaborationWorkspace />
    <div style={{ position: 'fixed', zIndex: 10, top: 45, left: 8, display: 'flex', gap: 8 }}>
      <button className="ws-button" onClick={() => setPaper(!paper)}>切换测试壁纸</button>
      <button className="ws-button" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; setTheme(next) }}>切换测试主题</button>
      <button className="ws-button" onClick={() => useCollaboration.setState((s) => ({ teams: s.teams.map((t) => ({ ...t, messages: t.messages.map((m) => m.id === 'assistant-test' ? { ...m, status: m.status === 'running' ? 'completed' : 'running' } : m) })) }))}>切换回复动画</button>
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
