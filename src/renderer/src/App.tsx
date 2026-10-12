import { useEffect, type CSSProperties } from 'react'
import type { PermissionRequest, PetSnapshot, ThreadMeta } from '@shared/types'
import { CommandPalette } from './components/CommandPalette'
import { RightPane } from './components/RightPane'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { derivePetStatus } from './lib/pet-status'
import { useApp } from './stores/app'
import { useCollaboration } from './stores/collaboration'
import { CollaborationWorkspace } from './components/CollaborationWorkspace'
import { Gallery } from './components/Gallery'
import { workspaceStorageStatus } from './lib/workspace-storage-status'

export function App() {
  const workspace = useCollaboration((s) => s.surface === 'workspace')
  const workspacePage = useCollaboration((s) => s.page)
  const {
    hydrate,
    startupError,
    desktopStateHealth,
    rightOpen,
    sidebarCollapsed,
    sidebarWidth,
    rightWidth,
    setPalette,
    setSettings,
    setSkillsOpen,
    toggleSidebar,
    setRightOpen,
    wallpaperDataUrl,
    wallpaperOpacity
  } = useApp()

  useEffect(() => {
    void hydrate()
    if (typeof window.grok === 'undefined') return
    const offUpdate = window.grok.on('grok:update', (payload) => {
      useApp.getState().applyUpdate(payload as Record<string, unknown>)
    })
    const offPerm = window.grok.on('grok:permission', (payload) => {
      useApp.getState().applyPermission(payload as PermissionRequest)
    })
    const offConn = window.grok.on('grok:connected', () => useApp.setState({ connected: true }))
    const offDisc = window.grok.on('grok:disconnected', () =>
      useApp.getState().onAgentDisconnected()
    )
    const offPet = window.grok.on('pets:prefs', (payload) => {
      const pet = payload as { awake: boolean; petId: string; pets?: PetSnapshot['pets'] }
      useApp.getState().applyPetPrefs(pet)
    })
    const offOpen = window.grok.on('grok:open-thread', (payload) => {
      const id = String(payload || '')
      const thread = useApp.getState().threads.find((t: ThreadMeta) => t.id === id)
      if (thread) void useApp.getState().openThread(thread)
    })
    return () => {
      offUpdate()
      offPerm()
      offConn()
      offDisc()
      offPet()
      offOpen()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (workspaceStorageStatus.getSnapshot().closing) { e.preventDefault(); return }
      if (document.querySelector('dialog[open]')) return
      const meta = e.ctrlKey || e.metaKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(true)
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        useCollaboration.getState().createWorkspace('conversation')
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        setSettings(true)
      }
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if (meta && e.key === '\\') {
        e.preventDefault()
        setRightOpen(!useApp.getState().rightOpen)
      }
      if (e.key === 'Escape') {
        setPalette(false)
        setSettings(false)
        setSkillsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const threads = useApp((s) => s.threads)
  const git = useApp((s) => s.git)
  const permission = useApp((s) => s.permission)
  const activeThreadId = useApp((s) => s.activeThreadId)
  const ready = useApp((s) => s.ready)

  useEffect(() => {
    if (!ready || typeof window.grok?.pets?.report !== 'function') return
    void window.grok.pets.report(
      derivePetStatus({
        threads,
        activeThreadId,
        git,
        permission
      })
    )
  }, [ready, threads, git, permission, activeThreadId])

  const hasWallpaper = Boolean(wallpaperDataUrl)
  const cls = [
    'app-shell',
    workspace ? 'workspace-shell' : '',
    rightOpen && (!workspace || workspacePage === 'team') ? 'right-open' : '',
    sidebarCollapsed ? 'sidebar-collapsed' : '',
    hasWallpaper ? 'has-wallpaper' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const dim = 0.92 - (wallpaperOpacity / 100) * 0.67

  return (
    <div
      className={cls}
      style={
        {
          '--sidebar': `${sidebarCollapsed ? 48 : sidebarWidth}px`,
          '--right': `${rightWidth}px`
        } as CSSProperties
      }
    >
      {wallpaperDataUrl ? (
        <>
          <img className="wallpaper-layer" src={wallpaperDataUrl} alt="" />
          <div className="wallpaper-dim" style={{ opacity: dim }} />
        </>
      ) : null}
      <Sidebar />
      {startupError && <div className="startup-error" role="alert"><span>本机配置读取失败：{startupError}</span>
        <button className="ws-button" onClick={() => void hydrate()}>重试初始化</button></div>}
      {!startupError && desktopStateHealth?.message && <div className="startup-error" role="alert">
        <span>{desktopStateHealth.message}</span>
        <button className="ws-button" onClick={() => {
          void window.grok.openPath(desktopStateHealth.path.replace(/[\\/][^\\/]+$/, '')).catch(() => {})
        }}>打开配置目录</button>
        <button className="ws-button" onClick={() => window.location.reload()}>重新载入</button>
        {desktopStateHealth.status !== 'damaged' && <button className="ws-button" onClick={() => useApp.setState({ desktopStateHealth: null })}>知道了</button>}
      </div>}
      {workspace ? (workspacePage === 'gallery' ? <Gallery /> : <CollaborationWorkspace />) : <ThreadView />}
      {!workspace && rightOpen ? <RightPane /> : null}
      <CommandPalette />
      <SettingsModal />
    </div>
  )
}
