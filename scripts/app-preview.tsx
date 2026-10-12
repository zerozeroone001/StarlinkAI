// Real app shell and stores; all provider/desktop I/O stays inside this disposable fixture.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../src/renderer/src/App'
import { createWorkspace, isValidTeam } from '../src/renderer/src/lib/collaboration-data'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { useProviders } from '../src/renderer/src/stores/providers'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'
import { BUILTIN_PETS } from '../src/shared/types'
import type { RunRequest, RunSnapshot, RuntimeProvider } from '../src/shared/runtime'
import type { AssistantSnapshot } from '../src/shared/assistant'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/workspace.css'

const image = new URL('/@fs/I:/code/python/grokDeskTop/resources/icon.png', location.href).href
const accountLayoutFixture = new URLSearchParams(location.search).has('account-layout')
const ids = ['claude', 'codex', 'grok', 'gemini'] as const
const diagnostics = ids.map((id) => ({ id, name: id, cli: { state: 'installed', version: 'fixture', path: 'fixture' },
  checkedAt: new Date().toISOString(), usage: null, loginCommand: `${id} login`, auth: {
  signedIn: id !== 'gemini' && !(accountLayoutFixture && id === 'claude'), email: `${id}@example.invalid`, provider: id
}, models: [{ id: `${id}-fixture`, name: `${id} 测试模型`, efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }] })) as unknown as RuntimeProvider[]
const project = createWorkspace('project', 'claude', '跨厂商协作验收项目', '核对完整界面的任务、对话、共享成果与异常恢复。')
project.members = ids.map((provider, index) => ({ id: provider, name: ['方案设计员', '实现与回归验证员', '独立检查员', '成果评审员'][index], provider,
  role: '执行分配的工作并说明实际交付', persona: '清楚表达约束与验证结果', isLead: index === 0, model: `${provider}-fixture`, effort: 'low' }))
project.tasks = [
  { id: 'design', title: '明确接口与验收标准', owner: 'claude', dependency: null },
  { id: 'implement', title: '实现方案并提供验证结果', owner: 'codex', dependency: 'design' },
  { id: 'check', title: '独立检查文档与异常分支', owner: 'grok', dependency: null }
].map((task) => ({ ...task, description: '保留前序共享资料与测试证据，说明未完成的事项。', acceptance: '提供可复核的结果与验证记录。', state: 'ready' }))
const conversation = createWorkspace('conversation', 'claude', '统一会话与长内容显示', '', project)
conversation.members = structuredClone(project.members)
conversation.messages = [
  { id: 'u1', author: 'you', to: 'all', text: '请共享接口约束，检查窄窗口中的表格、代码和长文件名。', time: '10:00', kind: 'message', sample: false, runId: 'old' },
  { id: 'a1', author: 'claude', authorName: '原方案设计员', provider: 'claude', to: 'all', time: '10:01', kind: 'message', sample: false, runId: 'old', status: 'completed',
    text: '已保存约束，后续员工可继续核对。\n\n| 模块 | 约束 | 验证结果 |\n| --- | --- | --- |\n| 会话 | 保留作者与厂商 | 通过 |\n| 任务 | 前置验收后执行 | 等待确认 |\n\n```ts\nconst sharedContext = "' + 'long-file-name-'.repeat(18) + '"\n```\n\n' + '很长的连续文件标识'.repeat(25) },
  { id: 'a2', author: 'grok', authorName: '独立检查员', provider: 'grok', to: 'all', time: '10:02', kind: 'message', sample: false, runId: 'old', status: 'completed',
    text: '测试图片用于预览和画廊筛选。', images: [{ path: image, alt: '本地验收图标' }] }
]
project.artifacts = [{ id: 'artifact1', name: '共享接口约束.md', description: '跨厂商共享的接口约束', format: 'md', content: '# 接口约束\n\n- 保留原始记录\n- 前置任务需验收', owner: 'claude', version: 1, sample: false }]
if (accountLayoutFixture) {
  project.sample = true
  project.members[0].name = 'Claude'
  project.members[1].name = '负责复杂工作流实现与回归验证的员工'
  project.members[1].model = 'codex-model-with-a-long-explicit-version-identifier-for-layout-check'
  project.messages = conversation.messages.slice(0, 2).map((message) => ({ ...message, sample: true, runId: undefined }))
}
if (!isValidTeam(project) || !isValidTeam(conversation)) throw new Error('Invalid app preview fixture')
useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
useCollaboration.setState({ teams: [project, conversation], activeTeamId: project.id, taskSchedules: {}, runs: {},
  drafts: { [project.id]: '保留这份未发送的草稿。' }, attachmentDrafts: {}, connectionErrors: {}, runtimeError: null, storageError: false,
  modelDefaults: Object.fromEntries(ids.map((id) => [id, { model: `${id}-fixture`, effort: 'low' }])) })
useProviders.setState({ checked: true, diagnostics, error: null })
const skills = [{ name: 'review-fixture', description: '检查交付与验证记录', path: 'C:/fixture/SKILL.md', source: 'repo', userInvocable: true, disabled: false }]
const runs = new Map<string, RunSnapshot>()
const requests = new Map<string, RunRequest>()
const complete = (snapshot: RunSnapshot) => {
  if (snapshot.status === 'cancelled') return
  const request = requests.get(snapshot.id)!
  snapshot.status = request.prompt.includes('失败测试') ? 'failed' : 'completed'
  snapshot.error = snapshot.status === 'failed' ? '测试执行中断，部分结果已保留。' : undefined
  snapshot.permissions = []; snapshot.revision = (snapshot.revision || 0) + 1
  snapshot.finishedAt = new Date().toISOString()
  snapshot.metrics = { modelCalls: request.employees.length, leadCalls: request.coordination || request.interaction === 'conversation' ? 1 : 0,
    workerCalls: request.coordination || request.interaction === 'conversation' ? Math.max(0, request.employees.length - 1) : request.employees.length,
    leadExecutionMs: 800, workerExecutionMs: 1600, permissionWaitMs: 1200, queueWaitMs: 20,
    contextCharacters: 12345, contextEstimatedTokens: 6173, archiveWrites: 2, archiveReuses: 1, fileScans: 4 }
  snapshot.replies = request.employees.map((employee) => ({ employeeId: employee.id, employeeName: employee.name, provider: employee.provider,
    model: employee.model || '', status: snapshot.status, error: snapshot.error,
    text: `已读取 ${request.context.length} 条共享记录。\n\n${snapshot.status === 'failed' ? '已完成部分检查，后续验证未完成。' : '已完成隔离测试中的执行与交接。'}\n\n结果：RESULT-${employee.provider}。` }))
}
runtimeClient.start = async (request) => {
  const snapshot: RunSnapshot = { id: request.id, workspaceId: request.workspaceId, interaction: request.interaction, taskId: request.task?.id, status: 'running', revision: 1,
    permissions: [], replies: [], contextTrimmed: false, createdAt: new Date().toISOString() }
  runs.set(snapshot.id, snapshot); requests.set(snapshot.id, request)
  if (request.prompt.includes('权限测试')) {
    snapshot.status = 'needs_permission'
    snapshot.permissions = [{ id: 'allow-test', employeeId: request.employees[0].id, title: '写入测试交付文件', detail: '仅模拟权限交互，不写入真实文件。',
      options: [{ id: 'allow', label: '允许本次' }, { id: 'deny', label: '拒绝' }] }]
  } else setTimeout(() => complete(snapshot), request.interaction !== 'conversation' && request.prompt.includes('长任务') ? 60000 : 800)
  return structuredClone(snapshot)
}
runtimeClient.run = async (id) => { if (!runs.has(id)) throw new Error('执行记录已过期'); return structuredClone(runs.get(id)!) }
runtimeClient.cancel = async (id) => { const snapshot = runs.get(id)!; snapshot.status = 'cancelled'; snapshot.permissions = []; snapshot.revision!++; return structuredClone(snapshot) }
runtimeClient.permission = async (id, _permission, option) => { const snapshot = runs.get(id)!; if (option === 'allow') complete(snapshot); else { snapshot.status = 'cancelled'; snapshot.permissions = []; snapshot.revision!++ } }
runtimeClient.providers = async () => structuredClone(diagnostics)
runtimeClient.skills = async () => structuredClone(skills) as any
runtimeClient.readSkill = async () => ({ ...skills[0], body: '# 检查交付\n\n核验任务要求、结果与测试证据。' }) as any
runtimeClient.toggleSkill = async (_id, _name, disabled) => { skills[0].disabled = disabled; return structuredClone(skills) as any }
runtimeClient.loginStatus = async (provider) => ({ provider, status: 'idle' }) as any
const assistants = new Map<string, AssistantSnapshot>()
const assistantSnapshot = (scopeId: string) => {
  if (!assistants.has(scopeId)) assistants.set(scopeId, {
    profile: { scopeId, name: '知夏', persona: '认真、温暖，也有自己的判断。', addressing: '你', style: 'warm', updatedAt: new Date().toISOString() },
    memories: [], commitments: [], revision: 0
  })
  return assistants.get(scopeId)!
}
runtimeClient.assistant = async (scopeId) => structuredClone(assistantSnapshot(scopeId))
runtimeClient.clearAssistant = async (scopeId) => {
  const revision = assistantSnapshot(scopeId).revision + 1
  assistants.delete(scopeId)
  const value = assistantSnapshot(scopeId)
  value.revision = revision
  return structuredClone(value)
}
runtimeClient.updateAssistant = async (scopeId, patch) => {
  const value = assistantSnapshot(scopeId)
  value.profile = { ...value.profile, ...patch, updatedAt: new Date().toISOString() }; value.revision++
  return structuredClone(value)
}
runtimeClient.saveMemory = async (scopeId, input) => {
  const value = assistantSnapshot(scopeId), previous = value.memories.find((item) => item.id === input.id)
  const memory = { ...previous, ...input, id: input.id || crypto.randomUUID(), createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }
  value.memories = [...value.memories.filter((item) => item.id !== memory.id), memory]; value.revision++
  return structuredClone(value)
}
runtimeClient.forgetMemory = async (scopeId, id) => {
  const value = assistantSnapshot(scopeId); value.memories = value.memories.filter((item) => item.id !== id); value.revision++
  return structuredClone(value)
}
runtimeClient.saveCommitment = async (scopeId, input) => {
  const value = assistantSnapshot(scopeId), previous = value.commitments.find((item) => item.id === input.id)
  const item = { ...previous, id: input.id || crypto.randomUUID(), title: input.title, status: input.status || previous?.status || 'open' as const,
    dueAt: input.dueAt === null ? undefined : input.dueAt || previous?.dueAt, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }
  value.commitments = [...value.commitments.filter((record) => record.id !== item.id), item]; value.revision++
  return structuredClone(value)
}
runtimeClient.deleteCommitment = async (scopeId, id) => {
  const value = assistantSnapshot(scopeId); value.commitments = value.commitments.filter((item) => item.id !== id); value.revision++
  return structuredClone(value)
}
const events = new Map<string, Set<(value: unknown) => void>>()
let startupFailure = new URLSearchParams(location.search).has('startup-error')
Object.assign(window, { grok: {
  on: (name: string, cb: (value: unknown) => void) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(cb); return () => events.get(name)!.delete(cb) },
  snapshot: async () => { if (startupFailure) { startupFailure = false; throw new Error('模拟配置读取失败') } return { theme: 'dark', locale: 'zh-CN', auth: { signedIn: true }, grokPath: 'fixture', grokVersion: 'fixture', connected: true,
    permissionMode: 'ask', model: 'grok-fixture', effort: 'low', projects: [], threads: [], skills, pet: { awake: false, petId: BUILTIN_PETS[0].id, pets: BUILTIN_PETS } } },
  savePrefs: async () => {},
  acp: { start: async () => {} },
  pets: { report: async () => {} },
  openExternal: async () => {}, openPath: async () => {},
  window: { minimize: () => {}, maximize: () => {}, close: () => {} }
} })
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
