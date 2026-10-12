import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Plus, RefreshCw, Sparkles } from 'lucide-react'
import type { SkillInfo, SkillScope } from '@shared/types'
import { useApp } from '@/stores/app'
import { useT } from '@/lib/i18n'
import { skillBlurb } from '@/lib/skill-i18n'
import { runtimeClient } from '@/lib/runtime-client'
import { useCollaboration } from '@/stores/collaboration'
import { teamDirectory } from '@/lib/collaboration-data'

const SOURCE_KEY = {
  local: 'skills.local',
  repo: 'skills.repo',
  user: 'skills.user',
  bundled: 'skills.bundled',
  compat: 'skills.compat'
} as const

export function SkillsPanel() {
  const workspaceId = useCollaboration(s => s.activeTeamId)
  const surface = useCollaboration(s => s.surface)
  const directory = useCollaboration(s => teamDirectory(s.teams, s.activeTeamId))
  const t = useT()
  const {
    skills,
    loadSkills,
    setSkillDisabled,
    createSkill,
    runSkill,
    cwd,
    locale,
    error: appError
  } = useApp()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<SkillScope>(surface === 'workspace' || cwd ? 'project' : 'user')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    return skills.filter((s) => {
      if (!query) return true
      const blurb = skillBlurb(s, locale).toLowerCase()
      return s.name.includes(query) || s.description.toLowerCase().includes(query) || blurb.includes(query)
    })
  }, [skills, q, locale])

  const active = filtered.find((s) => s.name === selected) || filtered[0] || null
  const [body, setBody] = useState('')

  useEffect(() => {
    if (!active) {
      setBody('')
      return
    }
    let cancelled = false
    setBody('')
    void (surface === 'workspace' ? runtimeClient.readSkill(workspaceId, active.path, directory) : window.grok.skills.read(active.path)).then((full) => {
      if (!cancelled) setBody(full?.body || '')
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '技能读取失败') })
    return () => {
      cancelled = true
    }
  }, [active?.path, workspaceId, surface, directory])

  const create = async () => {
    setBusy(true)
    setError(null)
    let res
    try { res = await createSkill({ name, description, scope }) }
    catch (e) { setBusy(false); setError(e instanceof Error ? e.message : '创建失败'); return }
    setBusy(false)
    if (!res.ok) {
      setError(
        res.error === 'invalid_name'
          ? t('skills.invalidName')
          : res.error === 'exists'
            ? t('skills.exists')
            : res.error === 'no_project'
              ? t('skills.noProject')
              : t('skills.writeFailed')
      )
      return
    }
    setCreating(false)
    setName('')
    setDescription('')
    setSelected(res.skill.name)
  }

  return (
    <div className="skills-panel">
        <div className="skills-head">
          <div className="skills-head-copy">
            <div className="settings-section-title">{t('skills.library')}</div>
            <div className="settings-field-hint">{t('skills.hint')}</div>
          </div>
          <div className="skills-head-actions">
            <button
              type="button"
              className="ghost-mini"
              onClick={() => void loadSkills()}
              title={t('skills.reload')}
            >
              <RefreshCw size={13} /> {t('skills.reload')}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setCreating((v) => !v)
                setError(null)
              }}
            >
              <Plus size={13} /> {t('skills.new')}
            </button>
          </div>
        </div>
        <input
          className="skills-search"
          aria-label="搜索技能"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('skills.search')}
        />
        {creating ? (
          <div className="skills-create">
            <input
              aria-label="技能名称"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t('skills.name')}
            />
            <textarea
              aria-label="技能说明"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('skills.description')}
              rows={3}
            />
            <div className="skills-create-row">
              <select value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
                <option value="project">{t('skills.scopeProject')}</option>
                <option value="user">{t('skills.scopeUser')}</option>
              </select>
              <button className="primary" disabled={busy} type="button" onClick={() => void create()}>
                {t('skills.create')}
              </button>
            </div>
            {error ? <div className="settings-error">{error}</div> : null}
          </div>
        ) : null}
        {(error || appError) && !creating && <p className="settings-error" role="status">{error || appError}</p>}
        <div className="skills-layout">
          <div className="skills-list">
            {filtered.length ? (
              filtered.map((s) => (
                <button
                  type="button"
                  key={s.path}
                  className={'skill-row' + (active?.name === s.name ? ' on' : '') + (s.disabled ? ' off' : '')}
                  onClick={() => setSelected(s.name)}
                >
                  <Sparkles size={13} />
                  <span className="skill-copy">
                    <span className="skill-name">/{s.name}</span>
                    <span className="skill-blurb">{skillBlurb(s, locale)}</span>
                  </span>
                  <span className="badge">{t(SOURCE_KEY[s.source])}</span>
                </button>
              ))
            ) : (
              <div className="skills-empty">{t('skills.empty')}</div>
            )}
          </div>
          <div className="skills-detail">
            {active ? (
              <SkillDetail
                skill={active}
                body={body}
                locale={locale}
                onRun={() => runSkill(active)}
                onOpen={() => { if (window.grok) void window.grok.openPath(active.path); else void navigator.clipboard.writeText(active.path).then(() => setError('技能路径已复制，可在本机编辑器中打开。')).catch(() => setError(active.path)) }}
                onToggle={() => void setSkillDisabled(active.name, !active.disabled).catch(e => setError(e instanceof Error ? e.message : '更新失败'))}
              />
            ) : (
              <div className="skills-empty">{t('skills.none')}</div>
            )}
          </div>
        </div>
    </div>
  )
}

export function SkillsModal() {
  const { skillsOpen, setSkillsOpen } = useApp()
  if (!skillsOpen) return null
  return (
    <div className="overlay" onClick={() => setSkillsOpen(false)}>
      <div className="modal skills-modal" onClick={(e) => e.stopPropagation()}>
        <SkillsPanel />
      </div>
    </div>
  )
}

function SkillDetail({
  skill,
  body,
  locale,
  onRun,
  onOpen,
  onToggle
}: {
  skill: SkillInfo
  body: string
  locale: 'en' | 'zh-CN'
  onRun: () => void
  onOpen: () => void
  onToggle: () => void
}) {
  const t = useT()
  return (
    <>
      <div className="skills-detail-title">/{skill.name}</div>
      <div className="skills-detail-desc">{skillBlurb(skill, locale) || t('skills.none')}</div>
      <div className="skills-detail-meta">
        <span className="badge">{t(SOURCE_KEY[skill.source])}</span>
        {skill.disabled ? <span className="badge">{t('skills.disabled')}</span> : null}
        {skill.argumentHint ? <span className="meta">{skill.argumentHint}</span> : null}
      </div>
      <div className="skills-detail-actions">
        <button className="primary" type="button" disabled={skill.disabled || !skill.userInvocable} onClick={onRun}>
          {useCollaboration.getState().surface === 'workspace' ? '插入草稿' : t('skills.run')}
        </button>
        <button className="secondary" type="button" onClick={onOpen}>
          <FolderOpen size={13} /> {window.grok ? t('skills.open') : '复制路径'}
        </button>
        <button className="ghost-mini" type="button" onClick={onToggle}>
          {skill.disabled ? t('skills.enable') : t('skills.disable')}
        </button>
      </div>
      {body ? <pre className="skills-body">{body.slice(0, 4000)}</pre> : null}
    </>
  )
}
