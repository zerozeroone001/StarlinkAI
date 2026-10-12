import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, FolderOpen, FolderPlus, Upload, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import {
  employeeReferenced,
  parsePersonaFile,
  PROVIDER_IDS,
  hasDependencyCycle,
  taskDependencies,
  makeId,
  PROVIDERS,
  TASK_STATES,
  type Member,
  type Provider,
  type Team,
  type TeamArtifact,
  type TeamTask
} from '@/lib/collaboration-data'
import { useCollaboration, currentWorkspaceGeneration, isActive } from '@/stores/collaboration'
import { ProviderMark } from './ProviderMark'
import { ModelPicker } from './ModelPicker'
import { EFFORT_LABELS } from '@shared/runtime'
import { AgentAvatar } from './AgentAvatar'
import { avatarFromFile } from '@/lib/uploads'
import { runtimeClient } from '@/lib/runtime-client'
import { isAbsoluteDirectory, isValidDirectoryName, projectDirectoryPreview } from '@shared/project-directory'
import { ProjectRelinkDialog } from './ProjectRelinkDialog'
import { useAssistant } from '@/stores/assistant'

export function WorkspaceDialog({
  title,
  subtitle,
  children,
  close,
  closeDisabled = false,
  wide = false,
  className = ''
}: {
  title: string
  subtitle?: string
  children: ReactNode
  close: () => void
  closeDisabled?: boolean
  wide?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLInputElement>('input:not([type="file"]), textarea, select')?.focus()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`ws-dialog${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!closeDisabled) close()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect()
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            if (!closeDisabled) close()
        }
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-btn" onClick={close} disabled={closeDisabled} aria-label="关闭弹窗">
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function WorkspaceEditor({ team, close }: { team?: Team; close: () => void }) {
  const savedTeam = useCollaboration((s) => team ? s.teams.find((item) => item.id === team.id) : undefined) || team
  const relatedConversations = useCollaboration((s) => team ? s.teams.filter((item) => item.parentId === team.id).length : 0)
  const running = useCollaboration((s) => s.creatingProject || Object.values(s.runs).some((run) => isActive(run.status)) ||
    Object.values(s.taskSchedules).some((schedule) => ['running', 'waiting_review'].includes(schedule.status)) ||
    s.teams.some((item) => item.messages.some((message) => message.status && isActive(message.status))))
  const assistantSaving = useAssistant((s) => Object.values(s.saving).some((count) => count > 0))
  const assistantLoading = useAssistant((s) => Object.values(s.loading).some(Boolean))
  const [relinking, setRelinking] = useState(false)
  const [relinkNotice, setRelinkNotice] = useState('')
  const [name, setName] = useState(team?.name || '')
  const [goal, setGoal] = useState(team?.goal || '')
  const [directoryMode, setDirectoryMode] = useState<'existing' | 'new'>('existing')
  const [directoryPath, setDirectoryPath] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [folderName, setFolderName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const defaultProvider = useCollaboration((s) => s.defaultProvider)
  const modelDefaults = useCollaboration((s) => s.modelDefaults)
  const choice = team?.members.find((m) => m.isLead) || modelDefaults[defaultProvider]
  const kind = team?.kind === 'conversation' ? '对话' : '项目'
  const isProject = kind === '项目'
  const needsDirectory = isProject && !savedTeam?.directory
  const newFolderName = (folderName ?? name).trim()
  const directoryReady = !needsDirectory || (directoryMode === 'existing'
    ? isAbsoluteDirectory(directoryPath.trim())
    : isAbsoluteDirectory(parentPath.trim()) && isValidDirectoryName(newFolderName))
  const dismiss = () => { if (!busy.current && !relinking) close() }
  const pickDirectory = async () => {
    if (busy.current || typeof window.grok?.pickFolder !== 'function') return
    busy.current = true
    setPicking(true)
    setError('')
    try {
      const selected = await window.grok.pickFolder()
      if (!selected || !mounted.current) return
      if (directoryMode === 'new') setParentPath(selected)
      else {
        setDirectoryPath(selected)
        if (!name.trim()) setName((selected.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || selected).slice(0, 80))
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '选择目录失败，请重试。')
    } finally {
      busy.current = false
      if (mounted.current) setPicking(false)
    }
  }
  const submit = async () => {
    const generation = currentWorkspaceGeneration()
    if (busy.current || relinking || !name.trim() || !directoryReady) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const directory = needsDirectory ? await runtimeClient.prepareDirectory(directoryMode === 'existing'
        ? { mode: 'existing', path: directoryPath.trim() }
        : { mode: 'new', parent: parentPath.trim(), name: newFolderName }) : useCollaboration.getState().teams.find((item) => item.id === team?.id)?.directory
      if (!mounted.current || generation !== currentWorkspaceGeneration()) return
      if (team)
        useCollaboration.getState().updateTeam(team.id, name.trim(), goal.trim(), team.members, directory)
      else
        useCollaboration.getState().createWorkspace('project', name.trim(), goal.trim(), undefined, directory)
      close()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '创建项目失败，请重试。')
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }
  return (<>
    <WorkspaceDialog
      title={team ? `编辑${kind}` : '新建项目'}
      className="workspace-editor-dialog"
      subtitle={
        team ? '为当前工作补充名称与目标。' : '选择项目目录，为一个长期目标建立空间。'
      }
      close={dismiss}
      closeDisabled={relinking}
    >
      <form
        className="ws-form workspace-editor-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="ws-form-fields">
          <label>
            {kind}名称
            <input
              autoFocus
              required
              disabled={saving || picking}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`给${kind}起个名字`}
            />
          </label>
          {isProject && (
            <section className="project-directory-fields" aria-label="项目目录设置">
              {needsDirectory ? (
                <>
                  <div className="project-directory-modes" role="group" aria-label="项目目录方式">
                    <button type="button" aria-pressed={directoryMode === 'existing'} disabled={saving || picking}
                      onClick={() => { setDirectoryMode('existing'); setError('') }}>
                      <FolderOpen size={14} />选择已有目录
                    </button>
                    <button type="button" aria-pressed={directoryMode === 'new'} disabled={saving || picking}
                      onClick={() => { setDirectoryMode('new'); setError('') }}>
                      <FolderPlus size={14} />创建新目录
                    </button>
                  </div>
                  <label htmlFor="project-directory-path">{directoryMode === 'existing' ? '项目目录' : '保存位置'}</label>
                  <div className="project-directory-picker">
                    <input id="project-directory-path" required disabled={saving || picking} maxLength={32768}
                      value={directoryMode === 'existing' ? directoryPath : parentPath}
                      placeholder={directoryMode === 'existing' ? '选择或输入项目目录的完整路径' : '选择新文件夹的上级目录'}
                      onChange={(e) => {
                        if (directoryMode === 'existing') setDirectoryPath(e.target.value)
                        else setParentPath(e.target.value)
                        setError('')
                      }} />
                    {typeof window.grok?.pickFolder === 'function' && (
                      <button type="button" className="ws-button" disabled={saving || picking} onClick={() => void pickDirectory()}>
                        <FolderOpen size={14} />{picking ? '选择中…' : '浏览…'}
                      </button>
                    )}
                  </div>
                  {directoryMode === 'new' && (
                    <>
                      <label htmlFor="project-folder-name">文件夹名称</label>
                      <input id="project-folder-name" required disabled={saving || picking} maxLength={100}
                        value={folderName ?? name} placeholder="默认使用项目名称"
                        aria-invalid={!!newFolderName && !isValidDirectoryName(newFolderName)}
                        onChange={(e) => { setFolderName(e.target.value); setError('') }} />
                      {newFolderName && !isValidDirectoryName(newFolderName) && (
                        <p className="ws-error" role="alert">请使用有效的文件夹名称，不包含路径分隔符、特殊字符或系统保留名称。</p>
                      )}
                      {parentPath.trim() && newFolderName && (
                        <p className="project-directory-preview">将创建：<span>{projectDirectoryPreview(parentPath.trim(), newFolderName)}</span></p>
                      )}
                    </>
                  )}
                  <p className="ws-form-note">
                    项目及其下的对话将在此目录中工作。{directoryMode === 'new' ? '点击保存时创建文件夹。' : ''}
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor="saved-project-directory">项目目录</label>
                  <input id="saved-project-directory" readOnly value={savedTeam!.directory} />
                  <p className="ws-form-note">项目及其下的对话共用此目录。</p>
                  {typeof window.grok?.projectRelink?.prepare === 'function' && <div className="project-directory-relink">
                    <button type="button" className="ws-button" disabled={saving || picking || running || assistantSaving || assistantLoading}
                      onClick={() => { setRelinkNotice(''); setRelinking(true) }}>
                      <FolderOpen size={14} />重新关联目录…
                    </button>
                    <p className="ws-form-note">恢复备份后，可重新选择本机的源码目录。</p>
                    {(running || assistantSaving || assistantLoading) && <p className="ws-form-note" role="status">请等待执行和助手资料读写结束后再关联目录。</p>}
                  </div>}
                </>
              )}
            </section>
          )}
          <label>
            {kind}目标
            <textarea
              rows={3}
              disabled={saving || picking}
              maxLength={2000}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="描述你希望完成什么，以及需要关注的约束"
            />
          </label>
          <div className="workspace-model-note">
            <ProviderMark id={team?.defaultProvider || defaultProvider} small />
            <span>
              {team ? '当前主 agent' : '默认模型'} ·{' '}
              {PROVIDERS[team?.defaultProvider || defaultProvider].name}
              {choice?.model ? ` · ${choice.model}` : ''}
              {choice?.effort ? ` · ${EFFORT_LABELS[choice.effort] || choice.effort}` : ''}
            </span>
          </div>
          <p className="ws-form-note">
            {team
              ? '员工的模型、职责与人格可在员工详情中编辑。'
              : '创建后可以直接使用主 agent，也可以添加员工。'}
          </p>
          {error && <p className="ws-error" role="alert">{error}</p>}
          {relinkNotice && <p className="ws-form-note project-relink-notice" role="status">{relinkNotice}</p>}
        </div>
        <footer>
          <button type="button" className="ws-button" disabled={saving || picking} onClick={dismiss}>
            取消
          </button>
          <button className="ws-button accent" disabled={!name.trim() || !directoryReady || saving || picking}>
            {saving ? '保存中…' : team ? '保存更改' : '创建项目'}
          </button>
        </footer>
      </form>
    </WorkspaceDialog>
    {relinking && savedTeam?.directory && <ProjectRelinkDialog projectId={savedTeam.id} projectName={savedTeam.name} directory={savedTeam.directory}
      conversations={relatedConversations} close={() => setRelinking(false)} completed={(message) => { setRelinkNotice(message); setRelinking(false) }} />}
  </>)
}

export function EmployeeEditor({
  team,
  employee,
  close
}: {
  team: Team
  employee?: Member
  close: () => void
}) {
  const [draft, setDraft] = useState<Member>(
    employee
      ? { ...employee }
      : {
          id: makeId('employee'),
          name: '',
          provider: team.defaultProvider,
          model: team.members.find((m) => m.isLead)?.model,
          effort: team.members.find((m) => m.isLead)?.effort,
          role: '',
          persona: '',
          isLead: false
        }
  )
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const avatarRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const update = (patch: Partial<Member>) => setDraft((d) => ({ ...d, ...patch }))
  const duplicate = team.members.some(
    (m) => m.id !== draft.id && m.name.trim().toLowerCase() === draft.name.trim().toLowerCase()
  )
  const referenced = !!employee && employeeReferenced(team, employee.id)
  const employeeRuns = useCollaboration((s) => s.runs)
  const executing = Object.values(employeeRuns).some(
    (r) => r.workspaceId === team.id && ['queued', 'running', 'needs_permission'].includes(r.status)
  )
  const importPersona = async (file?: File) => {
    if (!file) return
    setImporting(true)
    setError('')
    try {
      if (file.size > 128 * 1024) throw new Error('人格文件不能超过 128 KB。')
      const persona = parsePersonaFile(file.name, await file.text())
      update({ persona, personaSource: file.name })
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取人格文件失败，请重试。')
    } finally {
      setImporting(false)
    }
  }
  return (
    <WorkspaceDialog
      title={employee ? '编辑员工' : '添加员工'}
      subtitle={`仅配置当前${team.kind === 'project' ? '项目' : '对话'}「${team.name}」的员工。`}
      close={close}
    >
      <form
        className="ws-form employee-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.name.trim() || !draft.role.trim() || duplicate || importing || avatarLoading) return
          useCollaboration.getState().saveEmployee(team.id, {
            ...draft,
            name: draft.name.trim(),
            role: draft.role.trim(),
            persona: draft.persona.trim()
          })
          close()
        }}
      >
        <div className="employee-avatar-setting">
          <AgentAvatar member={draft} />
          <div><strong>Agent 头像</strong><p className="ws-form-note">PNG、JPEG 或 WebP，自动居中裁剪。</p>
            <button type="button" className="ws-button" disabled={avatarLoading} onClick={() => avatarRef.current?.click()}><Upload size={14} />{avatarLoading ? '处理中…' : '上传头像'}</button>
            {draft.avatar && <button type="button" className="text-button" disabled={avatarLoading} onClick={() => update({ avatar: undefined })}>恢复默认</button>}
          </div>
          <input ref={avatarRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="选择 Agent 头像" onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            setAvatarLoading(true); setError('')
            try { update({ avatar: await avatarFromFile(file) }) }
            catch (error) { setError(error instanceof Error ? error.message : '头像读取失败。') }
            finally { setAvatarLoading(false) }
          }} />
        </div>
        <div className="ws-form-pair">
          <label>
            员工名称
            <input
              autoFocus
              required
              maxLength={48}
              value={draft.name}
              placeholder="自定义员工名称"
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label>
            使用模型
            <select
              value={draft.provider}
              onChange={(e) =>
                update({
                  provider: e.target.value as Provider,
                  model: undefined,
                  effort: undefined,
                  ...useCollaboration.getState().modelDefaults[e.target.value as Provider]
                })
              }
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {duplicate && (
          <p className="ws-error" role="alert">
            当前空间已有同名员工，请使用其他名称。
          </p>
        )}
        <ModelPicker
          provider={draft.provider}
          value={draft}
          onChange={(choice) => update(choice)}
        />
        <p className="employee-hint">同一个模型可以分配给多名员工，每位员工独立保存配置。</p>
        <label>
          职责
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={draft.role}
            placeholder="负责什么、交付什么，以及如何与其他员工配合"
            onChange={(e) => update({ role: e.target.value })}
          />
        </label>
        <div className="ws-section-heading">
          <h3>
            人格设定 <span className="optional-label">可选</span>
          </h3>
          <button
            type="button"
            className="ws-button"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={13} />
            {importing ? '导入中…' : '导入人格'}
          </button>
        </div>
        <input
          type="file"
          hidden
          ref={fileRef}
          accept=".md,.txt,.json"
          onChange={(e) => {
            void importPersona(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <label className="persona-label">
          <span>行为方式、语气与参考角色</span>
          <textarea
            rows={5}
            maxLength={20000}
            value={draft.persona}
            placeholder="描述员工如何思考、沟通与行动；也可以写下希望参考的角色或人物特征。"
            onChange={(e) => update({ persona: e.target.value, personaSource: undefined })}
          />
        </label>
        <p className="employee-hint">
          支持 .md / .txt / .json，最大 128 KB。导入会替换编辑框内容，保存后生效。
        </p>
        {draft.personaSource && <p className="persona-source">已导入：{draft.personaSource}</p>}
        {error && (
          <p className="ws-error" role="alert">
            {error}
          </p>
        )}
        <details className="persona-format">
          <summary>JSON 文件格式</summary>
          <pre>
            {
              '{\n  "character": "参考角色或人物特征",\n  "behavior": "行为方式",\n  "tone": "语气",\n  "persona": "其他人格描述"\n}'
            }
          </pre>
        </details>
        {employee?.isLead && (
          <p className="ws-form-note">
            这是当前空间的主 agent，负责默认接收消息。修改其模型不会改变全局默认模型。
          </p>
        )}
        {referenced && !employee?.isLead && (
          <p className="ws-form-note">该员工已有消息、任务或成果记录，可以编辑，但不能移除。</p>
        )}
        <footer>
          {employee && !employee.isLead && (
            <button
              type="button"
              className="ws-button remove-employee"
              disabled={referenced || executing}
              onClick={() => {
                useCollaboration.getState().removeEmployee(team.id, employee.id)
                close()
              }}
            >
              移除员工
            </button>
          )}
          <button type="button" className="ws-button" onClick={close}>
            取消
          </button>
          <button
            className="ws-button accent"
            disabled={!draft.name.trim() || !draft.role.trim() || duplicate || importing || avatarLoading}
          >
            {employee ? '保存更改' : '添加员工'}
          </button>
        </footer>
      </form>
    </WorkspaceDialog>
  )
}

export function TaskEditor({
  team,
  task,
  close,
  onExecute
}: {
  team: Team
  task?: TeamTask
  close: () => void
  onExecute?: () => void
}) {
  const [draft, setDraft] = useState<TeamTask>(
    task
      ? { ...task }
      : {
          id: makeId('task'),
          title: '',
          description: '',
          owner: team.members[0].id,
          state: 'ready',
          dependency: null,
          acceptance: ''
        }
  )
  const update = (patch: Partial<TeamTask>) => setDraft((d) => ({ ...d, ...patch }))
  const dependencies = taskDependencies(draft)
  const cycle = hasDependencyCycle(team.tasks, draft.id, draft.dependency, draft.managedDependencies || [])
  const runs = useCollaboration((s) => s.runs)
  const saveError = useCollaboration((s) => s.runtimeError)
  const busy = Object.values(runs).some(
    (r) => r.workspaceId === team.id && ['queued', 'running', 'needs_permission'].includes(r.status)
  )
  const blocked =
    dependencies
      .some((id) => team.tasks.find((t) => t.id === id)?.state !== 'done')
  return (
    <WorkspaceDialog
      title={task ? '任务详情' : '新建任务'}
      subtitle="明确负责人、前置任务与验收标准。"
      close={close}
    >
      {saveError && <p className="ws-error" role="alert">{saveError}</p>}
      <form
        className="ws-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.title.trim() || cycle) return
          if (!useCollaboration.getState().saveTask(team.id, { ...draft, title: draft.title.trim() })) return
          close()
        }}
      >
        <label>
          任务名称
          <input
            autoFocus
            required
            maxLength={100}
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="需要完成什么？"
          />
        </label>
        <label>
          任务说明
          <textarea
            rows={3}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="补充范围与必要的上下文"
          />
        </label>
        <div className="ws-form-pair">
          <label>
            负责人
            <select value={draft.owner} onChange={(e) => update({ owner: e.target.value })}>
              {team.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {PROVIDERS[m.provider].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            规划状态
            <select
              value={draft.state}
              onChange={(e) => update({ state: e.target.value as TeamTask['state'] })}
            >
              {Object.entries(TASK_STATES).map(([key, value]) => (
                <option value={key} key={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="member-editor" role="group" aria-label="前置任务">
          <span className="ws-form-note">前置任务</span>
          {team.tasks.filter((item) => item.id !== draft.id).map((item) => (
            <div key={item.id}>
              <label>
                <input type="checkbox" checked={dependencies.includes(item.id)} onChange={(event) => {
                  const next = event.target.checked ? [...dependencies, item.id] : dependencies.filter((id) => id !== item.id)
                  update({ dependency: next[0] || null, managedDependencies: next })
                }} />
                <strong>{item.title}</strong>
              </label>
            </div>
          ))}
          {!team.tasks.some((item) => item.id !== draft.id) && <span className="ws-form-note">暂无其他任务</span>}
        </div>
        {cycle && (
          <p className="ws-error" role="alert">
            任务依赖形成了循环，请选择其他前置任务。
          </p>
        )}
        {draft.dependencyError && <p className="ws-error" role="alert">{draft.dependencyError}</p>}
        <label>
          验收标准
          <textarea
            rows={2}
            maxLength={1000}
            value={draft.acceptance}
            onChange={(e) => update({ acceptance: e.target.value })}
            placeholder="如何判断这项任务完成了？"
          />
        </label>
        {draft.managedRunId && <p className="ws-form-note">
          主 agent 调度任务。{draft.reviewNote ? `检查记录：${draft.reviewNote}` : '执行后由主 agent 检查并继续调度。'}
        </p>}
        <p className="ws-form-note">
          交给负责人执行后，回复会出现在当前对话中。完成后进入待评审，由你确认验收。
          修改任务范围、负责人或验收标准后，本任务及依赖它的后续任务需要重新执行；已有调度会暂停。
          {blocked ? '请先完成前置任务。' : ''}
        </p>
        <footer>
          <button type="button" className="ws-button" onClick={close}>
            取消
          </button>
          <button className="ws-button accent" disabled={!draft.title.trim() || cycle}>
            保存任务
          </button>
          <button
            type="button"
            className="ws-button accent"
            disabled={!draft.title.trim() || cycle || busy || blocked}
            onClick={() => {
              const state = useCollaboration.getState()
              if (!state.saveTask(team.id, { ...draft, state: 'ready', title: draft.title.trim() })) return
              void state.executeTask(team.id, draft.id)
              onExecute?.()
              close()
            }}
          >
            交给负责人执行
          </button>
        </footer>
      </form>
    </WorkspaceDialog>
  )
}

export function ArtifactPreview({
  artifact,
  ownerName,
  close
}: {
  ownerName: string
  artifact: TeamArtifact
  close: () => void
}) {
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([artifact.content], { type: 'text/plain;charset=utf-8' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.name
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <WorkspaceDialog
      title={artifact.name}
      subtitle={`${ownerName} · v${artifact.version} · ${artifact.sample ? '示例成果' : '本地文件'}`}
      close={close}
      wide
    >
      <div className="artifact-preview">
        {artifact.format === 'md' ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={{
              img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
              a: ({ children }) => <span>{children}</span>
            }}
          >
            {artifact.content}
          </ReactMarkdown>
        ) : (
          <pre>{artifact.content}</pre>
        )}
      </div>
      <footer>
        <button className="ws-button" onClick={download}>
          <Download size={14} />
          下载文件
        </button>
        <button className="ws-button accent" onClick={close}>
          完成
        </button>
      </footer>
    </WorkspaceDialog>
  )
}
