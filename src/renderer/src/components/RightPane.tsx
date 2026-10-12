import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  FileCode2,
  Files,
  FileJson,
  FileText,
  Folder,
  GitCompareArrows,
  Image as ImageIcon,
  ListChecks,
  RefreshCw,
  SquareTerminal
} from 'lucide-react'
import type { FileNode } from '@shared/types'
import { extOf, isImagePath, joinPath } from '@/lib/files'
import { useApp } from '@/stores/app'
import { useT } from '@/lib/i18n'
import { DiffView } from './DiffView'
import { FilePreview } from './FilePreview'
import { ColResize } from './ColResize'

function fileIcon(name: string) {
  const ext = extOf(name)
  if (isImagePath(name)) return <ImageIcon size={13} />
  if (ext === 'json' || ext === 'jsonc') return <FileJson size={13} />
  if (['md', 'txt', 'log'].includes(ext)) return <FileText size={13} />
  return <FileCode2 size={13} />
}

function Tree({
  nodes,
  depth = 0,
  onOpen,
  selected
}: {
  nodes: FileNode[]
  depth?: number
  onOpen: (path: string) => void
  selected?: string | null
}) {
  return (
    <>
      {nodes.map((node) => <TreeRow key={node.path} node={node} depth={depth} onOpen={onOpen} selected={selected} />)}
    </>
  )
}

function TreeRow({ node: n, depth, onOpen, selected }: {
  node: FileNode; depth: number; onOpen: (path: string) => void; selected?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileNode[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || !n.dir) return
    let active = true
    setError('')
    const loading = n.children ? Promise.resolve(n.children) : window.grok.tree(n.path)
    void loading.then((value) => { if (active) setChildren(value) }).catch((e) => {
      if (active) {
        setChildren([])
        setError(e instanceof Error ? e.message : '目录读取失败，请重新展开')
      }
    })
    return () => { active = false }
  }, [open, n])
  return (
    <div>
      <button
        className={'file-row' + (selected === n.path ? ' on' : '')}
        style={{ paddingLeft: 10 + depth * 12 }}
        aria-expanded={n.dir ? open : undefined}
        onClick={() => {
          if (n.dir) setOpen((value) => !value)
          else onOpen(n.path)
        }}
      >
        {n.dir ? (
          <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        ) : (
          fileIcon(n.name)
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
      </button>
      {n.dir && open && children ? (
        <Tree nodes={children} depth={depth + 1} onOpen={onOpen} selected={selected} />
      ) : null}
      {open && !children && !error && <div className="file-row" role="status">加载中…</div>}
      {open && error && <div className="ws-error" role="alert">{error}</div>}
    </div>
  )
}

export function RightPane() {
  const {
    rightTab,
    setRightTab,
    git,
    tree,
    plan,
    previewPath,
    preview,
    openPreview,
    closePreview,
    cwd,
    rightWidth,
    setRightWidth
  } = useApp()
  const t = useT()
  const [refreshing, setRefreshing] = useState(false)
  const tabLabel = {
    review: t('pane.review'),
    files: t('pane.files'),
    plan: t('pane.plan'),
    terminal: t('pane.terminal')
  }
  const tabIcon = {
    review: GitCompareArrows,
    files: Files,
    plan: ListChecks,
    terminal: SquareTerminal
  }
  const files = git?.files || []
  const selectedDiff = useMemo(() => git?.diff || '', [git])

  return (
    <aside className="right-pane">
      <ColResize invert value={rightWidth} onChange={setRightWidth} />
      <div className="right-tabs drag">
        {(['review', 'files', 'plan', 'terminal'] as const).map((tab) => {
          const Icon = tabIcon[tab]
          return (
            <button
              key={tab}
              className={rightTab === tab ? 'on no-drag' : 'no-drag'}
              aria-label={tabLabel[tab]}
              aria-pressed={rightTab === tab}
              title={tabLabel[tab]}
              onClick={() => setRightTab(tab)}
            >
              <Icon size={16} strokeWidth={1.8} />
            </button>
          )
        })}
      </div>
      <div className={rightTab === 'files' ? 'right-body fill' : 'right-body'}>
        {rightTab === 'review' ? (
          files.length ? (
            <>
              {files.map((f) => (
                <button
                  key={f.path}
                  className={'file-row' + (previewPath === joinPath(cwd, f.path) ? ' on' : '')}
                  onClick={() => void openPreview(joinPath(cwd, f.path))}
                >
                  <span className={'st ' + f.status.trim()[0]}>{f.status.trim()[0] || 'M'}</span>
                  {isImagePath(f.path) ? <ImageIcon size={13} /> : null}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                </button>
              ))}
              <div style={{ borderTop: '1px solid var(--border)' }}>
                <DiffView raw={selectedDiff} />
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', padding: 16, fontSize: 13 }}>
              {git?.missing ? t('pane.gitMissing') : t('pane.noChanges')}
            </div>
          )
        ) : null}

        {rightTab === 'files' ? (
          <div className="files-pane">
            <FilePreview preview={preview} onClose={preview ? () => closePreview() : undefined} />
            <div className="preview-tree">
              <div className="file-row" style={{ color: 'var(--text-3)' }}>
                <Folder size={14} /> {t('pane.projectFiles')}
                <button className="icon-btn" aria-label="刷新项目文件" disabled={refreshing} onClick={async () => {
                  setRefreshing(true)
                  try { await useApp.getState().refreshWorkspace() } finally { setRefreshing(false) }
                }}><RefreshCw size={13} /></button>
              </div>
              <Tree key={cwd} nodes={tree} selected={previewPath} onOpen={(p) => void openPreview(p)} />
            </div>
          </div>
        ) : null}

        {rightTab === 'plan' ? (
          plan.length ? (
            plan.map((item) => (
              <div key={item.id} className="file-row">
                <span className={'status-dot' + (item.status === 'in_progress' ? ' running' : '')} />
                <span>{item.content}</span>
              </div>
            ))
          ) : (
            <div style={{ color: 'var(--text-3)', padding: 16, fontSize: 13 }}>
              {t('pane.planEmpty')}
            </div>
          )
        ) : null}

        {rightTab === 'terminal' ? (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              padding: 14,
              color: 'var(--text-2)',
              whiteSpace: 'pre-wrap'
            }}
          >
            <div style={{ color: 'var(--text-3)' }}>
              ~/ {cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'project'}
            </div>
            <div>{t('pane.terminalHint')}</div>
            <div style={{ marginTop: 10, color: 'var(--accent)' }}>● {t('pane.agentReady')}</div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
