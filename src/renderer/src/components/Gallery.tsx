import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, Images, Search, Square, RotateCcw, ArrowUp, SlidersHorizontal, LayoutGrid, Grid3X3, Plus, Pencil, Trash2, X, LoaderCircle } from 'lucide-react'
import { useCollaboration, isActive, resumeRuns } from '@/stores/collaboration'
import { useApp } from '@/stores/app'
import { collectGalleryImages, groupGalleryImages, type GalleryImage } from '@/lib/gallery'
import { PROVIDERS, PROVIDER_IDS, type Provider } from '@/lib/collaboration-data'
import { ResolvedImage } from './Markdown'
import { PermissionMessage } from './PermissionMessage'
import { handleComposerEnter } from '@/lib/composer-keyboard'
import { WorkspaceExportButton } from './WorkspaceDataSettings'
import './gallery.css'

function GalleryCard({ item, reuse, edit, remove, selecting, selected, toggle }: {
  item: GalleryImage; reuse: (item: GalleryImage) => void; edit: (item: GalleryImage) => void
  remove: (item: GalleryImage) => void; selecting: boolean; selected: boolean; toggle: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '400px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return <article className={`gallery-card${selected ? ' is-selected' : ''}`} ref={ref}>
    <div className="gallery-card-visual">
    <span className="gallery-provider-badge">{PROVIDERS[item.provider].name}</span>
    {selecting && <label className="gallery-select"><input type="checkbox" aria-label={`选择图片：${item.prompt}`} checked={selected} onChange={toggle} /></label>}
    {visible ? <ResolvedImage src={item.image.dataUrl || item.image.path} alt={item.image.alt || item.prompt}
      cwd={item.cwd} sessionId={item.sessionId} workspaceId={item.workspaceId} className="gallery-image" />
      : <div className="gallery-placeholder" />}
      {!selecting && <>
      <div className="gallery-card-actions">
        <button type="button" title="复用提示词" aria-label="复用提示词" onClick={() => reuse(item)}><RotateCcw size={15} /></button>
        {!item.isGallery && <button type="button" title={`打开对话：${item.workspaceName}`} aria-label={`打开对话：${item.workspaceName}`} onClick={() => useCollaboration.getState().navigate('team', item.workspaceId)}><ArrowUpRight size={16} /></button>}
        <button type="button" title="从画廊删除" aria-label="从画廊删除" onClick={() => remove(item)}><Trash2 size={14} /></button>
      </div>
      <button type="button" className="gallery-card-edit" title="编辑图片" aria-label="编辑图片" onClick={() => edit(item)}><Pencil size={16} /></button>
      </>}
    </div>
  </article>
}

export function Gallery() {
  const { teams, runs, defaultProvider, generateImages, answerPermission, stop, stoppingRuns, connectionErrors, runtimeError, storageError, deletedGalleryKeys, deleteGalleryImages, restoreGalleryImages } = useCollaboration()
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState<Provider>(defaultProvider)
  const [ratio, setRatio] = useState('2:3')
  const [count, setCount] = useState(4)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [dense, setDense] = useState(false)
  const [limit, setLimit] = useState(40)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [references, setReferences] = useState<GalleryImage[]>([])
  const [undoKeys, setUndoKeys] = useState<string[]>([])
  const [deletedCount, setDeletedCount] = useState(0)
  const [progress, setProgress] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const pageRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const submitLock = useRef(false)
  useEffect(() => { resumeRuns() }, [])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      pageRef.current?.style.setProperty('--gallery-dock-height', `${entry.target.getBoundingClientRect().height}px`)
    })
    if (dockRef.current) observer.observe(dockRef.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!promptRef.current) return
    promptRef.current.style.height = 'auto'
    promptRef.current.style.height = `${Math.min(120, promptRef.current.scrollHeight)}px`
  }, [prompt])
  const images = useMemo(() => collectGalleryImages(teams, runs, deletedGalleryKeys), [teams, runs, deletedGalleryKeys])
  const focusComposer = () => promptRef.current?.focus()
  const filtered = useMemo(() => images.filter((item) =>
    (filter === 'all' || item.provider === filter) &&
    `${item.prompt} ${item.workspaceName} ${item.image.alt || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [images, filter, query])
  useEffect(() => { setLimit(40) }, [query, filter])
  useEffect(() => { setSelected((ids) => ids.filter((id) => filtered.some((item) => item.id === id))) }, [filtered])
  const selectedImages = filtered.filter((item) => selected.includes(item.id))
  const remove = (items: GalleryImage[]) => {
    setUndoKeys([...new Set(items.flatMap((item) => item.keys))].filter((key) => !deletedGalleryKeys.includes(key)))
    setDeletedCount(items.length); deleteGalleryImages(items); setSelected([])
  }
  const edit = (items: GalleryImage[]) => {
    if (submitting || !items.length) return
    setReferences(items); setPrompt(''); setProvider(items[0].provider); setRatio('auto'); setCount(1); setError('')
    focusComposer()
  }
  const jobs = useMemo(() => teams.filter((t) => t.gallery).slice().reverse().map((team) => ({ team,
    run: Object.values(runs).filter((r) => r.workspaceId === team.id).at(-1),
    message: team.messages.at(-1),
    generated: collectGalleryImages([team], runs).length
  })), [teams, runs])
  const groups = groupGalleryImages(filtered.slice(0, limit))
  for (const job of jobs) {
    const settings = job.team.gallery!
    const matches = (filter === 'all' || job.team.defaultProvider === filter) &&
      `${settings.prompt} ${job.team.name}`.toLowerCase().includes(query.trim().toLowerCase())
    if (matches && !groups.some((group) => group.workspaceId === job.team.id) &&
      (isActive(job.run?.status || job.message?.status || 'queued') || !job.generated)) {
      groups.push({ id: JSON.stringify([job.team.id, settings.prompt]), workspaceId: job.team.id,
        prompt: settings.prompt, createdAt: settings.createdAt, images: [] })
    }
  }
  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const submit = async () => {
    if (!prompt.trim() || submitLock.current) return
    submitLock.current = true
    setSubmitting(true); setError(''); setQuery(''); setFilter('all')
    scrollRef.current?.scrollTo({ top: 0 })
    try {
      if (references.length) {
        const pending = [...references]
        for (let index = 0; index < references.length; index++) {
          setProgress(`提交编辑 ${index + 1}/${references.length}`)
          await generateImages(prompt, provider, ratio, 1, references[index])
          pending.shift(); setReferences([...pending])
        }
        setSelected([]); setSelecting(false)
      } else await generateImages(prompt, provider, ratio, count)
      setPrompt('')
    }
    catch (e) { setError(e instanceof Error ? e.message : '生成失败，请重试。') }
    finally { submitLock.current = false; setSubmitting(false); setProgress('') }
  }
  const reuse = (item: GalleryImage) => {
    if (submitting) return
    setReferences([])
    setPrompt(item.prompt.slice(0, 6000)); setProvider(item.provider)
    const settings = teams.find((t) => t.id === item.workspaceId)?.gallery
    if (settings) { setRatio(settings.ratio); setCount(settings.count) }
    focusComposer()
  }
  const inspiration = [
    { name: '电影感', prompt: '雨后的东京街头，霓虹灯倒映在积水中，电影镜头，细腻胶片颗粒，冷暖光影交织。' },
    { name: '自然风景', prompt: '晨雾中的山间湖泊，远山层叠，松林倒映在平静水面，柔和的日出光线，自然摄影。' },
    { name: '产品摄影', prompt: '一瓶香水置于浅色石台上，树叶投下柔和光影，极简构图，精致玻璃质感，商业产品摄影。' }
  ]
  return <main className="gallery-page" ref={pageRef}>
    <header className="workspace-titlebar gallery-titlebar drag">
      <div><Images size={17} /><strong>画廊</strong><span className="gallery-total">{images.length} 张作品</span></div>
      <button type="button" className="gallery-create no-drag" onClick={focusComposer}><Plus size={16} />创作图片</button>
    </header>
    <div className="gallery-scroll" ref={scrollRef}>
      {(error || runtimeError) && <p className="ws-error" role="alert">{error || runtimeError}</p>}
      {storageError && <p className="ws-error" role="alert">本地存储写入失败，新生成的图片记录尚未保存。
        <button type="button" className="text-button" onClick={() => useCollaboration.getState().retryStorage()}>重试保存</button>
        <WorkspaceExportButton className="text-button" /></p>}
      <div className="gallery-toolbar"><h1>全部作品 <span>{filtered.length}</span></h1><div className="gallery-toolbar-controls">
        <label className="gallery-search"><Search size={15} /><input aria-label="搜索画廊" placeholder="搜索作品…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <select aria-label="筛选模型服务" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部服务</option>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDERS[id].name}</option>)}</select>
        <div className="gallery-density" role="group" aria-label="图片排列密度"><button type="button" aria-label="舒适排列" title="舒适排列" aria-pressed={!dense} onClick={() => setDense(false)}><LayoutGrid size={15} /></button><button type="button" aria-label="紧凑排列" title="紧凑排列" aria-pressed={dense} onClick={() => setDense(true)}><Grid3X3 size={15} /></button></div>
        <button type="button" className={`secondary gallery-batch-toggle${selecting ? ' is-active' : ''}`} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected([]) }}>{selecting ? '完成选择' : '选择'}</button>
      </div></div>
      {selecting && <div className="gallery-batch" aria-label="画廊批量操作"><span>已选择 {selectedImages.length} 张</span><button type="button" className="secondary" onClick={() => setSelected(filtered.map((item) => item.id))} disabled={!filtered.length}>全选筛选结果（{filtered.length}）</button><button type="button" className="secondary" onClick={() => setSelected([])} disabled={!selected.length}>取消选择</button><button type="button" className="secondary" disabled={!selectedImages.length || submitting} onClick={() => edit(selectedImages)}><Pencil size={14} />批量编辑</button><button type="button" className="secondary" disabled={!selectedImages.length} onClick={() => remove(selectedImages)}><Trash2 size={14} />批量删除</button></div>}
      {undoKeys.length > 0 && <div className="gallery-undo" role="status"><span>已从画廊删除 {deletedCount} 张图片，原文件和对话仍保留。</span><button type="button" className="secondary" onClick={() => { restoreGalleryImages(undoKeys); setUndoKeys([]) }}>撤销删除</button><button type="button" className="icon-btn" aria-label="关闭删除提示" onClick={() => setUndoKeys([])}><X size={14} /></button></div>}
      {groups.length ? <><div className={`gallery-collection${dense ? ' is-dense' : ''}`}>{groups.map((group) => {
        const job = jobs.find((job) => job.team.id === group.workspaceId)
        const status = job?.run?.status || job?.message?.status || 'queued'
        const active = !!job && isActive(status)
        const generated = job?.generated || group.images.length
        const expected = job?.team.gallery?.count || 0
        const label = status === 'needs_permission' ? '等待确认' : status === 'failed' ? '生成失败' : status === 'cancelled' ? '已停止' : active ? '正在生成' : generated ? '已生成' : '未返回图片'
        const pending = active ? Math.max(0, expected - generated) : job && !generated ? 1 : 0
        const detail = job && ((job.run && connectionErrors[job.run.id]) || job.run?.error || job.message?.error)
        return <section className="gallery-group" key={group.id} aria-label={group.prompt}>
          <h2 className="gallery-group-heading"><span className="gallery-prompt-tag" title={group.prompt}>{group.prompt}</span>
            {job && (active || !generated || detail) ? <span className="gallery-job-status" role="status">{active && status !== 'needs_permission' && <LoaderCircle size={12} className="gallery-spinner" />}{label}{active && ` · ${generated}/${expected}`}</span> : <span className="gallery-group-count">{group.images.length} 张</span>}
            {active && job?.run && <button type="button" className="gallery-stop" aria-label="停止生成" disabled={stoppingRuns[job.run.id]} onClick={() => void stop(job.run!.id)}><Square size={11} />停止</button>}
          </h2>
          {detail && <p className="ws-error" role="alert">{detail}</p>}
          {active && job?.run?.permissions.map((permission) => <PermissionMessage key={permission.id}
            permission={{ ...permission, createdAt: job.run!.createdAt, status: 'pending' }} pending
            onAnswer={(option) => answerPermission(job.run!.id, permission.id, option)} />)}
          <div className="gallery-grid">
            {group.images.map((item) => <GalleryCard key={item.id} item={item} reuse={reuse} edit={(image) => edit([image])} remove={(image) => remove([image])} selecting={selecting} selected={selected.includes(item.id)} toggle={() => setSelected((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])} />)}
            {Array.from({ length: pending }, (_, index) => <div key={`pending-${index}`} className={`gallery-generating${active && status !== 'needs_permission' ? ' is-running' : ''}`} role="img" aria-label={`${label}：第 ${generated + index + 1} 张图片`}
              style={{ aspectRatio: job?.team.gallery?.ratio === 'auto' ? '2 / 3' : job?.team.gallery?.ratio.replace(':', ' / '), '--preview-index': index } as CSSProperties}>
              <div className="gallery-generating-colors" /><div className="gallery-generating-dots" />{!active && <span className="gallery-generating-label">{label}</span>}
            </div>)}
          </div>
          {job && !active && !generated && <details className="gallery-job-details"><summary>查看生成详情</summary><p>{job.run?.replies.map((reply) => reply.text).filter(Boolean).join('\n\n') || job.message?.text || detail || '服务没有返回图片。可以调整描述或切换模型服务后重试。'}</p></details>}
        </section>
      })}</div>
        {filtered.length > limit && <button type="button" className="secondary gallery-more" onClick={() => setLimit((n) => n + 40)}>加载更多（剩余 {filtered.length - limit} 张）</button>}</>
        : <div className="gallery-empty"><Images size={36} strokeWidth={1} /><h3>{query || filter !== 'all' ? '没有匹配的图片' : '让想象，成为画面'}</h3><p>{query || filter !== 'all' ? '试试其他关键词，或切换模型服务筛选。' : '在下方描述你的灵感，开始第一次创作。'}</p>{query || filter !== 'all' ? <button type="button" className="secondary" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</button> : <div className="gallery-inspiration">{inspiration.map((idea) => <button type="button" key={idea.name} onClick={() => { setPrompt(idea.prompt); focusComposer() }}>{idea.name}<ArrowUpRight size={11} /></button>)}</div>}</div>}
    </div>
    <div className="gallery-create-panel" ref={dockRef}>
      <form id="gallery-composer" className="gallery-composer" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        {references.length > 0 && <div className="gallery-edit-references"><div className="gallery-reference-strip">{references.map((item) => <ResolvedImage key={item.id} src={item.image.dataUrl || item.image.path} cwd={item.cwd} sessionId={item.sessionId} workspaceId={item.workspaceId} alt={item.prompt} />)}</div><span>编辑 {references.length} 张图片</span><button className="icon-btn" type="button" aria-label="取消编辑" title="取消编辑" disabled={submitting} onClick={() => setReferences([])}><X size={15} /></button></div>}
        <textarea id="gallery-prompt" ref={promptRef} rows={1} value={prompt} maxLength={6000} onChange={(e) => setPrompt(e.target.value)}
          disabled={submitting} aria-label="描述你想创作的画面" placeholder={references.length ? '描述你想修改的内容…' : '输入你的想象'} title="Enter 提交 · Ctrl+Enter 换行"
          onKeyDown={(e) => handleComposerEnter(e, setPrompt, () => void submit())} />
        <div className="gallery-compose-actions">
          <span className="gallery-compose-mode"><Images size={16} />图片</span>
          <select aria-label="生成图片的模型服务" disabled={submitting} value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDERS[id].name}</option>)}</select>
          <button type="button" className="icon-btn gallery-provider-settings" title="配置模型服务" aria-label="配置模型服务" onClick={() => useApp.getState().setSettings(true, 'providers')}><SlidersHorizontal size={16} /></button>
          <div className="gallery-output-options">
            <select aria-label="图片数量" disabled={submitting || references.length > 0} value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 4].map((n) => <option key={n} value={n}>×{n}</option>)}</select>
            <select aria-label="图片比例" title="图片比例以所选服务支持情况为准" disabled={submitting} value={ratio} onChange={(e) => setRatio(e.target.value)}>{['auto', '1:1', '3:2', '2:3', '16:9', '9:16'].map((value) => <option key={value} value={value}>{value === 'auto' ? '自动' : value}</option>)}</select>
          </div>
          <button className="gallery-generate" type="submit" aria-label={references.length ? '开始编辑' : '生成图片'} title={submitting ? progress || '提交中…' : references.length ? '开始编辑' : '生成图片'} disabled={!prompt.trim() || submitting}>{submitting ? <LoaderCircle size={19} className="gallery-spinner" /> : <ArrowUp size={20} />}</button>
        </div>
        {submitting && <span className="gallery-submit-status" role="status">{progress || '正在提交创作…'}</span>}
      </form>
    </div>
  </main>
}
