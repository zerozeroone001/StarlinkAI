// Isolated UI fixture: real file panel, deterministic IPC replacement, no model or user files.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RightPane } from '../src/renderer/src/components/RightPane'
import { useApp } from '../src/renderer/src/stores/app'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import '../src/renderer/src/styles.css'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const root = 'C:/fixture'
let version = 1
const directories = ['src', 'components', 'nested', 'deeper']
const nodes = (cwd: string) => {
  const depth = cwd.slice(root.length).split('/').filter(Boolean).length
  const name = directories[depth] || 'actual.txt'
  return [{ path: `${cwd}/${name}`, name, dir: depth < directories.length }]
}
let recordRead = (_path: string) => {}
Object.assign(window, { grok: {
  tree: async (cwd: string) => { recordRead(cwd); return nodes(cwd) },
  git: async () => { version++; return null },
  previewFile: async (file: string) => ({ path: file, name: 'actual.txt', kind: 'text', ext: 'txt', size: 12, mime: 'text/plain', text: `file version ${version}` })
} })
useApp.setState({ cwd: root, tree: nodes(root), git: null, rightTab: 'files', rightWidth: 540, preview: null, previewPath: null, locale: 'zh-CN' })
function Fixture() {
  const [reads, setReads] = useState<string[]>([])
  recordRead = (cwd) => setReads((items) => [...items, cwd])
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 540px', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
    <main style={{ padding: 24 }}><h1>项目文件按需加载验收</h1><p>目录读取次数：{reads.length}</p>
      <p>依次展开至 actual.txt，预览后刷新，应显示 file version 2。</p><pre>{reads.join('\n')}</pre></main>
    <RightPane />
  </div>
}
document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture />)
