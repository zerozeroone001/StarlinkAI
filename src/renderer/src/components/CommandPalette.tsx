import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApp } from '@/stores/app'
import { useCollaboration } from '@/stores/collaboration'
import { pathKey } from '@/lib/format'
import { useT, type MsgKey } from '@/lib/i18n'

const COMMANDS: { id: string; labelKey: MsgKey; kbd: string }[] = [
  { id: 'new', labelKey: 'cmd.new', kbd: 'Ctrl N' },
  { id: 'project', labelKey: 'cmd.project', kbd: '' },
  { id: 'skills', labelKey: 'cmd.skills', kbd: '' },
  { id: 'reloadSkills', labelKey: 'cmd.reloadSkills', kbd: '' },
  { id: 'wakePet', labelKey: 'cmd.wakePet', kbd: '' },
  { id: 'tuckPet', labelKey: 'cmd.tuckPet', kbd: '' },
  { id: 'settings', labelKey: 'cmd.settings', kbd: 'Ctrl ,' },
  { id: 'sidebar', labelKey: 'cmd.sidebar', kbd: 'Ctrl B' },
  { id: 'panel', labelKey: 'cmd.panel', kbd: 'Ctrl \\' },
  { id: 'review', labelKey: 'cmd.review', kbd: '' },
  { id: 'files', labelKey: 'cmd.files', kbd: '' },
  { id: 'terminal', labelKey: 'cmd.terminal', kbd: '' },
  { id: 'theme', labelKey: 'cmd.theme', kbd: '' },
  { id: 'language', labelKey: 'cmd.language', kbd: '' }
]

export function CommandPalette() {
  const teams = useCollaboration((s) => s.teams)
  const workspace = useCollaboration((s) => s.surface === 'workspace')
  const t = useT()
  const {
    paletteOpen,
    setPalette,
    setSettings,
    setSkillsOpen,
    loadSkills,
    wakePet,
    tuckPet,
    toggleSidebar,
    setRightOpen,
    rightOpen,
    setRightTab,
    theme,
    setTheme,
    locale,
    setLocale,
    threads,
    projects,
    openThread
  } = useApp()
  const [q, setQ] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!paletteOpen) return
    setQ('')
    setSelectedIndex(0)
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [paletteOpen])

  const items = useMemo(() => {
    const query = q.trim().toLowerCase()
    const cmds = COMMANDS.filter(c => !workspace || !['review','files','terminal'].includes(c.id)).map((c) => ({
      id: c.id,
      label: c.id === 'new' ? '新建对话' : c.id === 'project' ? '新建项目' : c.id === 'panel' && workspace ? '切换员工面板' : t(c.labelKey),
      kbd: c.kbd
    })).filter((c) => c.label.toLowerCase().includes(query))
    const roots = new Set(projects.map((p) => pathKey(p.path)))
    const th = threads
      .filter((item) => roots.has(pathKey(item.cwd)) && item.title.toLowerCase().includes(query))
      .slice(0, 8)
      .map((item) => ({ id: `t:${item.id}`, label: item.title, kbd: item.projectName }))
    const groups = teams
      .filter((team) => !team.gallery && `${team.name} ${team.goal}`.toLowerCase().includes(query))
      .map((team) => ({
        id: `team:${team.id}`,
        label: team.name,
        kbd: team.kind === 'project' ? '项目' : '对话'
      }))
    return [...groups, ...cmds, ...th]
  }, [q, threads, projects, t, locale, teams, workspace])

  const activeIndex = Math.min(selectedIndex, Math.max(0, items.length - 1))
  useEffect(() => {
    if (paletteOpen) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [paletteOpen, listId, activeIndex, q])

  if (!paletteOpen) return null

  const run = (id: string) => {
    setPalette(false)
    setQ('')
    if (id.startsWith('team:')) useCollaboration.getState().navigate('team', id.slice(5))
    if (id === 'new') useCollaboration.getState().createWorkspace('conversation')
    if (id === 'project') useCollaboration.getState().setCreatingProject(true)
    if (id === 'settings') setSettings(true)
    if (id === 'skills') setSkillsOpen(true)
    if (id === 'reloadSkills') void loadSkills()
    if (id === 'wakePet') void wakePet()
    if (id === 'tuckPet') void tuckPet()
    if (id === 'sidebar') toggleSidebar()
    if (id === 'panel') setRightOpen(!rightOpen)
    if (id === 'review') setRightTab('review')
    if (id === 'files') setRightTab('files')
    if (id === 'terminal') setRightTab('terminal')
    if (id === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark')
    if (id === 'language') setLocale(locale === 'en' ? 'zh-CN' : 'en')
    if (id.startsWith('t:')) {
      const thread = threads.find((item) => item.id === id.slice(2))
      if (thread) void openThread(thread)
    }
  }

  return (
    <dialog className="palette-dialog" ref={dialog} aria-label="搜索对话、项目或命令"
      onCancel={() => setPalette(false)} onClick={(event) => { if (event.target === event.currentTarget) setPalette(false) }}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label="搜索对话、项目或命令"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items.length ? `${listId}-${activeIndex}` : undefined}
          placeholder={t('palette.placeholder')}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSelectedIndex(0) }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
            if (e.key === 'Escape') { e.preventDefault(); setPalette(false) }
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
              e.preventDefault()
              setSelectedIndex((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
            }
            if (e.key === 'Enter' && !e.repeat && items[activeIndex]) {
              e.preventDefault()
              run(items[activeIndex].id)
            }
          }}
        />
        <div id={listId} role="listbox" aria-label="搜索结果" style={{ borderTop: '1px solid var(--border)', maxHeight: 360, overflow: 'auto' }}>
          {!items.length && <p className="ws-form-note" style={{ padding: 16 }}>没有匹配的对话、项目或命令。</p>}
          {items.map((item, index) => (
            <button
              key={item.id}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className="file-row"
              style={{ padding: '10px 16px' }}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => run(item.id)}
            >
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.kbd ? <span className="meta">{item.kbd}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </dialog>
  )
}
