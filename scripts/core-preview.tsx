// Isolated UI fixture. Uses real scheduling/store/components with deterministic model replies.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborationWorkspace } from '../src/renderer/src/components/CollaborationWorkspace'
import { createWorkspace } from '../src/renderer/src/lib/collaboration-data'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { useProviders } from '../src/renderer/src/stores/providers'
import { useApp } from '../src/renderer/src/stores/app'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import type { RunSnapshot } from '../src/shared/runtime'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/workspace.css'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const team = createWorkspace('project', 'claude', '核心协作验收', '设计 → 实现 → 验证，验收后再进入下一项。')
const ids = ['claude', 'codex', 'grok', 'gemini'] as const
team.members = ids.map((provider, index) => ({ id: provider, name: ['设计员', '实现员', '独立核对员', '验收员'][index],
  provider, role: '执行分配的任务并交接结果', persona: '简洁', isLead: index === 0, model: `${provider}-fixture` }))
team.tasks = [
  { id: 'design', title: '确定接口约束', owner: 'claude', dependency: null },
  { id: 'implementation', title: '实现已验收的接口', owner: 'codex', dependency: 'design' },
  { id: 'independent', title: '独立检查项目约束', owner: 'grok', dependency: null },
  { id: 'review', title: '验证实现结果', owner: 'gemini', dependency: 'implementation' }
].map((task) => ({ ...task, description: '使用前序共享记录，输出可核验的交接。', acceptance: '已阅读前序记录，并说明验证结果。', state: 'ready' }))
useCollaboration.setState({ teams: [team], activeTeamId: team.id, taskSchedules: {}, runs: {},
  drafts: { [team.id]: '这份未发送的草稿应该保留。' }, attachmentDrafts: {}, runtimeError: null, storageError: false })
useApp.setState({ locale: 'zh-CN', rightOpen: true, ready: true })
useProviders.setState({ checked: true, diagnostics: ids.map((id) => ({ id, auth: { signedIn: true }, models: [{ id: `${id}-fixture`, name: id, efforts: [], isDefault: true }] })) as any })
const runs = new Map<string, RunSnapshot>()
runtimeClient.start = async (request) => {
  const snapshot: RunSnapshot = { id: request.id, workspaceId: request.workspaceId, taskId: request.task?.id,
    status: 'running', revision: 1, permissions: [], replies: [], createdAt: new Date().toISOString(), contextTrimmed: false }
  runs.set(snapshot.id, snapshot)
  setTimeout(() => {
    if (snapshot.status === 'cancelled') return
    snapshot.status = 'completed'; snapshot.revision = 2
    snapshot.replies = request.employees.map((employee) => ({ employeeId: employee.id, employeeName: employee.name,
      provider: employee.provider, model: employee.model || '', status: 'completed',
      text: `已执行「${request.task?.title || '对话'}」。\n\n读取了 **${request.context.length} 条共享记录**。交付编号：RESULT-${employee.provider}。\n\n请核对交付并验收，依赖任务会随后继续。` }))
  }, 400)
  return structuredClone(snapshot)
}
runtimeClient.run = async (id) => structuredClone(runs.get(id)!)
runtimeClient.cancel = async (id) => {
  const snapshot = runs.get(id)!
  snapshot.status = 'cancelled'; snapshot.revision = (snapshot.revision || 0) + 1
  return structuredClone(snapshot)
}
document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 540px', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
    <CollaborationWorkspace />
  </div>
)
