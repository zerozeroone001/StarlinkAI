import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleExecutionContext, type Handoff } from '../src/main/runtime/context'
import { compactWorkerSources, focusWorkerContext, workerSourceMinimumBudget } from '../src/main/runtime/worker-context'
import { collaborationContext } from '../src/renderer/src/lib/collaboration-context'
import { separateAssistantContext } from '../src/renderer/src/lib/assistant-context'
import { createWorkspace, type TeamTask, type TeamMessage } from '../src/renderer/src/lib/collaboration-data'
import { taskPrompt, selectScheduledTask } from '../src/renderer/src/lib/task-scheduler'
import { INPUT_CHARACTER_BUDGET, INPUT_TOKEN_ESTIMATE_BUDGET, estimateTokens } from '../src/shared/context'
import type { DelegatedTask, RunRequest } from '../src/shared/runtime'

const task = (id: string, dependencies: string[] = []): DelegatedTask => ({
  id, title: `Task ${id}`, description: `Goal ${id}`, acceptance: `ACCEPTANCE_${id}`, owner: 'worker',
  status: 'completed', dependencies, attempts: 1, replyId: `reply-${id}`
})
const request = (): RunRequest => ({
  id: 'run', workspaceId: 'space', goal: 'Project goal', prompt: 'Execute assigned work',
  employees: [{ id: 'worker', name: 'Worker', provider: 'codex', role: 'Engineer', persona: '' }],
  context: [], artifacts: []
})
const handoff = (id: string, text = `OUTPUT_${id}`): Handoff => ({
  id: `reply-${id}`, taskId: id, employeeId: 'worker', name: 'Worker', provider: 'codex', status: 'completed', text, images: []
})
const teamTask = (owner: string, id: string, patch: Partial<TeamTask> = {}): TeamTask => ({
  id, owner, title: id, description: `Complete ${id}`, acceptance: `Verify ${id}`, state: 'done', dependency: null,
  resultRunId: `run-${id}`, acceptedRunId: `run-${id}`, ...patch
})
const message = (author: string, id: string, patch: Partial<TeamMessage> = {}): TeamMessage => ({
  id, author, to: 'all', text: `OUTPUT_${id}`, time: '10:00', kind: 'handoff', sample: false,
  status: 'completed', ...patch
})

test('renderer carries the union of dependencies, acceptance, feedback and uncut source identities', () => {
  const team = createWorkspace('conversation', 'codex')
  const owner = team.members[0].id
  team.tasks = [teamTask(owner, 'a'), teamTask(owner, 'b'), teamTask(owner, 'c', {
    state: 'ready', dependency: 'a', managedDependencies: ['b', 'a'], reviewNote: 'FIX_THE_EDGE_CASE'
  })]
  team.messages = [message(owner, 'a', { taskId: 'a', runId: 'run-a', runtimeReplyId: 'runtime-a',
    text: 'ORIGINAL_START\n' + 'x'.repeat(15000) + '\nORIGINAL_END' }),
  message(owner, 'b', { taskId: 'b', runId: 'run-b', runtimeReplyId: 'runtime-b' })]
  const context = collaborationContext(team, undefined, team.messages, 'c')
  assert.deepEqual(context.task?.dependencies?.map((item) => item.id).sort(), ['a', 'b'])
  assert.equal(context.task?.dependencies?.find((item) => item.id === 'a')?.acceptedRunId, 'run-a')
  assert.equal(context.task?.review, 'FIX_THE_EDGE_CASE')
  assert.equal(context.context[0].text, team.messages[0].text)
  assert.equal(context.context[0].runId, 'run-a')
  assert.equal(context.context[0].replyId, 'runtime-a')
  assert.match(taskPrompt(team.tasks[2]), /FIX_THE_EDGE_CASE/)
  assert.equal(selectScheduledTask(team, ['c']).task?.id, 'c')
  const focused = focusWorkerContext({ ...request(), ...context }, [])!
  assert.deepEqual(focused.sources.map((source) => source.taskId).sort(), ['a', 'b'])
})

test('private conversation text is not duplicated into artifacts and cross-project artifacts are excluded', () => {
  const parent = createWorkspace('project', 'codex', 'Own project')
  const team = createWorkspace('conversation', 'codex', 'Child', '', parent)
  const sibling = createWorkspace('conversation', 'codex', 'Sibling', '', parent)
  const foreign = createWorkspace('conversation', 'codex', 'Foreign')
  sibling.artifacts = [{ id: 'ok', owner: 'worker', name: 'allowed.txt', content: 'SHARED_PROJECT',
    description: '', version: 1, format: 'txt', sample: false }]
  foreign.artifacts = [{ ...sibling.artifacts[0], content: 'FOREIGN_SECRET' }]
  team.messages = [message(team.members[0].id, 'private', { private: true, text: 'PRIVATE_SECRET' })]
  const context = collaborationContext(team, parent, team.messages, undefined, [sibling, foreign])
  const separated = separateAssistantContext(context.context, team.messages, team.members[0].id)
  assert.equal(separated.context.length, 0)
  assert.equal(separated.privateContext[0].text, 'PRIVATE_SECRET')
  assert.match(JSON.stringify(context.artifacts), /SHARED_PROJECT/)
  assert.doesNotMatch(JSON.stringify(context.artifacts), /PRIVATE_SECRET|FOREIGN_SECRET/)
})

test('delegated workers receive accepted sources from every prerequisite and only their own failed attempt', () => {
  const req = request()
  req.context = [
    { id: 'early', author: '用户', authorId: 'you', text: 'GLOBAL_CONSTRAINT', kind: 'message' },
    { id: 'noise', author: 'Other', taskId: 'unrelated', text: 'UNRELATED_HISTORY', kind: 'handoff', status: 'completed' },
    { id: 'old-a', author: 'Worker', taskId: 'a', replyId: 'stale-a', text: 'STALE_APPROACH', status: 'completed' }
  ]
  const current = { ...task('c', ['a', 'b']), status: 'working' as const, review: 'REWORK_REQUIRED', error: 'FAILED_TEST' }
  const handoffs = [handoff('a'), handoff('b'), handoff('unrelated', 'UNRELATED_HANDOFF'),
    { ...handoff('c', 'FAILED_PREVIOUS_ATTEMPT'), status: 'failed' }]
  const before = structuredClone({ req, handoffs, current })
  const result = assembleExecutionContext(req, 'SYSTEM', handoffs, '/archive/full.json', {
    task: current, tasks: [task('a'), task('b'), current]
  })
  for (const required of ['OUTPUT_a', 'OUTPUT_b', 'FAILED_PREVIOUS_ATTEMPT', 'REWORK_REQUIRED', 'FAILED_TEST', 'GLOBAL_CONSTRAINT', 'ACCEPTANCE_c'])
    assert.ok(result.prompt.includes(required), required)
  assert.doesNotMatch(result.prompt, /UNRELATED_HISTORY|UNRELATED_HANDOFF|STALE_APPROACH/)
  assert.match(result.prompt, /reply-a/)
  assert.match(result.prompt, /archive\/full.json/)
  assert.equal(result.report.messages, 7)
  assert.equal(result.report.included + result.report.omitted, result.report.messages)
  assert.ok(result.report.omitted >= 3)
  assert.equal(result.trimmed, true)
  assert.deepEqual({ req, handoffs, current }, before)
})

test('manual tasks use accepted run identity and never take another task output from the same run', () => {
  const req = request()
  req.task = { id: 'current', title: 'Current', description: 'Build', acceptance: 'Verify', owner: 'worker',
    dependency: { id: 'a', state: 'done' }, dependencies: [{ id: 'a', state: 'done', acceptedRunId: 'accepted-run' }] }
  req.context = [
    { id: 'accepted', runId: 'accepted-run', taskId: 'a', author: 'Worker', status: 'completed', text: 'RIGHT_OUTPUT' },
    { id: 'same-run-other-task', runId: 'accepted-run', taskId: 'other', author: 'Worker', status: 'completed', text: 'WRONG_TASK' },
    { id: 'failed', runId: 'accepted-run', taskId: 'a', author: 'Worker', status: 'failed', text: 'FAILED_OUTPUT' },
    { id: 'newer', runId: 'unaccepted-run', taskId: 'a', author: 'Worker', status: 'completed', text: 'UNACCEPTED_OUTPUT' }
  ]
  const focused = focusWorkerContext(req, [])!
  assert.equal(focused.sources.length, 1)
  assert.equal(focused.sources[0].text, 'RIGHT_OUTPUT')
  assert.equal(focused.contract.prerequisites[0].acceptedRunId, 'accepted-run')
})

test('missing or unaccepted dependency outputs are explicit and are never promoted from worker success', () => {
  const current = task('c', ['a', 'missing'])
  const focused = focusWorkerContext(request(), [handoff('a')], {
    task: current, tasks: [{ ...task('a'), status: 'review' }]
  })!
  assert.equal(focused.sources.length, 0)
  assert.deepEqual(focused.contract.prerequisites.map((item) => [item.accepted, item.outputAvailable]), [[false, false], [false, false]])
})

test('fallback legacy sources are limited to the latest completed reply of each accepted task', () => {
  const req = request()
  req.context = [
    { id: 'old', author: 'Worker', taskId: 'a', status: 'completed', text: 'OLD' },
    { id: 'latest', author: 'Worker', taskId: 'a', status: 'completed', text: 'LATEST' },
    { id: 'failed', author: 'Worker', taskId: 'a', status: 'failed', text: 'FAILED' }
  ]
  const focused = focusWorkerContext(req, [], { task: task('c', ['a']), tasks: [{ ...task('a'), replyId: undefined }] })!
  assert.deepEqual(focused.sources.map((source) => source.text), ['LATEST'])
})

test('required evidence shares a bounded allowance without losing any dependency or source identity', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(`dep-${index}`))
  const focused = focusWorkerContext(request(), tasks.map((item) => handoff(item.id, `START_${item.id}\n${'正文'.repeat(16000)}\nEND_${item.id}`)), {
    task: task('c', tasks.map((item) => item.id)), tasks
  })!
  const minimum = workerSourceMinimumBudget(focused.sources)
  const result = compactWorkerSources(focused.sources, minimum + 3000)
  assert.ok(result.text.length <= minimum + 3000)
  assert.equal(result.compressed, 12)
  const records = JSON.parse(result.text)
  assert.equal(records.length, 12)
  for (const record of records) {
    assert.ok(record.id && record.taskId && record.author)
    assert.match(record.text, new RegExp(`START_${record.taskId}`))
    assert.match(record.text, new RegExp(`END_${record.taskId}`))
  }
  assert.throws(() => compactWorkerSources(focused.sources, minimum - 1), /预算/)
})

test('large Chinese sources stay inside both host budgets while the whole task contract survives', () => {
  const req = request()
  req.artifacts = [{ name: 'large.txt', content: '资料'.repeat(70000) }]
  req.context = [{ id: 'global', author: '用户', authorId: 'you', text: 'GLOBAL_MUST_STAY', kind: 'message' }]
  const current = { ...task('c', ['a', 'b']), acceptance: `完整验收开始${'中间验收细则'.repeat(100)}完整验收结束`,
    review: '必须保留整段返工意见', status: 'working' as const }
  const instructions = 'SYSTEM: ' + 'x'.repeat(4000)
  const result = assembleExecutionContext(req, instructions, [handoff('a', '资料甲'.repeat(30000)), handoff('b', '资料乙'.repeat(30000))],
    '/archive/full.json', { task: current, tasks: [task('a'), task('b')] })
  assert.ok(result.prompt.includes(current.acceptance))
  assert.ok(result.prompt.includes(current.review))
  assert.match(result.prompt, /GLOBAL_MUST_STAY/)
  assert.match(result.prompt, /reply-a/)
  assert.match(result.prompt, /reply-b/)
  assert.ok(result.report.inputCharacters! <= INPUT_CHARACTER_BUDGET)
  assert.ok(result.report.estimatedTokens! <= INPUT_TOKEN_ESTIMATE_BUDGET)
  assert.equal(result.report.estimatedTokens, estimateTokens(instructions + '\n' + result.prompt))
  assert.ok(result.report.compressed >= 2)
})

test('an oversized immutable task contract fails instead of silently dropping acceptance', () => {
  const current = { ...task('c'), acceptance: '验收'.repeat(50000) }
  assert.throws(() => assembleExecutionContext(request(), '', [], undefined, { task: current, tasks: [] }), /未截断任务合同/)
})

test('all four providers share the same task focus and generic conversation preserves prior handoffs', () => {
  for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
    const req = request()
    req.employees[0].provider = provider
    const result = assembleExecutionContext(req, 'SYSTEM', [handoff('a')], undefined,
      { task: task('c', ['a']), tasks: [task('a')] })
    assert.match(result.prompt, /OUTPUT_a/)
    assert.match(result.prompt, /ACCEPTANCE_c/)
  }
  const result = assembleExecutionContext(request(), '', [handoff('unscoped', 'ORDINARY_HANDOFF')])
  assert.match(result.prompt, /ORDINARY_HANDOFF/)
})
