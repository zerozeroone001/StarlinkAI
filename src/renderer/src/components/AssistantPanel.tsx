import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Bell, Check, Clock3, LoaderCircle, Pencil, Plus, RefreshCw, Save, Trash2, UserRound, X, BookOpen } from 'lucide-react'
import { ASSISTANT_LIMITS, type AssistantSnapshot } from '@shared/assistant'
import { useAssistant, type AssistantProfilePatch, type CommitmentInput, type MemoryInput } from '@/stores/assistant'
import { currentWorkspaceGeneration } from '@/stores/collaboration'
import { portableErrorMessage } from '@/lib/portable-backup-display'
import { WorkspaceDialog } from './WorkspaceDialogs'
import './assistant.css'
import './portable-backup.css'

type Profile = AssistantSnapshot['profile']
type Memory = AssistantSnapshot['memories'][number]
type Commitment = AssistantSnapshot['commitments'][number]
type Tab = 'profile' | 'memories' | 'commitments'
const memoryKinds = { preference: '偏好', fact: '事实', agreement: '约定' } as const
const styles = { balanced: '平衡', professional: '专业', warm: '温暖', companion: '陪伴' } as const
const tabs = [
  { id: 'profile', label: '身份', Icon: UserRound },
  { id: 'memories', label: '记忆', Icon: BookOpen },
  { id: 'commitments', label: '承诺与提醒', Icon: Bell }
] as const

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function localDateInput(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function AssistantPanel({ scopeId, onClose, initialTab = 'profile' }: { scopeId: string; onClose: () => void; initialTab?: Tab }) {
  return <AssistantPanelContent key={scopeId} scopeId={scopeId} onClose={onClose} initialTab={initialTab} />
}

function AssistantPanelContent({ scopeId, onClose, initialTab }: { scopeId: string; onClose: () => void; initialTab: Tab }) {
  const snapshot = useAssistant((state) => state.snapshots[scopeId])
  const loading = useAssistant((state) => !!state.loading[scopeId])
  const saving = useAssistant((state) => !!state.saving[scopeId])
  const error = useAssistant((state) => state.errors[scopeId])
  const refresh = useAssistant((state) => state.refresh)
  const [tab, setTab] = useState<Tab>(initialTab)
  useEffect(() => { void refresh(scopeId) }, [scopeId, refresh])
  return <WorkspaceDialog title="项目主 agent" close={onClose} className="assistant-panel">
    <div className="assistant-tabs" role="tablist" aria-label="主 agent 设置">
      {tabs.map(({ id, label, Icon }) => <button type="button" key={id} role="tab" id={`assistant-tab-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} aria-controls={`assistant-section-${id}`} onClick={() => setTab(id)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = tabs.findIndex((item) => item.id === tab)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
            (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          setTab(tabs[next].id)
          document.getElementById(`assistant-tab-${tabs[next].id}`)?.focus()
        }}>
        <Icon size={15} /><span>{label}</span>
      </button>)}
      <button type="button" className="icon-btn assistant-refresh" title="刷新资料" aria-label="刷新资料"
        disabled={loading || saving} onClick={() => void refresh(scopeId)}><RefreshCw size={15} className={loading ? 'assistant-spinning' : ''} /></button>
    </div>
    {error && <p className="ws-error assistant-error" role="alert">{error}</p>}
    {!snapshot ? <div className="assistant-empty" role="status">
      {loading ? <><LoaderCircle size={19} className="assistant-spinning" />正在读取资料</> : <button type="button" className="ws-button" onClick={() => void refresh(scopeId)}>重新加载</button>}
    </div> : <div className="assistant-body" aria-busy={saving}>
      <div role="tabpanel" id="assistant-section-profile" aria-labelledby="assistant-tab-profile" hidden={tab !== 'profile'}>
        <ProfileForm scopeId={scopeId} profile={snapshot.profile} saving={saving} />
      </div>
      <div role="tabpanel" id="assistant-section-memories" aria-labelledby="assistant-tab-memories" hidden={tab !== 'memories'}>
        <MemoryList scopeId={scopeId} memories={snapshot.memories} saving={saving} />
      </div>
      <div role="tabpanel" id="assistant-section-commitments" aria-labelledby="assistant-tab-commitments" hidden={tab !== 'commitments'}>
        <CommitmentList scopeId={scopeId} commitments={snapshot.commitments} saving={saving} remindersPaused={snapshot.remindersPaused} />
      </div>
    </div>}
  </WorkspaceDialog>
}

function ProfileForm({ scopeId, profile, saving }: { scopeId: string; profile: Profile; saving: boolean }) {
  const [draft, setDraft] = useState(profile)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (!dirty) setDraft(profile) }, [profile, dirty])
  const update = (patch: AssistantProfilePatch) => { setDraft((value) => ({ ...value, ...patch })); setDirty(true); setSaved(false) }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !draft.name.trim()) return
    const result = await useAssistant.getState().updateProfile(scopeId, {
      name: draft.name.trim(), persona: draft.persona.trim(), addressing: draft.addressing.trim(), style: draft.style
    })
    if (result) { setDraft(result.profile); setDirty(false); setSaved(true) }
  }
  return <form className="ws-form assistant-form" onSubmit={(event) => void submit(event)}>
    <div className="ws-form-pair">
      <label>名字<input required maxLength={ASSISTANT_LIMITS.name} value={draft.name} disabled={saving} onChange={(event) => update({ name: event.target.value })} /></label>
      <label>如何称呼你<input maxLength={ASSISTANT_LIMITS.addressing} value={draft.addressing} disabled={saving} onChange={(event) => update({ addressing: event.target.value })} /></label>
    </div>
    <fieldset className="assistant-style"><legend>相处方式</legend>
      <div className="assistant-style-options">{Object.entries(styles).map(([style, label]) => <label key={style}>
        <input type="radio" name="assistant-style" value={style} checked={draft.style === style} disabled={saving}
          onChange={() => update({ style: style as Profile['style'] })} /><span>{label}</span>
      </label>)}</div>
    </fieldset>
    <label>人格与沟通偏好<textarea aria-label="人格与沟通偏好" rows={7} maxLength={ASSISTANT_LIMITS.persona} value={draft.persona} disabled={saving}
      onChange={(event) => update({ persona: event.target.value })} /></label>
    <footer><span className="assistant-save-status" role="status">{saved ? '已保存' : dirty ? '尚未保存' : ''}</span>
      <button type="submit" className="ws-button accent" disabled={saving || !dirty || !draft.name.trim()}>
        {saving ? <LoaderCircle size={14} className="assistant-spinning" /> : <Save size={14} />}{saving ? '正在保存' : '保存设置'}
      </button>
    </footer>
  </form>
}

function MemoryList({ scopeId, memories, saving }: { scopeId: string; memories: Memory[]; saving: boolean }) {
  const [editing, setEditing] = useState<Memory | 'new' | null>(null)
  return <section className="assistant-list-section" aria-label="项目记忆">
    <div className="assistant-list-toolbar"><span>{memories.length} 条记忆</span>
      <button type="button" className="ws-button" disabled={saving || !!editing || memories.length >= ASSISTANT_LIMITS.memories} onClick={() => setEditing('new')}><Plus size={14} />添加记忆</button>
    </div>
    {editing && <MemoryForm key={editing === 'new' ? 'new' : editing.id} scopeId={scopeId} memory={editing === 'new' ? undefined : editing}
      saving={saving} close={() => setEditing(null)} />}
    {!memories.length && !editing && <p className="assistant-empty">暂无记忆</p>}
    <ul className="assistant-records">{memories.map((memory) => <li key={memory.id}>
      <div className="assistant-record-main"><span className="assistant-record-kind">{memoryKinds[memory.kind]}</span>
        <p>{memory.content}</p>{memory.source && <small>来源：{memory.source}</small>}<time dateTime={memory.updatedAt}>{dateLabel(memory.updatedAt)}</time>
      </div>
      <div className="assistant-record-actions">
        <button type="button" className="icon-btn" title="编辑记忆" aria-label="编辑记忆" disabled={saving || !!editing} onClick={() => setEditing(memory)}><Pencil size={15} /></button>
        <button type="button" className="icon-btn" title="忘记这条记忆" aria-label="忘记这条记忆" disabled={saving || !!editing}
          onClick={() => void useAssistant.getState().forgetMemory(scopeId, memory.id)}><Trash2 size={15} /></button>
      </div>
    </li>)}</ul>
  </section>
}

function MemoryForm({ scopeId, memory, saving, close }: { scopeId: string; memory?: Memory; saving: boolean; close: () => void }) {
  const [draft, setDraft] = useState<MemoryInput>({ id: memory?.id, content: memory?.content || '', kind: memory?.kind || 'preference', source: memory?.source || '' })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !draft.content.trim()) return
    if (await useAssistant.getState().saveMemory(scopeId, { ...draft, content: draft.content.trim(), source: draft.source?.trim() })) close()
  }
  return <form className="ws-form assistant-record-form" onSubmit={(event) => void submit(event)}>
    <label>类型<select value={draft.kind} disabled={saving} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Memory['kind'] })}>
      {Object.entries(memoryKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
    </select></label>
    <label>记忆内容<textarea aria-label="记忆内容" autoFocus required rows={3} maxLength={ASSISTANT_LIMITS.memory} value={draft.content} disabled={saving} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
    <label>来源（选填）<input maxLength={ASSISTANT_LIMITS.source} value={draft.source || ''} disabled={saving} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
    <footer><button type="button" className="ws-button" disabled={saving} onClick={close}><X size={14} />取消</button>
      <button type="submit" className="ws-button accent" disabled={saving || !draft.content.trim()}><Save size={14} />{saving ? '正在保存' : '保存记忆'}</button></footer>
  </form>
}

function CommitmentList({ scopeId, commitments, saving, remindersPaused }: { scopeId: string; commitments: Commitment[]; saving: boolean; remindersPaused?: boolean }) {
  const [editing, setEditing] = useState<Commitment | 'new' | null>(null)
  const [now, setNow] = useState(Date.now)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const busy = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const resumeNotifications = async () => {
    if (busy.current || saving || editing || !window.grok?.backup) return
    const generation = currentWorkspaceGeneration(), snapshot = useAssistant.getState().snapshots[scopeId]
    if (!snapshot?.remindersPaused) return
    busy.current = true; setResuming(true); setResumeError('')
    try {
      const result = await window.grok.backup.setRemindersPaused(scopeId, false, snapshot.revision)
      if (generation !== currentWorkspaceGeneration() || !mounted.current) return
      if (result.profile.scopeId !== scopeId) throw new Error('提醒所属项目不匹配，请刷新资料后重试。')
      useAssistant.getState().applySnapshot(result)
    } catch (cause) { if (mounted.current && generation === currentWorkspaceGeneration()) setResumeError(portableErrorMessage(cause)) }
    finally { busy.current = false; if (mounted.current) setResuming(false) }
  }
  saving ||= resuming
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const sorted = [...commitments].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') ||
    (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || a.createdAt.localeCompare(b.createdAt))
  return <section className="assistant-list-section" aria-label="项目承诺与提醒">
    {remindersPaused && <div className="assistant-reminders-paused" role="status">
      <p>从备份恢复的提醒通知已暂停，承诺与提醒内容仍然保留。恢复通知后，已到期和之后到期的待办可在应用打开时提醒；不会自动执行任务。</p>
      <button type="button" className="ws-button" disabled={saving || !!editing || !window.grok?.backup} onClick={() => void resumeNotifications()}>{resuming ? '正在恢复通知…' : '恢复此助手的提醒通知'}</button>
      {!window.grok?.backup && <p>请在桌面应用中恢复提醒通知。</p>}
      {resumeError && <p className="ws-error" role="alert">{resumeError}</p>}
    </div>}
    <div className="assistant-list-toolbar"><span>{commitments.filter((item) => item.status === 'open').length} 项待办</span>
      <button type="button" className="ws-button" disabled={saving || !!editing || commitments.length >= ASSISTANT_LIMITS.commitments} onClick={() => setEditing('new')}><Plus size={14} />添加承诺</button>
    </div>
    {editing && <CommitmentForm key={editing === 'new' ? 'new' : editing.id} scopeId={scopeId} commitment={editing === 'new' ? undefined : editing}
      saving={saving} close={() => setEditing(null)} />}
    {!commitments.length && !editing && <p className="assistant-empty">暂无承诺或提醒</p>}
    <ul className="assistant-records">{sorted.map((item) => {
      const overdue = item.status === 'open' && !!item.dueAt && Date.parse(item.dueAt) <= now
      return <li key={item.id} className={item.status === 'done' ? 'assistant-done' : ''}>
        <input type="checkbox" className="assistant-complete" checked={item.status === 'done'} disabled={saving || !!editing}
          aria-label={`${item.status === 'done' ? '重新打开' : '完成'}：${item.title}`} onChange={() => void useAssistant.getState().saveCommitment(scopeId, {
            id: item.id, title: item.title, status: item.status === 'done' ? 'open' : 'done'
          })} />
        <div className="assistant-record-main"><p>{item.title}</p>
          {item.status === 'done' ? <small><Check size={12} />已完成</small> : item.dueAt ? <small className={overdue ? 'assistant-overdue' : ''}>
            <Clock3 size={12} /><time dateTime={item.dueAt}>{dateLabel(item.dueAt)}</time>{overdue && <span>已到期</span>}
          </small> : <small>未设提醒时间</small>}
        </div>
        <div className="assistant-record-actions">
          <button type="button" className="icon-btn" title="编辑承诺" aria-label="编辑承诺" disabled={saving || !!editing} onClick={() => setEditing(item)}><Pencil size={15} /></button>
          <button type="button" className="icon-btn" title="删除承诺" aria-label="删除承诺" disabled={saving || !!editing}
            onClick={() => void useAssistant.getState().deleteCommitment(scopeId, item.id)}><Trash2 size={15} /></button>
        </div>
      </li>
    })}</ul>
  </section>
}

function CommitmentForm({ scopeId, commitment, saving, close }: { scopeId: string; commitment?: Commitment; saving: boolean; close: () => void }) {
  const [title, setTitle] = useState(commitment?.title || '')
  const [dueAt, setDueAt] = useState(localDateInput(commitment?.dueAt))
  const [status, setStatus] = useState<Commitment['status']>(commitment?.status || 'open')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !title.trim() || (dueAt && Number.isNaN(Date.parse(dueAt)))) return
    const input: CommitmentInput = { id: commitment?.id, title: title.trim(), status, dueAt: dueAt ? new Date(dueAt).toISOString() : null }
    if (await useAssistant.getState().saveCommitment(scopeId, input)) close()
  }
  return <form className="ws-form assistant-record-form" onSubmit={(event) => void submit(event)}>
    <label>承诺内容<input autoFocus required maxLength={ASSISTANT_LIMITS.commitment} value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} /></label>
    <div className="ws-form-pair">
      <label>提醒时间（选填）<input type="datetime-local" value={dueAt} disabled={saving} onChange={(event) => setDueAt(event.target.value)} /></label>
      <label>状态<select value={status} disabled={saving} onChange={(event) => setStatus(event.target.value as Commitment['status'])}>
        <option value="open">待完成</option><option value="done">已完成</option>
      </select></label>
    </div>
    <footer><button type="button" className="ws-button" disabled={saving} onClick={close}><X size={14} />取消</button>
      <button type="submit" className="ws-button accent" disabled={saving || !title.trim()}><Save size={14} />{saving ? '正在保存' : '保存承诺'}</button></footer>
  </form>
}
