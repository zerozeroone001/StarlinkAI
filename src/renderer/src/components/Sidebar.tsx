import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  MessageSquare,
  Blocks,
  Moon,
  Sun,
  Images
} from 'lucide-react'
import type { ThreadMeta } from '@shared/types'
import { useApp } from '@/stores/app'
import { visibleThreads } from '@/lib/session-runtime'
import { useT } from '@/lib/i18n'
import { GrokMark } from './GrokMark'
import { ColResize } from './ColResize'
import { initials, pathKey, relativeTime } from '@/lib/format'
import { useCollaboration } from '@/stores/collaboration'
import { WorkspaceEditor } from './WorkspaceDialogs'
import { PROVIDERS, type Team } from '@/lib/collaboration-data'
import { ProviderMark } from './ProviderMark'
import { ConversationActions } from './ConversationActions'

function RenameInput({
  value,
  onCommit,
  onCancel
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="rename-input"
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(text.trim() || value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(text.trim() || value)}
    />
  )
}

function MoreMenu({
  items
}: {
  items: { label: string; danger?: boolean; onClick: () => void }[]
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="more-wrap">
      <button
        ref={btnRef}
        type="button"
        className="icon-btn"
        title="More"
        onClick={(e) => {
          e.stopPropagation()
          const r = btnRef.current?.getBoundingClientRect()
          if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 148) })
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open
        ? createPortal(
            <>
              <div
                className="menu-backdrop"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                }}
              />
              <div
                className="menu row-menu"
                style={{ position: 'fixed', top: pos.top, left: pos.left }}
              >
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.label}
                    className={item.danger ? 'danger' : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpen(false)
                      item.onClick()
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  )
}

function ThreadRow({
  thread,
  nested,
  active,
  editing,
  confirming,
  onOpen,
  onRename,
  onAskDelete,
  onCommitRename,
  onCancelEdit,
  onConfirmDelete,
  onCancelDelete
}: {
  thread: ThreadMeta
  nested?: boolean
  active: boolean
  editing: boolean
  confirming: boolean
  onOpen: () => void
  onRename: () => void
  onAskDelete: () => void
  onCommitRename: (title: string) => void
  onCancelEdit: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const t = useT()
  const locale = useApp((s) => s.locale)
  return (
    <>
      <div
        className={'thread-item' + (active ? ' active' : '') + (thread.unread ? ' unread' : '')}
        style={nested ? { paddingLeft: 28 } : undefined}
      >
        <button
          type="button"
          className="thread-main"
          onClick={() => {
            if (!editing && !confirming) onOpen()
          }}
        >
          <span
            className={
              'status-dot' +
              (thread.status === 'running'
                ? ' running'
                : thread.status === 'needs_input'
                  ? ' needs'
                  : '')
            }
          />
          {editing ? (
            <RenameInput value={thread.title} onCommit={onCommitRename} onCancel={onCancelEdit} />
          ) : (
            <span className="title">{thread.title}</span>
          )}
        </button>
        <span className="meta">{relativeTime(thread.updatedAt, locale)}</span>
        <div className="row-actions">
          <MoreMenu
            items={[
              { label: t('action.rename'), onClick: onRename },
              { label: t('action.delete'), danger: true, onClick: onAskDelete }
            ]}
          />
        </div>
      </div>
      {confirming ? (
        <div className="confirm-row" style={nested ? { marginLeft: 18 } : undefined}>
          <span>{t('confirm.deleteThread')}</span>
          <button type="button" className="danger-btn" onClick={onConfirmDelete}>
            {t('action.delete')}
          </button>
          <button type="button" className="ghost-mini" onClick={onCancelDelete}>
            {t('action.cancel')}
          </button>
        </div>
      ) : null}
    </>
  )
}

export function Sidebar() {
  const {
    teams: allTeams,
    activeTeamId,
    surface,
    page,
    navigate,
    createWorkspace,
    creatingProject,
    setCreatingProject,
    defaultProvider
  } = useCollaboration()
  const teams = useMemo(() => allTeams.filter((team) => !team.gallery), [allTeams])
  const theme = useApp((s) => s.theme)
  const {
    projects,
    threads,
    activeThreadId,
    auth,
    newThread,
    addProject,
    openThread,
    setPalette,
    setSettings,
    setSkillsOpen,
    cwd,
    sidebarCollapsed,
    toggleSidebar,
    focusProject,
    sidebarWidth,
    setSidebarWidth,
    renameProject,
    removeProject,
    renameThread,
    deleteThread
  } = useApp()
  const t = useT()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [editing, setEditing] = useState<{ kind: 'project' | 'thread'; id: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'project' | 'thread'; id: string } | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<string, typeof threads>()
    for (const t of threads) {
      const key = pathKey(t.cwd)
      const list = map.get(key) || []
      list.push(t)
      map.set(key, list)
    }
    return projects.map((p) => ({
      project: p,
      threads: visibleThreads(map.get(pathKey(p.path)) || [], 12)
    }))
  }, [projects, threads])

  const workspaceRow = (workspace: Team) => (
    <div
      key={workspace.id}
      className={`sidebar-team${surface === 'workspace' && page === 'team' && activeTeamId === workspace.id ? ' active' : ''}`}
    >
      <button type="button" className="sidebar-team-main" onClick={() => navigate('team', workspace.id)}>
        <span className="team-list-icon">
          {workspace.kind === 'project' ? <FolderPlus size={15} /> : <MessageSquare size={15} />}
        </span>
        <span>
          <strong>{workspace.name}</strong>
          <small>
            {PROVIDERS[workspace.defaultProvider].name} · {workspace.members.length} 位员工
          </small>
        </span>
      </button>
      <ConversationActions team={workspace} />
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-head drag">
        <div
          className="brand no-drag"
          onClick={() => {
            if (sidebarCollapsed) toggleSidebar()
          }}
        >
          <GrokMark size={20} />
          <span className="brand-switch">
            {t('brand.name')}
          </span>
        </div>
      </div>
      <div className="sidebar-body">
        <button className="nav-btn" onClick={() => createWorkspace('conversation')}>
          <SquarePen size={16} />
          新建对话<kbd>Ctrl N</kbd>
        </button>
        <button className="nav-btn" onClick={() => setCreatingProject(true)}>
          <FolderPlus size={16} />
          新建项目
        </button>
        <button
          className="nav-btn"
          disabled={importing || !window.grok}
          title={window.grok ? '选择已有文件夹，在 Grok 本地会话中开发' : '请在桌面应用中导入本地项目'}
          onClick={async () => {
            setImporting(true)
            setImportError('')
            useApp.setState({ error: null })
            try {
              await addProject()
              setImportError(useApp.getState().error || '')
            } finally {
              setImporting(false)
            }
          }}
        >
          <FolderOpen size={16} />
          {importing ? '导入中…' : '导入本地项目'}
        </button>
        {importError && <p className="ws-error" role="alert">{importError}</p>}
        <button className={`nav-btn${surface === 'workspace' && page === 'gallery' ? ' selected' : ''}`} title="画廊" onClick={() => navigate('gallery')}>
          <Images size={16} />
          画廊
        </button>
        <button className="nav-btn" onClick={() => setPalette(true)}>
          <Search size={16} />
          搜索<kbd>Ctrl K</kbd>
        </button>
        <button className="nav-btn" onClick={() => setSkillsOpen(true)}>
          <Sparkles size={16} />
          {t('nav.skills')}
        </button>
        <button className="sidebar-default-model" onClick={() => setSettings(true, 'providers')}>
          <ProviderMark id={defaultProvider} small />
          <span>默认模型</span>
          <strong>{PROVIDERS[defaultProvider].name}</strong>
          <ChevronRight size={12} />
        </button>
        <div className="sidebar-teams">
          <div className="section-label">
            <span>项目</span>
            <button
              className="icon-btn"
              aria-label="新建项目"
              onClick={() => setCreatingProject(true)}
            >
              <Plus size={14} />
            </button>
          </div>
          {teams
            .filter((w) => w.kind === 'project')
            .map((workspace) => (
              <div key={workspace.id}>
                {workspaceRow(workspace)}
                {teams
                  .filter((w) => w.parentId === workspace.id)
                  .map((child) => (
                    <div className="sidebar-project-child" key={child.id}>
                      {workspaceRow(child)}
                    </div>
                  ))}
              </div>
            ))}
          {!teams.some((w) => w.kind === 'project') && (
            <p className="sidebar-empty-note">用项目组织长期目标与多段对话。</p>
          )}
        </div>
        <div className="sidebar-teams">
          <div className="section-label">
            <span>对话</span>
            <button
              className="icon-btn"
              aria-label="新建独立对话"
              onClick={() => createWorkspace('conversation')}
            >
              <Plus size={14} />
            </button>
          </div>
          {teams
            .filter((w) => w.kind === 'conversation' && !w.parentId)
            .slice()
            .reverse()
            .map((workspace) => workspaceRow(workspace))}
        </div>
        <div className="thread-list scroll">
          {grouped.length > 0 && (
            <div className="section-label">
              <span>Grok 本地历史</span>
            </div>
          )}
          {grouped.map(({ project, threads: list }) => {
            const expanded = open[project.path] ?? project.path === cwd
            const editingThis = editing?.kind === 'project' && editing.id === project.path
            const confirmThis = confirm?.kind === 'project' && confirm.id === project.path
            return (
              <div key={project.path}>
                <div className="project-row">
                  <button
                    type="button"
                    className="project-head"
                    style={{ flex: 1, minWidth: 0 }}
                    onClick={() => {
                      if (editingThis || confirmThis) return
                      setOpen((s) => ({
                        ...s,
                        [project.path]: !(open[project.path] ?? project.path === cwd)
                      }))
                      void focusProject(project.path)
                    }}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {editingThis ? (
                      <RenameInput
                        value={project.name}
                        onCancel={() => setEditing(null)}
                        onCommit={(name) => {
                          setEditing(null)
                          if (name !== project.name) void renameProject(project.path, name)
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {project.name}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('nav.newThread')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void newThread(project.path)
                    }}
                  >
                    <Plus size={13} />
                  </button>
                  <div className="row-actions">
                    <MoreMenu
                      items={[
                        {
                          label: t('action.rename'),
                          onClick: () => setEditing({ kind: 'project', id: project.path })
                        },
                        {
                          label: t('action.delete'),
                          danger: true,
                          onClick: () => setConfirm({ kind: 'project', id: project.path })
                        }
                      ]}
                    />
                  </div>
                </div>
                {confirmThis ? (
                  <div className="confirm-row">
                    <span>{t('confirm.removeProject')}</span>
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={() => {
                        setConfirm(null)
                        void removeProject(project.path)
                      }}
                    >
                      {t('action.delete')}
                    </button>
                    <button type="button" className="ghost-mini" onClick={() => setConfirm(null)}>
                      {t('action.cancel')}
                    </button>
                  </div>
                ) : null}
                {expanded
                  ? list.map((t) => (
                      <ThreadRow
                        key={t.id}
                        thread={t}
                        nested
                        active={surface === 'legacy' && t.id === activeThreadId}
                        editing={editing?.kind === 'thread' && editing.id === t.id}
                        confirming={confirm?.kind === 'thread' && confirm.id === t.id}
                        onOpen={() => void openThread(t)}
                        onRename={() => setEditing({ kind: 'thread', id: t.id })}
                        onAskDelete={() => setConfirm({ kind: 'thread', id: t.id })}
                        onCommitRename={(title) => {
                          setEditing(null)
                          if (title !== t.title) void renameThread(t, title)
                        }}
                        onCancelEdit={() => setEditing(null)}
                        onConfirmDelete={() => {
                          setConfirm(null)
                          void deleteThread(t)
                        }}
                        onCancelDelete={() => setConfirm(null)}
                      />
                    ))
                  : null}
              </div>
            )
          })}
        </div>
      </div>
      <button className="sidebar-providers" onClick={() => setSettings(true, 'providers')}>
        <span>
          <Blocks size={14} />
          模型与账号
        </span>
        <span className="sidebar-provider-marks">
          {(['claude', 'codex', 'grok', 'gemini'] as const).map((id) => (
            <ProviderMark id={id} small key={id} />
          ))}
        </span>
      </button>
      <div className="sidebar-foot">
        <div className="avatar">{initials(auth.name, auth.email)}</div>
        <div className="user-block">
          <div className="name">{auth.name || '本地工作空间'}</div>
          <div className="mail">{auth.signedIn ? 'Grok 本地已登录' : '订阅优先 · 本机保存'}</div>
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} title={t('nav.settings')}>
          <Settings size={16} />
        </button>
        <button
          className="icon-btn sidebar-theme"
          title="切换明暗主题"
          onClick={() => useApp.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      {creatingProject && <WorkspaceEditor close={() => setCreatingProject(false)} />}
      <ColResize disabled={sidebarCollapsed} value={sidebarWidth} onChange={setSidebarWidth} />
    </aside>
  )
}
