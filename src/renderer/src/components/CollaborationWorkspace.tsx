import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  CircleDot,
  FileText,
  FolderOpen,
  ListTodo,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Users,
  Upload,
  Pencil,
  Trash2,
  RotateCcw,
  Copy,
  Check,
  Paperclip,
  Square,
  UserRound,
  Bell,
  ShieldCheck
} from 'lucide-react'
import {
  PROVIDERS,
  TASK_STATES,
  teamDirectory,
  type Member,
  type TeamArtifact,
  type TeamTask
} from '@/lib/collaboration-data'
import { useCollaboration, isActive, resumeRuns, reconnectRun, currentWorkspaceGeneration } from '@/stores/collaboration'
import { useProviders } from '@/stores/providers'
import { useAssistant } from '@/stores/assistant'
import { assistantScopeId } from '@/lib/assistant-context'
import { AssistantPanel } from './AssistantPanel'
import { RunMetricsPanel } from './RunMetricsPanel'
import './assistant-workspace.css'
import './workspace-availability.css'
import { EFFORT_LABELS } from '@shared/runtime'
import type { PermissionMode } from '@shared/types'
import { useT } from '@/lib/i18n'
import { StreamingMarkdown } from './StreamingMarkdown'
import { ConversationActions } from './ConversationActions'
import { useApp } from '@/stores/app'
import { AgentAvatar } from './AgentAvatar'
import { AttachmentList } from './AttachmentList'
import { ExecutionDetails } from './ExecutionDetails'
import { conversationFeed, conversationSearchText } from '@/lib/conversation-feed'
import { runtimeClient } from '@/lib/runtime-client'
import { handleComposerEnter } from '@/lib/composer-keyboard'
import { readFileDataUrl } from '@/lib/uploads'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '@shared/attachments'
import { getProviderReadiness, inspectionForProvider } from '@/lib/provider-account'
import { providerErrorSummary } from '@/lib/provider-error-summary'
import { ArtifactPreview, EmployeeEditor, TaskEditor, WorkspaceEditor } from './WorkspaceDialogs'
import { WorkspaceExportButton } from './WorkspaceDataSettings'
import { ProviderConnectionDialog } from './ProviderConnectionDialog'
import { isRestoredRunId } from '@/lib/workspace-backup'

type Tab = 'activity' | 'tasks' | 'artifacts' | 'employees'
const emptyFilters = () => ({
  activity: { filter: 'all', query: '' },
  tasks: { filter: 'all', query: '' },
  artifacts: { filter: 'all', query: '' },
  employees: { filter: 'all', query: '' }
})

export function CollaborationWorkspace() {
  const {
    teams,
    activeTeamId,
    drafts,
    attachmentDrafts,
    navigate,
    setDraft,
    setPermissionMode,
    send: sendMessage,
    runs,
    stop,
    stoppingRuns,
    answerPermission,
    runtimeError,
    connectionErrors,
    storageError,
    retryStorage,
    taskSchedules,
    startTaskSchedule,
    pauseTaskSchedule,
    createWorkspace
  } = useCollaboration()
  const t = useT()
  const rightOpen = useApp((s) => s.rightOpen)
  const setRightOpen = useApp((s) => s.setRightOpen)
  const setSettings = useApp((s) => s.setSettings)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const diagnostics = useProviders((s) => s.diagnostics)
  const providersChecked = useProviders((s) => s.checked)
  const providersChecking = useProviders((s) => s.checking)
  const providersError = useProviders((s) => s.error)
  const providerChecks = useProviders((s) => s.providerChecks)
  const readiness = (m: Member) => getProviderReadiness(diagnostics.find((p) => p.id === m.provider), inspectionForProvider({
    checked: providersChecked, checking: providersChecking, error: providersError, providerChecks
  }, m.provider))
  useEffect(() => {
    resumeRuns()
    if (!useProviders.getState().checked) void useProviders.getState().inspect()
  }, [])
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1050px)')
    const compact = window.matchMedia('(max-width: 640px)')
    const collapse = () => {
      if (narrow.matches) setRightOpen(false)
      if (compact.matches && !useApp.getState().sidebarCollapsed) useApp.getState().toggleSidebar()
    }
    collapse()
    narrow.addEventListener('change', collapse)
    compact.addEventListener('change', collapse)
    return () => { narrow.removeEventListener('change', collapse); compact.removeEventListener('change', collapse) }
  }, [setRightOpen])
  const team = teams.find((t) => t.id === activeTeamId) || teams[0]
  const scopeId = assistantScopeId(team)
  const assistant = useAssistant((state) => state.snapshots[scopeId])
  const assistantError = useAssistant((state) => state.errors[scopeId])
  const rawLead = team.members.find((m) => m.isLead)!
  const lead = assistant && assistant.profile.updatedAt !== new Date(0).toISOString()
    ? { ...rawLead, name: assistant.profile.name, persona: assistant.profile.persona } : rawLead
  const workRun = Object.values(runs).find((r) => r.workspaceId === team.id && r.interaction !== 'conversation' && isActive(r.status))
  const conversationRun = Object.values(runs).find((r) => r.workspaceId === team.id && r.interaction === 'conversation' && isActive(r.status))
  const activeRun = workRun || conversationRun
  const activeConnectionError = activeRun && connectionErrors[activeRun.id]
  const measuredRun = activeRun || Object.values(runs)
    .filter((run) => run.workspaceId === team.id && run.metrics)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [connectingTeam, setConnectingTeam] = useState<string | null>(null)
  const [connectionNotice, setConnectionNotice] = useState<{ teamId: string; message: string } | null>(null)
  const [assistantTab, setAssistantTab] = useState<'profile' | 'commitments'>('profile')
  const [chatOnly, setChatOnly] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setAssistantOpen(false)
    setChatOnly(false)
    void useAssistant.getState().refresh(scopeId)
    const refresh = () => { setNow(Date.now()); void useAssistant.getState().refresh(scopeId) }
    const timer = setInterval(refresh, 30000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [scopeId])
  const dueReminders = assistant?.commitments.filter((item) => item.status === 'open' && item.dueAt && Date.parse(item.dueAt) <= now) || []
  const statusLabel = (status?: string) =>
    ({
      queued: '等待执行',
      running: '回复中',
      needs_permission: '等待确认',
      completed: '已完成',
      failed: '执行失败',
      cancelled: '已停止'
    })[status || ''] || '本地记录'
  const parent = teams.find((t) => t.id === team.parentId)
  const directory = teamDirectory(teams, team.id)
  const schedule = taskSchedules[team.id]
  const children = teams.filter((t) => t.parentId === team.id)
  const [tab, setTab] = useState<Tab>('activity')
  const [filters, setFilters] = useState(emptyFilters)
  const { filter, query } = filters[tab]
  const setFilter = (filter: string) => setFilters((s) => ({ ...s, [tab]: { ...s[tab], filter } }))
  const setQuery = (query: string) => setFilters((s) => ({ ...s, [tab]: { ...s[tab], query } }))
  const [recipient, setRecipient] = useState(lead.id)
  const conversationOnly = recipient === lead.id && (chatOnly || !!workRun)
  const permissionMode = team.permissionMode ?? 'ask'
  const permissionDescription = conversationOnly ? t('composer.chatPermissions')
    : permissionMode === 'review' ? t('composer.reviewDesc')
    : permissionMode === 'auto' ? t('composer.fullDesc') : t('composer.askDesc')
  const [editing, setEditing] = useState(false)
  const [employeeEditor, setEmployeeEditor] = useState<Member | 'new' | null>(null)
  const [taskEditor, setTaskEditor] = useState<TeamTask | 'new' | null>(null)
  const [artifact, setArtifact] = useState<TeamArtifact | null>(null)
  const [fileError, setFileError] = useState('')
  const [editingMessage, setEditingMessage] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const attachmentRef = useRef<HTMLInputElement>(null)
  const uploadLocks = useRef(new Set<string>())
  const [uploadingTeams, setUploadingTeams] = useState<string[]>([])
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({})
  const uploading = uploadingTeams.includes(team.id)
  const attachments = attachmentDrafts[team.id] || []
  const uploadFiles = async (files: File[]) => {
    const generation = currentWorkspaceGeneration()
    const targetId = team.id
    if (!files.length || uploadLocks.current.has(targetId)) return
    uploadLocks.current.add(targetId)
    setUploadingTeams((ids) => [...ids, targetId])
    setUploadErrors((errors) => ({ ...errors, [targetId]: '' }))
    const errors: string[] = []
    try {
      for (const file of files) {
        if (generation !== currentWorkspaceGeneration()) return
        if ((useCollaboration.getState().attachmentDrafts[targetId] || []).length >= MAX_ATTACHMENTS) {
          errors.push('每条消息最多 5 个附件。'); break
        }
        try {
          if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('单个文件最多 8 MB。')
          const dataUrl = await readFileDataUrl(file)
          if (generation !== currentWorkspaceGeneration()) return
          const target = useCollaboration.getState().teams.find(item => item.id === targetId)
          if (!target) return
          const attachment = await runtimeClient.upload(target.parentId || targetId, { name: file.name, data: dataUrl.slice(dataUrl.indexOf(',') + 1) })
          if (generation !== currentWorkspaceGeneration()) return
          useCollaboration.getState().addAttachments(targetId, [attachment])
        } catch (e) { errors.push(`${file.name}：${e instanceof Error ? e.message : '上传失败，请重试。'}`) }
      }
    } finally {
      uploadLocks.current.delete(targetId)
      setUploadingTeams((ids) => ids.filter((id) => id !== targetId))
      if (generation === currentWorkspaceGeneration()) setUploadErrors((old) => ({ ...old, [targetId]: errors.join('\n') }))
    }
  }
  const feedRef = useRef<HTMLDivElement>(null)
  const feedBodyRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const previousHistoryKey = useRef('')
  const prependPosition = useRef<{ height: number; top: number } | null>(null)
  const [historyStart, setHistoryStart] = useState<{ key: string; id: string } | null>(null)
  const [showLatest, setShowLatest] = useState(false)
  useEffect(() => {
    setFilters(emptyFilters())
    setRecipient(lead.id)
    setTab('activity')
    setTaskEditor(null)
    setEmployeeEditor(null)
    setEditing(false)
    setArtifact(null)
    setFileError('')
    setEditingMessage(null)
    setActionError('')
  }, [team.id])
  useEffect(() => {
    if (recipient !== 'all' && !team.members.some((m) => m.id === recipient)) setRecipient(lead.id)
    setFilters((current) => {
      const next = { ...current }
      let changed = false
      for (const key of Object.keys(current) as Tab[]) {
        if (current[key].filter !== 'all' && !team.members.some((m) => m.id === current[key].filter)) {
          next[key] = { ...current[key], filter: 'all' }
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [team.members, recipient, lead.id])
  const member = (id: string) => id === lead.id ? lead : team.members.find((m) => m.id === id)
  const name = (id: string) =>
    id === 'you' ? '你' : id === 'system' ? '系统' : member(id)?.name || '员工'
  const provider = (id: string) => member(id)?.provider || team.defaultProvider
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase())
  const feed = useMemo(() => conversationFeed(team.messages), [team.messages])
  const filteredMessages = useMemo(() => feed.filter(
    (m) =>
      (filters.activity.filter === 'all' ||
        m.author === filters.activity.filter ||
        m.to === filters.activity.filter ||
        m.to === 'all') &&
      conversationSearchText(m).includes(filters.activity.query.toLowerCase())
  ), [feed, filters.activity.filter, filters.activity.query])
  const historyKey = JSON.stringify([team.id, filters.activity.filter, filters.activity.query])
  const savedStart = historyStart?.key === historyKey ? filteredMessages.findIndex((message) => message.id === historyStart.id) : -1
  const startIndex = savedStart >= 0 ? savedStart : Math.max(0, filteredMessages.length - 60)
  const visibleMessages = filteredMessages.slice(startIndex)
  const scrollToLatest = () => {
    pinnedToBottom.current = true
    setShowLatest(false)
    setHistoryStart(null)
    const element = feedRef.current
    if (element) element.scrollTop = element.scrollHeight
  }
  const trackScroll = () => {
    const element = feedRef.current
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64
    pinnedToBottom.current = atBottom
    setShowLatest(!atBottom)
    // Freeze the first rendered message while reading older output, so incoming
    // replies cannot evict it when the recent-message window advances.
    if (!atBottom && historyStart?.key !== historyKey && visibleMessages[0])
      setHistoryStart({ key: historyKey, id: visibleMessages[0].id })
  }
  const loadEarlier = () => {
    const element = feedRef.current
    if (!element || !startIndex) return
    prependPosition.current = { height: element.scrollHeight, top: element.scrollTop }
    pinnedToBottom.current = false
    setHistoryStart({ key: historyKey, id: filteredMessages[Math.max(0, startIndex - 60)].id })
  }
  useLayoutEffect(() => {
    const element = feedRef.current
    if (!element) return
    if (previousHistoryKey.current !== historyKey) {
      previousHistoryKey.current = historyKey
      prependPosition.current = null
      pinnedToBottom.current = true
      setShowLatest(false)
      element.scrollTop = element.scrollHeight
    } else if (prependPosition.current) {
      const previous = prependPosition.current
      prependPosition.current = null
      element.scrollTop = previous.top + element.scrollHeight - previous.height
    } else if (pinnedToBottom.current) element.scrollTop = element.scrollHeight
  }, [historyKey, filteredMessages, startIndex])
  useEffect(() => {
    // Streaming Markdown and late-loading images can grow without appending a
    // message. Follow their height only while the user is already at the bottom.
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
    })
    if (feedBodyRef.current) observer.observe(feedBodyRef.current)
    return () => observer.disconnect()
  }, [])
  const filteredTasks = team.tasks.filter(
    (t) => (filter === 'all' || t.owner === filter) && matches(`${t.title} ${t.description}`)
  )
  const filteredArtifacts = team.artifacts.filter(
    (a) => (filter === 'all' || a.owner === filter) && matches(`${a.name} ${a.description}`)
  )
  const done = team.tasks.filter((t) => t.state === 'done').length
  const recipients = recipient === 'all' ? team.members : team.members.filter((m) => m.id === recipient)
  const unavailableRecipients = recipients.filter((m) => !readiness(m).canRun)
  const canSend = recipients.length > 0 && unavailableRecipients.length === 0
  const recipientIssue = unavailableRecipients[0] && readiness(unavailableRecipients[0])
  const recipientFailure = recipientIssue?.state === 'error' ? providerErrorSummary(inspectionForProvider({
    error: providersError, providerChecks
  }, unavailableRecipients[0].provider).error) : null
  const retryProviders = [...new Set(unavailableRecipients.filter((m) => ['unknown', 'error'].includes(readiness(m).state)).map((m) => m.provider))]
  const unavailableProviders = [...new Set(unavailableRecipients.map((m) => PROVIDERS[m.provider].name))].join('、')
  const leadReadiness = readiness(lead)
  const needsConnection = !leadReadiness.canRun && !team.messages.length
  const hasReadyProvider = diagnostics.some((provider) => getProviderReadiness(provider, {
    checked: providersChecked, checking: providersChecking, error: providersError, providerChecks
  }).canRun)
  const stillInspecting = !providersChecked || providersChecking
  const importFile = async (file?: File) => {
    if (!file) return
    setFileError('')
    const ext = file.name.split('.').at(-1)?.toLowerCase()
    if (!ext || !['md', 'txt', 'json', 'csv'].includes(ext)) {
      setFileError('请选择 Markdown、TXT、JSON 或 CSV 文件。')
      return
    }
    if (file.size > 256 * 1024) {
      setFileError('文件超过 256 KB，请使用较小的文本文件。')
      return
    }
    const targetId = team.id
    try {
      const content = await file.text()
      useCollaboration.getState().addArtifact(targetId, {
        name: file.name,
        description: '手动导入的共享文件',
        owner: 'you',
        version: 1,
        format: ext as TeamArtifact['format'],
        sample: false,
        content
      })
    } catch {
      setFileError('无法读取文件，请重试。')
    }
  }
  const send = () => {
    if (canSend && !uploadLocks.current.has(team.id) && !conversationRun && (!workRun || recipient === lead.id))
      void sendMessage(team.id, recipient, undefined, undefined, undefined,
        recipient === lead.id && (chatOnly || !!workRun) ? 'conversation' : undefined)
  }
  return (
    <>
      <main className="collab-main">
        <div className="workspace-titlebar drag">
          <div>
            <button className="icon-btn no-drag workspace-nav-toggle" title={sidebarCollapsed ? '展开项目导航' : '收起项目导航'}
              aria-label={sidebarCollapsed ? '展开项目导航' : '收起项目导航'} aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}>
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <FolderOpen size={13} />
            <span>工作空间</span>
            <ChevronRight size={12} />
            {parent && (
              <>
                <button className="text-button no-drag" onClick={() => navigate('team', parent.id)}>
                  {parent.name}
                </button>
                <ChevronRight size={12} />
              </>
            )}
            <strong>{team.name}</strong>
            <ConversationActions key={team.id} team={team} />
          </div>
          <div className="assistant-title-actions no-drag">
          <button className="icon-btn" aria-label="主 agent 档案与记忆" title="主 agent 档案与记忆" onClick={() => { setAssistantTab('profile'); setAssistantOpen(true) }}>
            <UserRound size={17} />
          </button>
          <button
            className="icon-btn no-drag"
            onClick={() => setRightOpen(!rightOpen)}
            aria-label={rightOpen ? '收起对话侧栏' : '展开对话侧栏'}
            aria-expanded={rightOpen}
            aria-controls="workspace-sidebar"
          >
            {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          </div>
        </div>
        {assistantError && <p className="ws-notice danger" role="alert">主 agent 资料读取失败：{assistantError}
          <button className="text-button" onClick={() => void useAssistant.getState().refresh(scopeId)}>重试</button></p>}
        {connectionNotice?.teamId === team.id && <p className="ws-notice" role="status">{connectionNotice.message}
          <button className="text-button" onClick={() => createWorkspace('conversation')}>新建对话</button>
          <button className="text-button" onClick={() => setConnectionNotice(null)}>知道了</button></p>}
        {dueReminders.length > 0 && <div className="assistant-due-banner" role="status">
          <Bell size={15} /><span>{dueReminders[0].title}{dueReminders.length > 1 ? ` · 另有 ${dueReminders.length - 1} 项到期提醒` : ''}</span>
          <button className="text-button" onClick={() => { setAssistantTab('commitments'); setAssistantOpen(true) }}>查看提醒</button>
        </div>}
        {storageError && (
          <p className="ws-notice danger" role="alert">
            本机存储写入失败，最新更改尚未保存。请重试保存，或先导出备份。
            <button type="button" className="text-button" onClick={retryStorage}>重试保存</button>
            <WorkspaceExportButton className="text-button" />
          </p>
        )}
        {runtimeError && (
          <p className="ws-notice danger" role="alert">
            {runtimeError}
          </p>
        )}
        {activeRun && activeConnectionError && (
          <p className="ws-notice danger" role="alert">
            {activeConnectionError}
            <button className="ws-button" onClick={() => reconnectRun(activeRun.id)}>立即重连</button>
          </p>
        )}
        {activeRun && (
          <div className="runtime-status" role="status" aria-label="执行状态">
            {activeConnectionError ? <CircleDot size={12} color="var(--ws-peach, #c89476)" aria-hidden="true" /> : <span className="runtime-pulse" />}
            <span>
              {activeConnectionError ? '连接中断 · 执行状态待确认' : activeRun.interaction !== 'conversation' && activeRun.coordination
                ? `${statusLabel(activeRun.status)} · ${{ planning: '主 agent 正在调度', executing: '员工正在执行', reviewing: '主 agent 正在检查', completed: '已交付', blocked: '调度受阻' }[activeRun.coordination.phase]} · ${activeRun.coordination.tasks.filter((task) => task.status === 'completed').length}/${activeRun.coordination.tasks.length} 项任务检查通过`
                : `${statusLabel(activeRun.status)} · ${activeRun.replies.filter((r) => r.status === 'completed').length} 位员工已完成`}
              {!activeConnectionError && activeRun.queuePosition ? ` · 排队位置 ${activeRun.queuePosition}` : ''}
            </span>
            <button className="ws-button" disabled={stoppingRuns[activeRun.id]} onClick={() => void stop(activeRun.id)}>
              {stoppingRuns[activeRun.id] ? '正在停止…' : '停止生成'}
            </button>
          </div>
        )}
        {measuredRun && <RunMetricsPanel run={measuredRun} />}
        <>
          <div className="activity-feed" ref={feedRef} onScroll={trackScroll}>
            <div ref={feedBodyRef}>
            {startIndex > 0 && <div className="conversation-history-controls">
              <button type="button" className="ws-button" onClick={loadEarlier}>加载更早的消息（还有 {startIndex} 条）</button>
            </div>}
            {filteredMessages.some((msg) => msg.sample) && <div className="sample-history-notice" role="note">
              <CircleDot size={14} /><span>历史示例内容，非真实模型执行记录。</span>
            </div>}
            {filteredMessages.length ? (
              visibleMessages.map((msg) => msg.activityOnly ? (
                <div className="tool-activity-group" key={msg.id}>
                  <ExecutionDetails tools={msg.toolMessages} runs={runs} onAnswer={answerPermission} />
                </div>
              ) : (
                <article className={`team-message ${msg.author === 'you' ? 'is-user' : 'is-assistant'}`} key={msg.id}>
                  {msg.author === 'you' || msg.author === 'system' ? (
                    <span className="provider-mark human">
                      {msg.author === 'you' ? '你' : '系'}
                    </span>
                  ) : (
                    <button type="button" className="agent-avatar-button" aria-label={`设置${name(msg.author)}头像与资料`} onClick={() => {
                      const employee = member(msg.author)
                      if (employee) setEmployeeEditor(employee)
                    }}>
                      <AgentAvatar member={member(msg.author)} provider={msg.provider || provider(msg.author)} active={msg.status === 'running'} />
                    </button>
                  )}
                  <div className="message-content">
                    <div className="message-bubble">
                    {msg.author !== 'you' && (
                    <div className="message-heading">
                      <strong>{msg.authorName || name(msg.author)}</strong>
                      {msg.sample && <span className="ws-badge sample-message-badge">示例回复</span>}
                      {(msg.provider || member(msg.author)) && (
                        <span>
                          {PROVIDERS[msg.provider || provider(msg.author)].name}{msg.model ? ` · ${msg.model}` : ''}
                          {msg.effort ? ` · ${EFFORT_LABELS[msg.effort] || msg.effort}` : ''}
                        </span>
                      )}
                    </div>
                    )}
                    {editingMessage === msg.id ? (
                      <div className="message-editor">
                        <textarea aria-label="编辑消息内容" value={editText} maxLength={8000} autoFocus
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingMessage(null)
                            handleComposerEnter(e, setEditText, () => {
                              if (activeRun || !editText.trim()) return
                              void useCollaboration.getState().editMessage(team.id, msg.id, editText)
                              setEditingMessage(null)
                            })
                          }} />
                        <div>
                          <button className="ws-button" disabled={!!activeRun || !editText.trim()} onClick={() => {
                            void useCollaboration.getState().editMessage(team.id, msg.id, editText)
                            setEditingMessage(null)
                          }}>保存并重新生成</button>
                          <button className="text-button" onClick={() => setEditingMessage(null)}>取消</button>
                        </div>
                      </div>
                    ) : msg.author === 'you' ? <p>{msg.text}</p> : (
                      <div className="workspace-markdown">
                        <StreamingMarkdown text={msg.text} streaming={msg.status === 'running'}
                          images={msg.images} cwd={msg.cwd} sessionId={msg.sessionId} workspaceId={team.id} />
                      </div>
                    )}
                    {msg.attachments?.length ? <AttachmentList files={msg.attachments} workspaceId={team.id} /> : null}
                    <ExecutionDetails tools={msg.toolMessages} receipt={msg.receipt} runs={runs} onAnswer={answerPermission} />
                    {msg.error && (
                      <p className="ws-error" role="alert">
                        {msg.error}
                      </p>
                    )}
                    </div>
                    <div className="message-footer">
                    <time>{msg.time}</time>
                    {msg.author !== 'system' && editingMessage !== msg.id && (
                      <div className="message-actions" aria-label={msg.author === 'you' ? '用户消息操作' : '回复操作'}>
                        {msg.author !== 'you' && msg.kind !== 'decision' && (
                          <button className="icon-btn" title="重新生成" aria-label="重新生成回复" disabled={!!activeRun}
                            onClick={() => void useCollaboration.getState().retryMessage(team.id, msg.id)}><RotateCcw size={14} /></button>
                        )}
                        <button className="icon-btn" title={copiedMessage === msg.id ? '已复制' : '复制'} aria-label={msg.author === 'you' ? '复制消息' : '复制回复'}
                          disabled={!msg.text && !msg.images?.length} onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(msg.text + (msg.images?.length ? '\n' + msg.images.map((image) => `![${image.alt || '图片'}](<${image.path || image.dataUrl}>)`).join('\n') : ''))
                              setCopiedMessage(msg.id); setActionError('')
                              setTimeout(() => setCopiedMessage((id) => id === msg.id ? null : id), 2000)
                            } catch { setActionError('复制失败，请重试。') }
                          }}>{copiedMessage === msg.id ? <Check size={14} /> : <Copy size={14} />}</button>
                        {msg.author === 'you' ? (
                          <>
                            <button className="icon-btn" title="编辑" aria-label="编辑消息" disabled={!!activeRun} onClick={() => {
                              setEditingMessage(msg.id); setEditText(msg.text)
                            }}><Pencil size={14} /></button>
                            <button className="icon-btn" title="删除" aria-label="删除消息" disabled={!!activeRun}
                              onClick={() => useCollaboration.getState().deleteMessage(team.id, msg.id)}><Trash2 size={14} /></button>
                            <button className="icon-btn" title="重新发送" aria-label="重新发送消息" disabled={!!activeRun}
                              onClick={() => void useCollaboration.getState().retryMessage(team.id, msg.id)}><ArrowUp size={14} /></button>
                          </>
                        ) : (
                          <button className="icon-btn" title="删除" aria-label="删除回复" disabled={!!activeRun}
                            onClick={() => useCollaboration.getState().deleteMessage(team.id, msg.id)}><Trash2 size={14} /></button>
                        )}
                        {msg.status && ['failed', 'cancelled'].includes(msg.status) && msg.runId && !isRestoredRunId(msg.runId) && (
                          <button className="text-button" disabled={!!activeRun} onClick={() => reconnectRun(msg.runId!)}>刷新执行状态</button>
                        )}
                      </div>
                    )}
                    </div>
                    {msg.artifactId && team.artifacts.some((a) => a.id === msg.artifactId) && (
                      <button
                        className="message-artifact"
                        onClick={() =>
                          setArtifact(team.artifacts.find((a) => a.id === msg.artifactId)!)
                        }
                      >
                        <FileText size={18} />
                        <span>{team.artifacts.find((a) => a.id === msg.artifactId)?.name}</span>
                        <ArrowUpRight size={14} />
                      </button>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="workspace-empty">
                <div className="welcome-provider">
                  <AgentAvatar member={lead} />
                </div>
                <h3>{filters.activity.query || filters.activity.filter !== 'all' ? '没有匹配的消息'
                  : needsConnection ? hasReadyProvider ? '选择一个可用模型' : stillInspecting ? '正在检查本机模型' : '连接模型，开始对话' : '从一个想法开始'}</h3>
                <p>
                  {filters.activity.query || filters.activity.filter !== 'all'
                    ? '尝试其他关键词，或切换到全部员工。'
                    : needsConnection ? hasReadyProvider ? '已有模型账号可直接使用。选择服务后，确认用于当前空会话或新会话默认。'
                      : stillInspecting ? '可以先写下草稿，或选择服务查看官方登录引导；已就绪的账号会立即显示。'
                        : '连接一个模型账号，选择如何使用；草稿与附件会保留。'
                    : `${lead.name}在这里。今天想聊什么？`}
                </p>
                {!filters.activity.query && filters.activity.filter === 'all' && (
                  <button className={`ws-button${needsConnection ? ' accent' : ''}`} onClick={() => needsConnection ? setConnectingTeam(team.id) : setEmployeeEditor('new')}>
                    {needsConnection ? <ArrowUpRight size={14} /> : <Plus size={14} />}
                    {needsConnection ? hasReadyProvider ? '选择可用模型' : '连接模型账号' : team.members.length === 1 ? '添加协作员工' : '继续添加员工'}
                  </button>
                )}
              </div>
            )}
            {actionError && <p className="ws-error" role="alert">{actionError}</p>}
            </div>
          </div>
          <div className="conversation-scroll-actions">
            {showLatest && <button type="button" className="ws-button" onClick={scrollToLatest}>回到最新消息</button>}
          </div>
          <form
            className="team-composer"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <AttachmentList files={attachments} workspaceId={team.id} remove={(id) => useCollaboration.getState().removeAttachment(team.id, id)} />
            {uploading && <p className="attachment-status" role="status">正在上传附件…</p>}
            {uploadErrors[team.id] && <p className="ws-error" role="alert">{uploadErrors[team.id]}</p>}
            {recipientIssue && <div className="composer-account-notice" role="status">
              <span>{unavailableProviders} · {recipientIssue.label}{recipientFailure ? `：${recipientFailure}` : '，暂不能发送'}</span>
              {['unknown', 'error', 'checking'].includes(recipientIssue.state)
                && <button type="button" className="text-button" disabled={!retryProviders.length} onClick={() => void useProviders.getState().inspect(retryProviders)}>
                  <RotateCcw size={13} />重新检测
                </button>}
              <button type="button" className="text-button" onClick={() => setSettings(true, 'providers')}>
                  <ArrowUpRight size={13} />模型与账号
              </button>
              {team.messages.length > 0 && <button type="button" className="text-button" onClick={() => setConnectingTeam(team.id)}>连接模型账号</button>}
            </div>}
            <textarea
              aria-label="对话消息"
              placeholder={`向${recipient === 'all' ? '全体员工' : name(recipient)}描述你的想法…`}
              rows={2}
              maxLength={8000}
              value={drafts[team.id] || ''}
              onChange={(e) => setDraft(team.id, e.target.value)}
              onKeyDown={(e) => handleComposerEnter(e, (value) => setDraft(team.id, value), send)}
            />
            <div className="composer-bottom">
              <button className="icon-btn attachment-upload" type="button" title="上传文件（最多 5 个，每个 8 MB）" aria-label="上传文件" disabled={uploading || attachments.length >= MAX_ATTACHMENTS || (recipient === lead.id && (chatOnly || !!workRun))}
                onClick={() => attachmentRef.current?.click()}><Paperclip size={18} /></button>
              <input ref={attachmentRef} type="file" multiple hidden aria-label="选择对话附件" onChange={(e) => {
                const files = Array.from(e.target.files || [])
                e.target.value = ''
                void uploadFiles(files)
              }} />
              <label className="composer-recipient">
                <Users size={14} />
                <select
                  aria-label="消息接收人"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                >
                  {team.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {name(m.id)} · {PROVIDERS[m.provider].name}
                      {!readiness(m).canRun ? ` · ${readiness(m).label}` : ''}
                    </option>
                  ))}
                  <option value="all">全体员工</option>
                </select>
              </label>
              <label className="composer-permissions" title={permissionDescription}>
                <ShieldCheck size={14} aria-hidden="true" />
                <select
                  aria-label={t('composer.permissions')}
                  aria-describedby="workspace-permission-description"
                  disabled={conversationOnly}
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(team.id, e.target.value as PermissionMode)}
                >
                  <option value="ask">{t('composer.ask')}</option>
                  <option value="review">{t('composer.review')}</option>
                  <option value="auto">{t('composer.full')}</option>
                </select>
              </label>
              <span className="composer-mode">
                {recipient === lead.id ? <span className="assistant-conversation-mode" role="group" aria-label="交流方式">
                  <button type="button" aria-pressed={!chatOnly && !workRun} disabled={!!workRun || !!conversationRun} onClick={() => setChatOnly(false)}>助手</button>
                  <button type="button" aria-pressed={chatOnly || !!workRun} disabled={!!conversationRun} onClick={() => setChatOnly(true)}>聊聊</button>
                </span> : recipient === 'all' ? `${team.members.length} 位员工` : '员工对话'}
              </span>
              {(conversationRun || (workRun && recipient !== lead.id)) ? <button type="button" className="composer-send composer-stop" aria-label="停止生成"
                title="停止生成" disabled={stoppingRuns[(conversationRun || workRun)!.id]} onClick={() => void stop((conversationRun || workRun)!.id)}>
                <Square size={14} fill="currentColor" />
              </button> : <button
                className="composer-send"
                type="submit"
                aria-label="发送消息"
                title="Enter 发送 · Ctrl+Enter 换行"
                disabled={!canSend || !!conversationRun || (!!workRun && recipient !== lead.id) || uploading || (!(drafts[team.id] || '').trim() && !attachments.length)}
              >
                <ArrowUp size={17} />
              </button>}
            </div>
            <p className="composer-permission-help" id="workspace-permission-description">{permissionDescription}</p>
          </form>
          <div className="composer-footnote">
            <span>{recipient === lead.id ? '主 agent 私人交流' : '团队协作'}</span>
            <span>{workRun ? '后台任务进行中' : parent ? parent.name : team.name}</span>
          </div>
        </>
      </main>
      {rightOpen && (
        <aside className="team-inspector" id="workspace-sidebar" aria-label="对话侧栏">
          <div className="inspector-title drag">
            <span>{team.kind === 'project' ? '项目' : '对话'}详情</span>
            <button
              className="icon-btn no-drag"
              aria-label="关闭对话侧栏"
              onClick={() => setRightOpen(false)}
            >
              <PanelRightClose size={15} />
            </button>
          </div>
          <div className="inspector-scroll">
            <header className="team-heading">
              <div className="team-heading-top">
                <div>
                  <div className="team-eyebrow">
                    <span className="workspace-symbol">
                      {team.kind === 'project' ? <FolderOpen size={14} /> : <MessageSquare size={14} />}
                    </span>
                    {team.kind === 'project' ? '项目空间' : parent ? '项目对话' : '独立对话'}
                    {team.sample && <span className="ws-badge">历史示例</span>}
                  </div>
                  <h1>{team.name}</h1>
                </div>
                <div className="workspace-header-actions">
                  <button className="ws-button" onClick={() => setEmployeeEditor('new')}>
                    <Plus size={14} />
                    添加员工
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={team.kind === 'project' ? '编辑项目' : '编辑对话'}
                    onClick={() => setEditing(true)}
                  >
                    <Settings2 size={16} />
                  </button>
                </div>
              </div>
              <p>
                {team.goal || (parent?.goal ? `项目目标：${parent.goal}` : '') ||
                  (team.kind === 'project'
                    ? '围绕同一个目标组织员工、对话与共享成果。'
                    : '先与主 agent 开始对话，再按需要添加不同职责的员工。')}
              </p>
              {directory && (
                <div className="workspace-directory" title={directory}>
                  <FolderOpen size={13} />
                  <span>{directory}</span>
                </div>
              )}
              <div className="team-summary">
                <button className="current-lead" onClick={() => setEmployeeEditor(lead)}>
                  <AgentAvatar member={lead} small />
                  <span>
                    {lead.name} · {lead.model || PROVIDERS[lead.provider].name}
                  </span>
                </button>
                <i />
                <span>{team.members.length} 位员工</span>
                <i />
                <span>{team.tasks.length} 项任务</span>
                {team.tasks.length > 0 && (
                  <div className="team-progress">
                    <span>
                      {done}/{team.tasks.length} 已完成
                    </span>
                    <progress value={done} max={team.tasks.length} />
                  </div>
                )}
              </div>
            </header>
            {team.kind === 'project' && (
              <div className="project-conversations">
                <div className="ws-section-heading">
                  <h3>
                    项目对话 <span className="optional-label">{children.length}</span>
                  </h3>
                  <button
                    className="ws-button"
                    onClick={() => createWorkspace('conversation', '', '', team.id)}
                  >
                    <Plus size={13} />
                    新建项目对话
                  </button>
                </div>
                <p>新对话复制当前项目员工配置，之后可独立调整。</p>
                {children.length > 0 && (
                  <div className="project-conversation-list">
                    {children.map((child) => (
                      <button key={child.id} onClick={() => navigate('team', child.id)}>
                        <MessageSquare size={13} />
                        <span>{child.name}</span>
                        <ChevronRight size={12} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <nav className="workspace-tabs" aria-label="当前空间内容">
              {(
                [
                  ['activity', '对话', MessageSquare, team.messages.filter((message) => !message.toolPermission).length],
                  ['tasks', '任务看板', ListTodo, team.tasks.length],
                  ['artifacts', '共享成果', FolderOpen, team.artifacts.length],
                  ['employees', '员工', Users, team.members.length]
                ] as const
              ).map(([id, label, Icon, count]) => (
                <button
                  key={id}
                  className={tab === id ? 'active' : ''}
                  aria-current={tab === id ? 'page' : undefined}
                  onClick={() => setTab(id)}
                >
                  <Icon size={14} />
                  {label}
                  <span>{count}</span>
                </button>
              ))}
            </nav>
            {tab !== 'employees' && (
              <div className="workspace-toolbar">
                <div className="member-filters">
                  <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                    全部员工
                  </button>
                  {team.members.map((m) => (
                    <button
                      key={m.id}
                      className={filter === m.id ? 'active' : ''}
                      onClick={() => setFilter(m.id)}
                    >
                      <span className={`member-dot ${PROVIDERS[m.provider].tone}`} />
                      {m.name}
                    </button>
                  ))}
                </div>
                <label className="workspace-search">
                  <Search size={13} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索"
                    aria-label="搜索当前内容"
                  />
                </label>
              </div>
            )}
            {tab === 'tasks' ? (
              <div className="workspace-content">
                <div className="ws-section-heading">
                  <span>任务与执行 · 点击卡片查看、编辑或交给负责人</span>
                  {schedule && ['running', 'waiting_review'].includes(schedule.status) ? (
                    <button className="ws-button" onClick={() => void pauseTaskSchedule(team.id)}>暂停调度</button>
                  ) : (
                    <button className="ws-button" disabled={team.paused || parent?.paused || !team.tasks.some((task) => task.state === 'ready')}
                      onClick={() => startTaskSchedule(team.id)}>{schedule && schedule.status !== 'completed' ? '继续调度' : '调度待开始任务'}</button>
                  )}
                  <button className="ws-button" onClick={() => setTaskEditor('new')}>
                    <Plus size={14} />
                    新建任务
                  </button>
                </div>
                {schedule && <p className="ws-notice" role="status">
                  {{ running: '正在按依赖安排任务，完成后进入待评审。', waiting_review: '等待前置任务验收；将前置任务标为已完成后继续。',
                    paused: '调度已暂停。继续前会核对已有执行状态。', failed: '调度已停止，请处理失败后继续。', completed: '本轮调度结束，交付结果仍需用户验收。' }[schedule.status]}
                  {schedule.error ? ` ${schedule.error}` : ''}
                </p>}
                <div className="task-board">
                  {Object.entries(TASK_STATES).map(([state, info]) => (
                    <section className="task-column" key={state}>
                      <h3>
                        <span className={`member-dot ${info.color}`} />
                        {info.label}
                        <span>{filteredTasks.filter((t) => t.state === state).length}</span>
                      </h3>
                      {filteredTasks
                        .filter((t) => t.state === state)
                        .map((task) => (
                          <button
                            className="task-card"
                            key={task.id}
                            onClick={() => setTaskEditor(task)}
                          >
                            <span className="task-card-id">TASK · {team.tasks.indexOf(task) + 1}</span>
                            <strong>{task.title}</strong>
                            <p>{task.description}</p>
                            {task.managedRunId && <span className="task-dependency">
                              主 agent 调度 · {task.state === 'done' ? '你已验收' : task.managedStatus === 'completed' ? '检查通过，待你验收' : task.managedStatus === 'failed' ? '需返工或重新指派' : task.managedStatus === 'review' ? '等待主 agent 检查' : task.managedStatus === 'working' ? '正在执行' : '待执行'}
                            </span>}
                            {task.reviewNote && <span className="task-dependency" title={task.reviewNote}>{task.reviewNote.length > 120 ? task.reviewNote.slice(0, 120) + '…' : task.reviewNote}</span>}
                            {task.dependency && (
                              <span className="task-dependency">
                                前置：{(task.managedDependencies || [task.dependency]).map((id) => team.tasks.find((t) => t.id === id)?.title).filter(Boolean).join('、')}
                              </span>
                            )}
                            <span className="task-owner">
                              <AgentAvatar member={member(task.owner)} provider={provider(task.owner)} small />
                              {name(task.owner)}
                              <ArrowUpRight size={13} />
                            </span>
                          </button>
                        ))}
                      {!filteredTasks.some((t) => t.state === state) && (
                        <div className="empty-column">暂无任务</div>
                      )}
                    </section>
                  ))}
                </div>
              </div>
            ) : tab === 'artifacts' ? (
              <div className="workspace-content">
                <div className="ws-section-heading">
                  <span>当前{team.kind === 'project' ? '项目' : '对话'}的共享文档与交付物</span>
                  <button className="ws-button" onClick={() => fileRef.current?.click()}>
                    <Upload size={14} />
                    导入文件
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    hidden
                    accept=".md,.txt,.json,.csv"
                    onChange={(e) => {
                      void importFile(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </div>
                {fileError && (
                  <p className="ws-error" role="alert">
                    {fileError}
                  </p>
                )}
                <div className="artifact-list">
                  {filteredArtifacts.map((a) => (
                    <button className="artifact-row" key={a.id} onClick={() => setArtifact(a)}>
                      <span className="artifact-file-icon">
                        <FileText size={23} />
                      </span>
                      <span>
                        <strong>{a.name}</strong>
                        <small>{a.description}</small>
                      </span>
                      <span className="artifact-owner">{name(a.owner)}</span>
                      <span className="ws-badge">v{a.version}</span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
                {!filteredArtifacts.length && (
                  <div className="workspace-empty">
                    <FolderOpen size={28} />
                    <h3>把成果留在这里</h3>
                    <p>导入 Markdown、TXT、JSON 或 CSV 文件，单个文件不超过 256 KB。</p>
                  </div>
                )}
              </div>
            ) : tab === 'employees' ? (
              <div className="workspace-content">
                <div className="ws-section-heading">
                  <div>
                    <h3>当前{team.kind === 'project' ? '项目' : '对话'}的员工</h3>
                    <p className="employee-hint">由你定义名称、模型、职责与人格。点击卡片编辑。</p>
                  </div>
                  <button className="ws-button" onClick={() => setEmployeeEditor('new')}>
                    <Plus size={14} />
                    添加员工
                  </button>
                </div>
                <div className="employee-grid">
                  {team.members.map((m) => (
                    <button className="employee-card" key={m.id} onClick={() => setEmployeeEditor(m)}>
                      <div className="employee-card-head">
                        <AgentAvatar member={m} />
                        <div className="employee-card-identity">
                          <strong>{m.name}</strong>
                          <small>
                            {m.model || PROVIDERS[m.provider].name}
                            {m.effort ? ` · ${EFFORT_LABELS[m.effort] || m.effort}` : ''}
                          </small>
                        </div>
                        {m.isLead && <span className="ws-badge sage">主 agent</span>}
                        <Settings2 size={14} />
                      </div>
                      <p>{m.role}</p>
                      <span className={`employee-connection ${readiness(m).state}`} title={readiness(m).detail}>
                        <span className="connection-dot" />{PROVIDERS[m.provider].name} · {readiness(m).label}
                      </span>
                      <div className="employee-persona">
                        <span>人格</span>
                        <p>{m.persona || '未设置 · 使用模型默认行为与语气'}</p>
                      </div>
                      <footer>
                        <span>{team.tasks.filter((t) => t.owner === m.id).length} 项任务</span>
                        <span>
                          {m.personaSource ? '已导入人格' : m.persona ? '自定义人格' : '可添加人格'}
                        </span>
                      </footer>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {tab === 'activity' && (
              <>
                <div className="ws-notice">
                  <CircleDot size={13} />
                  <span>
                    {activeRun
                      ? '员工依次回复；后续员工可见前序结果。'
                      : team.sample ? '历史示例 · 员工配置不代表账号已授权' : '当前空间共享消息与成果'}
                  </span>
                </div>

                <div className="ws-section-heading">
                  <h3>员工与分工</h3>
                  <span>{team.members.length} 位</span>
                </div>
                <p className="inspector-intro">每位员工独立配置模型、职责与人格。</p>
                <div className="inspector-members">
                  {team.members.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setEmployeeEditor(m)}
                      aria-label={`编辑员工 ${m.name}`}
                    >
                      <AgentAvatar member={m} />
                      <span className="inspector-member-details">
                        <strong className="inspector-member-name">{m.name}</strong>
                        <small className="inspector-member-role">{m.role}</small>
                        <span className={`employee-connection ${readiness(m).state}`} title={readiness(m).detail}>
                          <span className="connection-dot" />{PROVIDERS[m.provider].name} · {readiness(m).label}
                        </span>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                <button
                  className="ws-button add-employee-wide"
                  onClick={() => setEmployeeEditor('new')}
                >
                  <Plus size={14} />
                  添加员工
                </button>
                <div className="inspector-integration">
                  <span className={`employee-connection ${leadReadiness.state}`} title={leadReadiness.detail}>
                    <span className="connection-dot" />主 agent · {leadReadiness.label}
                  </span>
                  <button onClick={() => setSettings(true, 'providers')}>
                    查看账号
                    <ArrowUpRight size={12} />
                  </button>
                </div>
                <div className="inspector-divider" />
                <div className="ws-section-heading">
                  <h3>待推进的任务</h3>
                  <button
                    className="text-button"
                    onClick={() => {
                      setTab('tasks')
                      setFilters((s) => ({ ...s, tasks: { filter: 'all', query: '' } }))
                    }}
                  >
                    查看全部
                    <ChevronRight size={12} />
                  </button>
                </div>
                <div className="inspector-tasks">
                  {team.tasks
                    .filter((t) => t.state !== 'done')
                    .slice(0, 3)
                    .map((t) => (
                      <button key={t.id} onClick={() => setTaskEditor(t)}>
                        <CircleDot size={15} />
                        <span>
                          <strong>{t.title}</strong>
                          <small>
                            {name(t.owner)} · {TASK_STATES[t.state].label}
                          </small>
                        </span>
                      </button>
                    ))}
                  {!team.tasks.some((t) => t.state !== 'done') && (
                    <p className="inspector-intro">暂无待推进任务</p>
                  )}
                </div>
                <div className="inspector-divider" />
                <div className="workspace-scope-note">
                  <h3>当前空间的配置</h3>
                  <p>
                    {parent
                      ? '员工配置从项目创建时复制，在此处修改不会影响项目或其他对话。'
                      : team.kind === 'project'
                        ? '项目员工会复制到之后创建的项目对话，已有对话保持独立。'
                        : '员工、职责和人格仅用于当前对话，其他对话不受影响。'}
                  </p>
                </div>
              </>
            )}
          </div>
        </aside>
      )}
      {editing && <WorkspaceEditor team={team} close={() => setEditing(false)} />}
      {connectingTeam && <ProviderConnectionDialog teamId={connectingTeam} close={() => setConnectingTeam(null)} applied={(message) => {
        setConnectionNotice({ teamId: connectingTeam, message }); setConnectingTeam(null)
      }} />}
      {assistantOpen && <AssistantPanel scopeId={scopeId} initialTab={assistantTab} onClose={() => setAssistantOpen(false)} />}
      {employeeEditor && (
        <EmployeeEditor
          team={team}
          employee={employeeEditor === 'new' ? undefined : employeeEditor}
          close={() => setEmployeeEditor(null)}
        />
      )}
      {taskEditor && (
        <TaskEditor
          team={team}
          task={taskEditor === 'new' ? undefined : taskEditor}
          onExecute={() => setTab('activity')}
          close={() => setTaskEditor(null)}
        />
      )}
      {artifact && (
        <ArtifactPreview
          artifact={artifact}
          ownerName={name(artifact.owner)}
          close={() => setArtifact(null)}
        />
      )}
    </>
  )
}
