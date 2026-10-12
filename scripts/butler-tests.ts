import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntime, validateRequest } from '../src/main/runtime/service'
import { createRunJournal, archiveContext } from '../src/main/runtime/run-journal'
import { parseDecision } from '../src/main/runtime/coordinator'
import type { Execution } from '../src/main/runtime/adapters'
import type { RunRequest, RuntimeProvider } from '../src/shared/runtime'
import { useCollaboration, refreshRun } from '../src/renderer/src/stores/collaboration'
import { createWorkspace, isValidTeam } from '../src/renderer/src/lib/collaboration-data'
import { runtimeClient } from '../src/renderer/src/lib/runtime-client'

const catalog = ['claude', 'codex', 'grok', 'gemini'].map((id) => ({ id, auth: { signedIn: true }, models: [
  { id: 'test-model', name: id, efforts: ['low'], isDefault: true }
] })) as RuntimeProvider[]
const employee = (id: string, provider: 'grok' | 'codex' | 'claude' | 'gemini' = 'grok') => ({
  id, name: id, provider, role: id === 'lead' ? '理解需求，分配并检查' : `${id} 职责`, persona: '', model: 'test-model', effort: 'low'
})
const request = (patch: Partial<RunRequest> = {}): RunRequest => ({ id: 'butler-run', workspaceId: 'butler-space', goal: '交付可验证的结果',
  prompt: '先实现，再检查并交付', employees: [employee('lead'), employee('builder', 'codex'), employee('reviewer', 'claude')],
  coordination: { leadId: 'lead' }, context: [{ author: '用户', text: '保持接口 CONTRACT-42' }], artifacts: [], ...patch })
const delegate = (employeeId = 'builder', patch: Record<string, unknown> = {}) => ({ action: 'delegate', employeeId,
  title: '实现模块', description: '实际创建结果并验证', acceptance: '结果满足 CONTRACT-42', dependsOn: [], message: `指派 ${employeeId}`, ...patch })
const review = (taskId: string, accepted = true) => ({ action: 'review', taskId, accepted, evidence: '已读取真实文件并运行测试，满足接口要求', message: '检查结果' })
const finish = { action: 'finish', message: '已完成，交付文件和验证结果可查看' }
const taskState = (input: Execution) => JSON.parse(input.instructions.split('本轮任务的实际状态')[1].split('\n')[1]) as any[]
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
  throw new Error('test timed out')
}
function fixture(t: TestContext, execute: (input: Execution) => Promise<void>, customCatalog = catalog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-butler-'))
  const work = path.join(root, 'work'); fs.mkdirSync(work)
  const journal = createRunJournal(path.join(root, 'runs'))
  const runtime = createRuntime({ directory: () => work, execute, providers: async () => structuredClone(customCatalog),
    skills: () => [], journal, archive: archiveContext })
  t.after(async () => {
    await runtime.close()
    const target = path.resolve(root)
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('grok-butler-'))
    fs.rmSync(target, { recursive: true, force: true })
  })
  return { ...runtime, root, work, journal }
}
async function terminal(runtime: ReturnType<typeof fixture>, id = 'butler-run') {
  await until(async () => !['queued', 'running', 'needs_permission'].includes((await runtime.api.run(id)).status))
  return runtime.api.run(id)
}

test('manager assigns, checks, follows dependencies across providers and projects each unique reply into the store', async (t) => {
  const calls: string[] = []
  const runtime = fixture(t, async (input) => {
    calls.push(input.employee.id)
    assert.match(input.prompt, /CONTRACT-42/)
    if (input.employee.id !== 'lead') { input.text(`REAL-RESULT-${input.employee.id}`); return }
    const tasks = taskState(input)
    const command = !tasks.length ? delegate() : tasks.at(-1).status === 'review' ? review(tasks.at(-1).id)
      : tasks.length === 1 ? delegate('reviewer', { title: '验收模块', dependsOn: [tasks[0].id] }) : finish
    if (tasks.length) assert.match(input.prompt, /REAL-RESULT-builder/)
    input.text(JSON.stringify(command))
  })
  const team = createWorkspace('conversation', 'grok'); team.id = 'butler-space'
  team.members = request().employees.map((item) => ({ ...item, isLead: item.id === 'lead' }))
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: { [team.id]: '先实现，再检查并交付 CONTRACT-42' }, runs: {},
    taskSchedules: {}, attachmentDrafts: {}, connectionErrors: {}, stoppingRuns: {} })
  for (const method of ['start', 'run', 'cancel', 'permission'] as const) t.mock.method(runtimeClient, method, runtime.api[method])
  t.after(() => useCollaboration.setState({ runs: {}, taskSchedules: {} }))
  const id = await useCollaboration.getState().send(team.id, 'lead')
  const snapshot = await terminal(runtime, id!)
  await refreshRun(id!)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(calls, ['lead', 'builder', 'lead', 'lead', 'reviewer', 'lead', 'lead'])
  assert.equal(snapshot.coordination?.phase, 'completed')
  assert.ok(snapshot.coordination?.tasks.every((task) => task.status === 'completed'))
  assert.equal(new Set(snapshot.replies.map((reply) => reply.id)).size, 7)
  assert.ok(snapshot.replies.every((reply) => !reply.text.includes('"action":')))
  const saved = useCollaboration.getState().teams[0]
  assert.equal(saved.messages.filter((message) => message.author === 'lead').length, 5)
  assert.equal(saved.tasks.length, 2)
  assert.ok(saved.tasks.every((task) => task.state === 'review' && task.managedStatus === 'completed'))
  assert.ok(isValidTeam(saved))
  const archive = JSON.parse(fs.readFileSync(snapshot.contextReport!.archivePath!, 'utf8'))
  assert.equal(archive.employees.length, 3)
  const restarted = createRuntime({ directory: () => runtime.work, execute: async () => assert.fail('must not replay'),
    providers: async () => catalog, journal: runtime.journal })
  t.after(() => restarted.close())
  assert.deepEqual((await restarted.api.run(id!)).coordination, JSON.parse(JSON.stringify(snapshot.coordination)))
})

test('worker failure returns to manager and reassigns the same task without losing partial results', async (t) => {
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { input.text('PARTIAL-WORK'); throw new Error('构建失败') }
    if (input.employee.id === 'reviewer') { assert.match(input.prompt, /PARTIAL-WORK|构建失败/); input.text('FIXED-RESULT'); return }
    const tasks = taskState(input)
    input.text(JSON.stringify(!tasks.length ? delegate() : tasks[0].status === 'failed'
      ? delegate('reviewer', { taskId: tasks[0].id }) : tasks[0].status === 'review' ? review(tasks[0].id) : finish))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.coordination?.tasks.length, 1)
  assert.equal(snapshot.coordination?.tasks[0].attempts, 2)
  assert.equal(snapshot.coordination?.tasks[0].owner, 'reviewer')
  assert.equal(snapshot.replies.find((reply) => reply.employeeId === 'builder')?.text, 'PARTIAL-WORK')
  assert.equal(snapshot.replies.find((reply) => reply.employeeId === 'builder')?.status, 'failed')
})

test('review rejection triggers rework and a second result from the same employee is retained', async (t) => {
  let workers = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { input.text(`OUTPUT-${++workers}`); return }
    const tasks = taskState(input); const task = tasks[0]
    input.text(JSON.stringify(!task ? delegate() : task.status === 'review' ? review(task.id, workers === 2)
      : task.status === 'failed' ? delegate('builder', { taskId: task.id, description: '修正评审发现的错误' }) : finish))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(snapshot.replies.filter((reply) => reply.employeeId === 'builder').map((reply) => reply.text), ['OUTPUT-1', 'OUTPUT-2'])
  assert.equal(snapshot.coordination?.tasks[0].attempts, 2)
})

test('premature finish and unverified dependencies are refused and corrected without executing invalid work', async (t) => {
  let leads = 0, workers = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { workers++; input.text('RESULT'); return }
    const tasks = taskState(input)
    const decisions = [delegate(), finish, delegate('reviewer', { title: '后续', dependsOn: [tasks[0]?.id] }), review(tasks[0]?.id), finish]
    input.text(JSON.stringify(decisions[leads++]))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(workers, 1)
  assert.match(snapshot.replies[2].text, /未通过检查/)
  assert.match(snapshot.replies[3].text, /前置任务/)
})

test('unknown employees and malformed control cannot invoke workers or silently report success', async (t) => {
  let calls = 0
  const runtime = fixture(t, async (input) => { calls++; input.text(JSON.stringify(delegate('unknown'))) })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'failed')
  assert.match(snapshot.error!, /连续三次|名单/)
  assert.equal(calls, 3)
  assert.equal(snapshot.coordination?.tasks.length, 0)
  assert.throws(() => parseDecision('已经交给员工了'), /JSON/)
  assert.equal(parseDecision('工具操作说明\n' + JSON.stringify(delegate())).action, 'delegate')
  assert.throws(() => validateRequest(request({ coordination: { leadId: 'unknown' } })), /调度配置/)
})

test('expired unused employee does not block direct answers; assigned expired employee can be replaced', async (t) => {
  const unavailable = structuredClone(catalog); unavailable.find((p) => p.id === 'codex')!.auth!.signedIn = false
  let assigned = false
  const runtime = fixture(t, async (input) => {
    assert.notEqual(input.employee.id, 'builder', 'signed-out employee must never execute')
    if (input.employee.id === 'reviewer') { input.text('REPLACEMENT'); return }
    const tasks = taskState(input)
    input.text(JSON.stringify(!assigned ? finish : !tasks.length ? delegate() : tasks[0].status === 'failed'
      ? delegate('reviewer', { taskId: tasks[0].id }) : tasks[0].status === 'review' ? review(tasks[0].id) : finish))
  }, unavailable)
  await runtime.api.start(request({ id: 'answer' }))
  assert.equal((await terminal(runtime, 'answer')).status, 'completed')
  assigned = true
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.match(snapshot.replies.find((reply) => reply.employeeId === 'builder')!.error!, /登录/)
})

test('pending worker permission exposes progress; cancellation prevents all subsequent manager and employee calls', async (t) => {
  const calls: string[] = []
  const runtime = fixture(t, async (input) => {
    calls.push(input.employee.id)
    if (input.employee.id === 'lead') { input.text(JSON.stringify(delegate())); return }
    input.text('PARTIAL')
    await input.permission('写入文件', 'test-only', [{ id: 'allow', label: '允许本次' }, { id: 'deny', label: '拒绝' }])
  })
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('butler-run')).status === 'needs_permission')
  const waiting = await runtime.api.run('butler-run')
  assert.equal(waiting.coordination?.phase, 'executing')
  assert.equal(waiting.permissions[0].employeeId, 'builder')
  const cancelled = await runtime.api.cancel('butler-run')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.coordination?.tasks[0].status, 'failed')
  assert.equal(cancelled.permissionHistory?.[0].status, 'cancelled')
  assert.ok(cancelled.permissionHistory?.[0].resolvedAt)
  await runtime.close()
  assert.deepEqual(calls, ['lead', 'builder'])
  assert.equal((await runtime.api.run('butler-run')).replies.at(-1)?.text, 'PARTIAL')
})

test('blocking response explains what user input is needed and preserves incomplete task state', async (t) => {
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { input.text('部分资料'); throw new Error('缺少源文件') }
    const tasks = taskState(input)
    input.text(JSON.stringify(!tasks.length ? delegate() : { action: 'blocked', message: '请提供源文件，部分资料已经保留' }))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.coordination?.phase, 'blocked')
  assert.match(snapshot.error!, /源文件/)
  assert.equal(snapshot.coordination?.tasks[0].status, 'failed')
})

test('each failed task has a bounded retry budget and cannot keep calling the model indefinitely', async (t) => {
  let workers = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { workers++; throw new Error('持续失败') }
    const task = taskState(input)[0]
    input.text(JSON.stringify(delegate('builder', task ? { taskId: task.id } : {})))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'failed')
  assert.equal(workers, 3)
  assert.match(snapshot.error!, /三次/)
})

test('tool narration around one explicit control block is accepted, while ambiguous control blocks are rejected', () => {
  const block = '```grok-dispatch\n' + JSON.stringify(delegate()) + '\n```'
  assert.equal(parseDecision('我先检查已有文件。\n\n' + block).action, 'delegate')
  assert.throws(() => parseDecision(block + '\n' + block), /只允许一个/)
  assert.throws(() => parseDecision(JSON.stringify(delegate()) + JSON.stringify(finish)), /唯一/)
  assert.throws(() => parseDecision('文件检查已完成，但没有实际调度指令'), /JSON/)
})

test('a follow-up request resumes a selected historical task and can depend on previous checked work', async (t) => {
  const oldTask = { id: 'old-task', title: '实现模块', owner: 'builder', status: 'failed' as const, description: '之前中断的工作',
    acceptance: '结果满足 CONTRACT-42', dependencies: ['old-prerequisite'], attempts: 3 }
  const completed = { ...oldTask, id: 'old-prerequisite', title: '前置工作', status: 'completed' as const, dependencies: [] }
  let workers = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { workers++; input.text('RESUMED-RESULT'); return }
    const tasks = taskState(input)
    input.text(JSON.stringify(!tasks.length ? delegate('builder', { taskId: 'old-task', dependsOn: ['old-prerequisite'] })
      : tasks[0].status === 'review' ? review(tasks[0].id) : finish))
  })
  await runtime.api.start(request({ coordination: { leadId: 'lead', previousTasks: [completed, oldTask] } }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(workers, 1)
  assert.equal(snapshot.coordination?.tasks[0].id, 'old-task')
  assert.equal(snapshot.coordination?.tasks[0].attempts, 1)
})

test('an unrelated new question can finish without restarting incomplete historical tasks', async (t) => {
  const runtime = fixture(t, async (input) => { assert.equal(input.employee.id, 'lead'); input.text(JSON.stringify(finish)) })
  await runtime.api.start(request({ coordination: { leadId: 'lead', previousTasks: [
    { id: 'old-unfinished', title: '旧任务', description: '', acceptance: '', owner: 'builder', status: 'failed', attempts: 1, dependencies: [] }
  ] } }))
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.coordination?.tasks.length, 0)
})

test('a stalled employee times out locally and the manager can replace it within the same request', async (t) => {
  const calls: string[] = []
  const runtime = createRuntime({ directory: () => process.cwd(), skills: () => [], providers: async () => structuredClone(catalog), executionMs: 80,
    execute: async (input) => {
      calls.push(input.employee.id)
      if (input.employee.id === 'builder') {
        input.text('TIMEOUT-PARTIAL')
        await new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
        return
      }
      if (input.employee.id === 'reviewer') { input.text('TIMEOUT-RECOVERED'); return }
      const tasks = taskState(input)
      input.text(JSON.stringify(!tasks.length ? delegate() : tasks[0].status === 'failed'
        ? delegate('reviewer', { taskId: tasks[0].id }) : tasks[0].status === 'review' ? review(tasks[0].id) : finish))
    } })
  t.after(() => runtime.close())
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('butler-run')).status === 'completed')
  const snapshot = await runtime.api.run('butler-run')
  assert.match(snapshot.replies.find((reply) => reply.employeeId === 'builder')!.error!, /超时/)
  assert.equal(snapshot.coordination?.tasks[0].owner, 'reviewer')
  assert.equal(snapshot.coordination?.tasks[0].attempts, 2)
})

test('a worker that fails while requesting permission cannot leave approvals attached to the next employee', async (t) => {
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') {
      void input.permission('STALE-APPROVAL', 'stale operation', [{ id: 'allow', label: '允许' }]).catch(() => {})
      throw new Error('客户端已经失败')
    }
    if (input.employee.id === 'reviewer') { input.text('RESULT'); return }
    const task = taskState(input)[0]
    input.text(JSON.stringify(!task ? delegate() : task.status === 'failed' ? delegate('reviewer', { taskId: task.id }) : task.status === 'review' ? review(task.id) : finish))
  })
  await runtime.api.start(request())
  const snapshot = await terminal(runtime)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(snapshot.permissions, [])
  assert.equal(snapshot.permissionHistory?.[0].status, 'cancelled')
})

test('regenerating a managed worker asks the lead to reassign and recheck the same task, preserving earlier output', async (t) => {
  let workers = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') { input.text(`WORK-${++workers}`); return }
    const tasks = taskState(input)
    const oldId = /请重新指派并检查既有任务 ([\w-]+)/.exec(input.prompt)?.[1]
    input.text(JSON.stringify(!tasks.length ? delegate('builder', oldId ? { taskId: oldId } : {}) : tasks[0].status === 'review' ? review(tasks[0].id) : finish))
  })
  const team = createWorkspace('conversation', 'grok'); team.id = 'butler-space'
  team.members = request().employees.map((item) => ({ ...item, isLead: item.id === 'lead' }))
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, drafts: { [team.id]: '实现模块' }, runs: {}, taskSchedules: {},
    attachmentDrafts: {}, stoppingRuns: {}, connectionErrors: {} })
  for (const method of ['start', 'run', 'cancel', 'permission'] as const) t.mock.method(runtimeClient, method, runtime.api[method])
  t.after(() => useCollaboration.setState({ runs: {}, taskSchedules: {} }))
  const first = await useCollaboration.getState().send(team.id, 'lead')
  await terminal(runtime, first!); await refreshRun(first!)
  const original = useCollaboration.getState().teams[0].messages.find((message) => message.author === 'builder')!
  await useCollaboration.getState().retryMessage(team.id, original.id)
  const second = Object.values(useCollaboration.getState().runs).find((run) => run.id !== first)!
  const result = await terminal(runtime, second.id); await refreshRun(second.id)
  assert.equal(result.status, 'completed', result.error)
  const saved = useCollaboration.getState().teams[0]
  assert.equal(saved.tasks.length, 1)
  assert.equal(workers, 2)
  assert.deepEqual(saved.messages.filter((message) => message.author === 'builder').map((message) => message.text), ['WORK-1', 'WORK-2'])
  assert.equal(saved.tasks[0].managedStatus, 'completed')
})

test('all four supported lead provider identities use the same assignment and review loop', async (t) => {
  for (const provider of ['grok', 'codex', 'claude', 'gemini'] as const) {
    const runtime = fixture(t, async (input) => {
      if (input.employee.id === 'builder') { input.text('VERIFIED'); return }
      assert.equal(input.employee.provider, provider)
      const task = taskState(input)[0]
      input.text(JSON.stringify(!task ? delegate() : task.status === 'review' ? review(task.id) : finish))
    })
    await runtime.api.start(request({ employees: [employee('lead', provider), employee('builder', 'codex')] }))
    assert.equal((await terminal(runtime)).status, 'completed')
  }
})

test('tool confirmations retain their employee reply and answer in the durable runtime history', async (t) => {
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'builder') {
      input.text('准备写入文件')
      const answer = await input.permission('Write', JSON.stringify({ file_path: 'result.md', content: 'full file body' }), [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }])
      input.text(`结果 ${answer}`); return
    }
    const task = taskState(input)[0]
    input.text(JSON.stringify(!task ? delegate() : task.status === 'review' ? review(task.id) : finish))
  })
  await runtime.api.start(request())
  await until(async () => (await runtime.api.run('butler-run')).status === 'needs_permission')
  const waiting = await runtime.api.run('butler-run')
  assert.equal(waiting.permissionHistory?.length, 1)
  assert.equal(waiting.permissionHistory?.[0].status, 'pending')
  assert.equal(waiting.permissionHistory?.[0].replyId, waiting.replies.at(-1)?.id)
  await runtime.api.permission('butler-run', waiting.permissions[0].id, 'allow')
  const completed = await terminal(runtime)
  assert.equal(completed.permissionHistory?.[0].status, 'answered')
  assert.equal(completed.permissionHistory?.[0].optionLabel, 'Yes')
  assert.ok(completed.permissionHistory?.[0].resolvedAt)
  assert.equal(completed.permissions.length, 0)
  const restarted = createRuntime({ directory: () => runtime.work, execute: async () => assert.fail('no replay'), providers: async () => catalog, journal: runtime.journal })
  t.after(() => restarted.close())
  assert.equal((await restarted.api.run('butler-run')).permissionHistory?.[0].status, 'answered')
})

test('lead agent clarifies via ask, formulates plan, recruits sub-agents, delegates in parallel, and syncs shared artifacts and work receipts', async (t) => {
  let leadRound = 0
  const runtime = fixture(t, async (input) => {
    if (input.employee.id === 'ui-agent') {
      input.receipt?.({ filesModified: ['pages/index/index.wxml'], commands: ['npm run lint:ui'] })
      input.text('已完成小程序首页与生图参数面板。\n```grok-artifact\n{"name":"ui-spec.md","description":"小程序页面组件规范","format":"md"}\n# 小程序 UI 规范\n- 首页 Prompt 输入框与风格选择\n```')
      return
    }
    if (input.employee.id === 'api-agent') {
      fs.writeFileSync(path.join(input.cwd, 'server.js'), 'export const generateImage = () => "ok"\n', 'utf8')
      input.receipt?.({ filesModified: ['server.js'], commands: ['node --check server.js'] })
      input.text('已完成生图后端接口与鉴权逻辑。')
      return
    }
    leadRound++
    if (leadRound === 1) {
      input.text(JSON.stringify({
        action: 'ask',
        message: '为了制定完整的微信小程序开发计划，请确认：1) 是否支持参考图上传？2) 目标生图模型使用哪个厂商？'
      }))
      return
    }
    const tasks = taskState(input)
    if (!tasks.length) {
      input.text(JSON.stringify({
        action: 'plan',
        recruit: [
          { id: 'ui-agent', name: '前端与UI专家', provider: 'gemini', role: '负责微信小程序页面与交互实现' },
          { id: 'api-agent', name: '后端接口专家', provider: 'codex', role: '负责图片生成 API 与云函数开发' }
        ],
        artifacts: [
          { name: 'architecture.md', description: '图片生成小程序总体架构与接口契约', format: 'md', content: '# 架构设计\nPOST /api/generate' }
        ],
        tasks: [
          { id: 'task-ui', employeeId: 'ui-agent', title: '小程序生图界面开发', description: '实现生图输入与预览页', acceptance: '包含首页与规范文档', dependsOn: [] },
          { id: 'task-api', employeeId: 'api-agent', title: '生图服务端接口开发', description: '实现生图 API', acceptance: '生成 server.js 并通过语法检查', dependsOn: [] }
        ],
        message: '已根据确认的需求招募前端与后端子 agent，并制定完整开发任务清单。'
      }))
      return
    }
    if (tasks.every((item) => item.status === 'ready')) {
      input.text(JSON.stringify({
        action: 'delegate_parallel',
        tasks: [
          { taskId: 'task-ui', employeeId: 'ui-agent', title: '小程序生图界面开发', description: '实现生图输入与预览页', acceptance: '包含首页与规范文档', dependsOn: [] },
          { taskId: 'task-api', employeeId: 'api-agent', title: '生图服务端接口开发', description: '实现生图 API', acceptance: '生成 server.js 并通过语法检查', dependsOn: [] }
        ],
        message: '并行调度前端与后端子 agent 同步开发。'
      }))
      return
    }
    const pendingReview = tasks.find((item) => item.status === 'review')
    if (pendingReview) {
      assert.match(input.instructions, /宿主工作回执|server\.js|ui-spec\.md/)
      input.text(JSON.stringify(review(pendingReview.id, true)))
      return
    }
    input.text(JSON.stringify(finish))
  })

  const team = createWorkspace('conversation', 'claude')
  team.id = 'butler-space'
  team.members = [{ ...employee('lead', 'claude'), isLead: true }]
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, taskSchedules: {} })

  // Turn 1: Lead Agent analyzes requirement and communicates with user via 'ask'
  await runtime.api.start(request({
    id: 'run-ask',
    prompt: '设计一个图片生成微信小程序',
    employees: [employee('lead', 'claude')]
  }))
  const askSnap = await terminal(runtime, 'run-ask')
  assert.equal(askSnap.status, 'completed')
  assert.equal(askSnap.coordination?.phase, 'completed')
  useCollaboration.getState().applyRun(askSnap)
  assert.match(useCollaboration.getState().teams[0].messages.at(-1)?.text || '', /为了制定完整的微信小程序开发计划/)

  // Turn 2: User confirms requirements; Lead Agent recruits sub-agents, plans tasks, delegates in parallel, reviews, and finishes
  await runtime.api.start(request({
    id: 'run-plan-exec',
    prompt: '支持参考图上传，后端统一对接多模型生图网关，请开始规划并执行',
    employees: [employee('lead', 'claude')]
  }))
  const finalSnap = await terminal(runtime, 'run-plan-exec')
  assert.equal(finalSnap.status, 'completed', finalSnap.error)
  assert.equal(finalSnap.coordination?.recruited?.length, 2)
  assert.equal(finalSnap.coordination?.tasks.length, 2)
  assert.ok(finalSnap.coordination?.tasks.every((item) => item.status === 'completed'))
  assert.ok(finalSnap.sharedArtifacts?.some((a) => a.name === 'architecture.md'))
  assert.ok(finalSnap.sharedArtifacts?.some((a) => a.name === 'ui-spec.md'))

  useCollaboration.getState().applyRun(finalSnap)
  const updatedTeam = useCollaboration.getState().teams[0]
  assert.ok(isValidTeam(updatedTeam), 'updated team must satisfy isValidTeam schema validation')
  assert.equal(updatedTeam.members.length, 3)
  assert.equal(updatedTeam.tasks.length, 2)
  assert.ok(updatedTeam.artifacts.some((a) => a.name === 'architecture.md'))
  assert.ok(updatedTeam.artifacts.some((a) => a.name === 'ui-spec.md'))
  const apiReply = updatedTeam.messages.find((m) => m.author === 'api-agent')
  assert.ok(apiReply?.receipt?.filesModified?.includes('server.js'))
})

