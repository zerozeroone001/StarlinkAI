import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { isImageAttachment, isImagePath } from '@/lib/files'
import {
  BrainCircuit,
  Check,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Wrench
} from 'lucide-react'
import { useApp } from '@/stores/app'
import { useT } from '@/lib/i18n'
import { Composer } from './Composer'
import { DiffView } from './DiffView'
import { ChatImages, Markdown, ResolvedImage } from './Markdown'
import { GrokMark } from './GrokMark'
import { ImageZoom } from './ImageZoom'

const ThinkingCard = memo(function ThinkingCard({
  text,
  streaming,
  label
}: {
  text: string
  streaming?: boolean
  label: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-card">
      <button
        type="button"
        className="process-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BrainCircuit size={14} />
        <span className="name">{label}</span>
        {streaming ? <span className="spinner" /> : <Check size={13} style={{ color: 'var(--ok)' }} />}
        <ChevronRight className="process-chevron" size={14} data-open={open || undefined} />
      </button>
      {open ? <div className="thinking">{text}</div> : null}
    </div>
  )
})

const ToolCard = memo(function ToolCard({
  title,
  status,
  kind,
  diff,
  output,
  path,
  images,
  cwd,
  sessionId
}: {
  title: string
  status: string
  kind?: string
  diff?: string
  output?: string
  path?: string
  images?: { path?: string; dataUrl?: string; alt?: string }[]
  cwd?: string
  sessionId?: string
}) {
  const media = images?.length ? images : path && isImagePath(path) ? [{ path }] : []
  const [open, setOpen] = useState(false)
  return (
    <div className="tool-card">
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Wrench size={14} style={{ color: 'var(--text-3)' }} />
        <span className="name">{title}</span>
        <span className="badge">{kind || status}</span>
        {status === 'in_progress' ? <span className="spinner" /> : <Check size={13} style={{ color: 'var(--ok)' }} />}
        <ChevronRight className="process-chevron" size={14} data-open={open || undefined} />
      </button>
      {open && media.length ? (
        <div className="tool-image-full">
          <ChatImages images={media} cwd={cwd} sessionId={sessionId} />
        </div>
      ) : null}
      {open && (diff || (output && !media.length)) ? (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {diff ? <DiffView raw={diff} /> : <pre className="diff" style={{ padding: 12 }}>{output}</pre>}
        </div>
      ) : null}
    </div>
  )
})

const ProcessGroup = memo(function ProcessGroup({
  messages,
  label,
  thinkingLabel,
  cwd,
  sessionId
}: {
  messages: ChatMessage[]
  label: string
  thinkingLabel: string
  cwd?: string
  sessionId?: string
}) {
  const [open, setOpen] = useState(false)
  const active = messages.some(
    (message) => message.streaming || message.tool?.status === 'in_progress'
  )
  return (
    <div className="process-group">
      <button
        type="button"
        className="process-head process-group-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BrainCircuit size={14} />
        <span className="name">{label}</span>
        <span className="badge">{messages.length}</span>
        {active ? <span className="spinner" /> : <Check size={13} style={{ color: 'var(--ok)' }} />}
        <ChevronRight className="process-chevron" size={14} data-open={open || undefined} />
      </button>
      {open ? (
        <div className="process-group-body">
          {messages.map((message) =>
            message.kind === 'thinking' ? (
              <ThinkingCard
                key={message.id}
                text={message.text}
                streaming={message.streaming}
                label={thinkingLabel}
              />
            ) : message.tool ? (
              <ToolCard
                key={message.id}
                title={message.tool.title || message.tool.name}
                status={message.tool.status}
                kind={message.tool.kind}
                diff={message.tool.diff}
                output={message.tool.output}
                path={message.tool.path}
                images={message.tool.images}
                cwd={cwd}
                sessionId={sessionId}
              />
            ) : null
          )}
        </div>
      ) : null}
    </div>
  )
})

export function ThreadView() {
  const {
    messages,
    cwd,
    git,
    running,
    permission,
    respondPermission,
    setRightOpen,
    rightOpen,
    projects,
    addProject,
    send,
    error,
    toggleSidebar,
    threads,
    activeThreadId,
    openThread,
    hasMoreHistory,
    loadingHistory,
    loadOlderMessages
  } = useApp()
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollThreadRef = useRef<string | null>(null)
  const loadingOlderRef = useRef(false)
  const project = projects.find((p) => p.path === cwd)
  const empty = messages.length === 0
  const background = threads.filter(
    (t) => t.id !== activeThreadId && (t.status === 'running' || t.status === 'needs_input')
  )
  const othersRunning = background.filter((t) => t.status === 'running').length
  const needsApproval = background.find((t) => t.status === 'needs_input')
  const timeline = useMemo(() => {
    const items: Array<
      | { kind: 'message'; message: ChatMessage }
      | { kind: 'process'; id: string; messages: ChatMessage[] }
    > = []
    for (const message of messages) {
      if (message.kind === 'thinking' || message.kind === 'tool') {
        const last = items[items.length - 1]
        if (last?.kind === 'process') last.messages.push(message)
        else items.push({ kind: 'process', id: `process-${message.id}`, messages: [message] })
      } else {
        items.push({ kind: 'message', message })
      }
    }
    return items
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const switchedThread = scrollThreadRef.current !== activeThreadId
    scrollThreadRef.current = activeThreadId
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (!switchedThread && !nearBottom) return
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeThreadId, messages, running])

  const loadOlderAtTop = () => {
    const el = scrollRef.current
    if (!el || !activeThreadId || !hasMoreHistory || loadingHistory || loadingOlderRef.current) {
      return
    }
    loadingOlderRef.current = true
    const threadId = activeThreadId
    const previousHeight = el.scrollHeight
    const previousTop = el.scrollTop
    void loadOlderMessages().finally(() => {
      window.requestAnimationFrame(() => {
        const current = scrollRef.current
        if (current && useApp.getState().activeThreadId === threadId) {
          current.scrollTop = previousTop + (current.scrollHeight - previousHeight)
        }
        loadingOlderRef.current = false
      })
    })
  }

  const onThreadScroll = () => {
    if ((scrollRef.current?.scrollTop || 0) <= 24) loadOlderAtTop()
  }

  const suggestions = [
    t('suggest.architecture'),
    t('suggest.tests'),
    t('suggest.settings'),
    t('suggest.ui')
  ]

  return (
    <main className="main">
      <div className="thread-bar drag">
        <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <button className="icon-btn" title={t('nav.sidebar')} onClick={() => toggleSidebar()}>
            <PanelLeft size={16} />
          </button>
          <span className="title">{project?.name || t('brand.name')}</span>
          {cwd ? (
            <button className="chip-btn" onClick={() => window.grok.openPath(cwd)}>
              <FolderOpen size={13} />
              {cwd.replace(/\\/g, '/').split('/').slice(-2).join('/')}
            </button>
          ) : null}
          {git?.branch ? <span className="chip">{git.branch}</span> : null}
          {othersRunning ? (
            <span className="chip" title={t('thread.othersHint')}>
              {othersRunning}{' '}
              {othersRunning === 1 ? t('thread.otherTask') : t('thread.otherTasks')}
            </span>
          ) : null}
          {needsApproval ? (
            <button
              className="chip-btn"
              title={t('thread.approvalHint')}
              onClick={() => void openThread(needsApproval)}
            >
              {t('thread.approvalNeeded')}
            </button>
          ) : null}
        </div>
        <div className="no-drag" style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" title={t('thread.panel')} onClick={() => setRightOpen(!rightOpen)}>
            <PanelRight size={16} />
          </button>
          <button className="icon-btn">
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>

      {empty ? (
        <div className="empty-wrap">
          <GrokMark size={42} />
          <h1>{t('thread.emptyTitle')}</h1>
          {error ? (
            <div style={{ color: 'var(--danger)', fontSize: 13, maxWidth: 520, textAlign: 'center' }}>
              {error}
            </div>
          ) : null}
          <div className="suggest-row">
            {suggestions.map((s) => (
              <button key={s} className="suggest" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
          {!cwd ? (
            <button className="secondary" onClick={() => void addProject()}>
              {t('thread.workInProject')}
            </button>
          ) : null}
          <Composer centered />
        </div>
      ) : (
        <>
          <div className="thread-scroll scroll" ref={scrollRef} onScroll={onThreadScroll}>
            <div className="thread-inner">
              {loadingHistory ? (
                <div className="history-loading" aria-label={t('thread.working')}>
                  <span className="spinner" />
                </div>
              ) : null}
              {timeline.map((item) => {
                if (item.kind === 'process') {
                  return (
                    <ProcessGroup
                      key={item.id}
                      messages={item.messages}
                      label={t('thread.process')}
                      thinkingLabel={t('thread.thinking')}
                      cwd={cwd}
                      sessionId={activeThreadId || undefined}
                    />
                  )
                }
                const m = item.message
                if (m.kind === 'user') {
                  return (
                    <div key={m.id} className="msg user">
                      <div className="msg-col">
                        <div className="msg-role">{t('thread.you')}</div>
                        {m.attachments?.length ? (
                          <div className="attach-strip">
                            {m.attachments.map((a) => (
                              <div className="attach-chip" key={a.path || a.name}>
                                {a.dataUrl && isImageAttachment(a) ? (
                                  <ImageZoom
                                    src={a.dataUrl}
                                    className="attach-thumb"
                                    fileName={a.name}
                                    sourcePath={a.path}
                                    cwd={cwd}
                                    sessionId={activeThreadId || undefined}
                                    showActions={false}
                                  />
                                ) : a.path ? (
                                  <ResolvedImage
                                    src={a.path}
                                    className="attach-thumb"
                                    userSelected
                                    cwd={cwd}
                                    sessionId={activeThreadId || undefined}
                                    showActions={false}
                                  />
                                ) : null}
                                <span className="attach-name" title={a.name}>
                                  {a.name}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {m.text ? <div className="bubble">{m.text}</div> : null}
                      </div>
                    </div>
                  )
                }
                if (m.kind === 'error') {
                  return (
                    <div key={m.id} className="msg assistant">
                      <div className="msg-avatar">
                        <GrokMark size={22} />
                      </div>
                      <div className="msg-col">
                        <div className="msg-role">{t('brand.name')}</div>
                        <div className="msg-card error">{m.text}</div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={m.id} className="msg assistant">
                    <div className="msg-avatar">
                      <GrokMark size={22} />
                    </div>
                    <div className="msg-col">
                      <div className="msg-role">{t('brand.name')}</div>
                      <div className="msg-card">
                        <Markdown
                          text={m.text}
                          images={m.images}
                          cwd={cwd}
                          sessionId={activeThreadId || undefined}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
              {running ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', padding: '8px 0' }}>
                  <span className="spinner" />
                  {t('thread.working')}
                </div>
              ) : null}
            </div>
          </div>
          {permission ? (
            <div className="perm-bar">
              <Wrench size={16} />
              <div className="grow">
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t('thread.needsApproval')}</div>
                <div className="cmd">
                  {permission.toolCall?.title ||
                    JSON.stringify(permission.toolCall?.rawInput || {}).slice(0, 140)}
                </div>
              </div>
              {permission.options.map((opt) => (
                <button
                  key={opt.optionId}
                  className={opt.optionId.includes('allow') ? 'primary' : 'secondary'}
                  onClick={() => void respondPermission(opt.optionId)}
                >
                  {opt.optionId.includes('always')
                    ? t('perm.allowAlways')
                    : opt.optionId.includes('allow')
                      ? t('perm.allowOnce')
                      : opt.optionId.includes('reject') || opt.optionId.includes('cancel')
                        ? t('perm.reject')
                        : opt.name}
                </button>
              ))}
            </div>
          ) : null}
          <Composer />
        </>
      )}
    </main>
  )
}
