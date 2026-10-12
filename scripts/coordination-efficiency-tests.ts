import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordinate, parseDecision } from '../src/main/runtime/coordinator'
import type { DelegatedTask, RunReply, RunRequest, RunSnapshot, RuntimeEmployee } from '../src/shared/runtime'

const employee = (id: string): RuntimeEmployee => ({ id, name: id, provider: 'codex', role: 'test', persona: '', model: 'unchanged-model' })
const spec = (title: string, employeeId = 'worker') => ({ employeeId, title, description: `Implement ${title}`, acceptance: `Test ${title}`, dependsOn: [] as string[] })
const finish = { action: 'finish', message: 'Delivered' }
const batch = { action: 'delegate_parallel', tasks: [spec('one'), spec('two', 'worker-two')], message: 'Dispatch both' }
const review = (task: DelegatedTask, accepted = true) => ({ taskId: task.id, replyId: task.replyId, accepted, evidence: `Checked ${task.title}: test exit 0` })
const recruit = [{ id: 'new-worker', name: 'New worker', role: 'bounded implementation', provider: 'codex' }]
const artifacts = [{ name: 'contract.md', content: 'VALID-CONTRACT', description: 'Contract', format: 'md' }]
type LeadStep = object | ((state: RunSnapshot, instructions: string) => object)

function fixture(decisions: LeadStep[], options: {
  tasks?: DelegatedTask[]
  previousTasks?: DelegatedTask[]
  replies?: RunReply[]
  assistantActions?: () => Promise<void>
  worker?: (task: DelegatedTask, attempt: number, instructions: string) => Promise<Partial<RunReply>>
} = {}) {
  const request: RunRequest = {
    id: 'run', workspaceId: 'space', goal: '', prompt: 'Build two modules', employees: [employee('lead'), employee('worker'), employee('worker-two')],
    context: [], artifacts: [], coordination: { leadId: 'lead', previousTasks: options.previousTasks }
  }
  const snapshot: RunSnapshot = {
    id: request.id, workspaceId: request.workspaceId, status: 'running', replies: structuredClone(options.replies || []), permissions: [],
    createdAt: '', contextTrimmed: false, coordination: { leadId: 'lead', phase: 'planning', tasks: structuredClone(options.tasks || []) }
  }
  const instructions: string[] = [], workerInputs: DelegatedTask[] = [], changes: RunSnapshot[] = []
  let leadCalls = 0, workerCalls = 0, active = 0, peak = 0
  return {
    request, snapshot, instructions, workerInputs, changes,
    counts: () => ({ leadCalls, workerCalls, peak }),
    run: () => coordinate({
      request, snapshot, signal: new AbortController().signal, assistantActions: options.assistantActions,
      changed: async () => { changes.push(structuredClone(snapshot)) },
      run: async (member, extra, task, control) => {
        const reply: RunReply = {
          id: `reply-${snapshot.replies.length + 1}`, employeeId: member.id, provider: member.provider, model: member.model || '',
          taskId: task?.id, kind: control ? 'decision' : 'handoff', text: '', status: 'completed'
        }
        snapshot.replies.push(reply)
        if (control) {
          instructions.push(extra)
          const step = decisions[leadCalls++]
          assert.ok(step, 'mock lead must provide an expected decision')
          reply.text = JSON.stringify(typeof step === 'function' ? step(snapshot, extra) : step)
        } else {
          assert.ok(task)
          workerInputs.push(structuredClone(task))
          active++; peak = Math.max(peak, active)
          workerCalls++
          try {
            const result = await options.worker?.(task, workerCalls, extra)
            Object.assign(reply, { text: `Delivered ${task.title}`, receipt: { commands: [{ command: `test ${task.title}`, exitCode: 0 }] } }, result)
          } finally { active-- }
        }
        return reply
      }
    })
  }
}

function pending(id: string, dependencies: string[] = []): DelegatedTask {
  return { id, title: id, description: id, acceptance: `test ${id}`, owner: 'worker', dependencies, status: 'review', attempts: 1, replyId: `result-${id}` }
}
function receipt(task: DelegatedTask): RunReply {
  return { id: task.replyId, taskId: task.id, employeeId: task.owner, provider: 'codex', model: 'test', text: 'result', status: 'completed' }
}
function finalBatch(snapshot: RunSnapshot) {
  return { action: 'review_batch', reviews: snapshot.coordination!.tasks.map((task) => review(task)), finish: true, message: 'All verified and delivered' }
}

test('review_batch schema requires bounded, independently evidenced review items', () => {
  assert.equal(parseDecision(JSON.stringify({ action: 'review_batch', reviews: [review(pending('one'))], finish: true, message: 'done' })).action, 'review_batch')
  for (const patch of [
    { reviews: [] }, { reviews: Array(21).fill(review(pending('one'))) },
    { reviews: [{ ...review(pending('one')), evidence: '' }] }, { reviews: [{ ...review(pending('one')), replyId: 42 }] },
    { finish: 'true' }, { artifacts: [{ ...artifacts[0], description: 42 }] }, { artifacts: [{ ...artifacts[0], format: 'exe' }] }
  ]) assert.throws(() => parseDecision(JSON.stringify({ action: 'review_batch', reviews: [review(pending('one'))], message: 'done', ...patch })))
})

test('two-worker mock workflow reduces four lead calls to two while preserving serial writes and both reviews', async () => {
  const old = fixture([batch,
    (state) => ({ action: 'review', ...review(state.coordination!.tasks[0]), message: 'one checked' }),
    (state) => ({ action: 'review', ...review(state.coordination!.tasks[1]), message: 'two checked' }), finish])
  await old.run()
  const fast = fixture([batch, finalBatch])
  await fast.run()
  assert.deepEqual(old.counts(), { leadCalls: 4, workerCalls: 2, peak: 1 })
  assert.deepEqual(fast.counts(), { leadCalls: 2, workerCalls: 2, peak: 1 })
  for (const subject of [old, fast]) {
    assert.equal(subject.snapshot.coordination!.phase, 'completed')
    assert.ok(subject.snapshot.coordination!.tasks.every((task) => task.status === 'completed' && task.attempts === 1 && task.replyId && task.review?.includes(task.title)))
    assert.equal(subject.snapshot.replies.at(-1)!.kind, 'message')
    assert.ok(subject.request.employees.every((member) => member.model === 'unchanged-model'))
  }
})

test('invalid later batch review rolls back earlier review, recruit and artifact mutations', async () => {
  const subject = fixture([batch,
    (state) => ({ action: 'review_batch', reviews: [review(state.coordination!.tasks[0]), review(pending('missing'))], recruit, artifacts, message: 'invalid batch' }),
    (state, extra) => {
      assert.ok(state.coordination!.tasks.every((task) => task.status === 'review' && !task.review))
      assert.equal(subject.request.employees.length, 3)
      assert.deepEqual(subject.request.artifacts, [])
      assert.equal(state.sharedArtifacts, undefined)
      assert.match(extra, /remainingCorrections.*2/)
      return finalBatch(state)
    }])
  await subject.run()
  assert.equal(subject.counts().workerCalls, 2)
})

test('batch finish cannot leave ready tasks behind and rejects the whole acceptance transaction', async () => {
  const first = pending('first'), next = { ...pending('next'), status: 'ready' as const, replyId: undefined, attempts: 0 }
  const subject = fixture([
    { action: 'review_batch', reviews: [review(first)], finish: true, artifacts, message: 'too soon' },
    (state) => {
      assert.equal(state.coordination!.tasks[0].status, 'review')
      assert.equal(state.sharedArtifacts, undefined)
      return { action: 'ask', message: 'Need the next step' }
    }
  ], { tasks: [first, next], replies: [receipt(first)] })
  await subject.run()
})

test('batch review validates the dependency graph independent of input order', async () => {
  const parent = pending('parent'), child = pending('child', ['parent'])
  const subject = fixture([{ action: 'review_batch', reviews: [review(child), review(parent)], finish: true, message: 'verified both' }],
    { tasks: [child, parent], replies: [receipt(child), receipt(parent)] })
  await subject.run()
  assert.ok(subject.snapshot.coordination!.tasks.every((task) => task.status === 'completed'))
})

test('rejected prerequisite and cyclic review graphs do not partially commit', async () => {
  for (const cyclic of [false, true]) {
    const parent = pending('parent', cyclic ? ['child'] : []), child = pending('child', ['parent'])
    const subject = fixture([
      { action: 'review_batch', reviews: [review(child), review(parent, cyclic)], message: 'invalid dependency' },
      (state, extra) => {
        assert.ok(state.coordination!.tasks.every((task) => task.status === 'review' && !task.review))
        assert.match(extra, cyclic ? /依赖存在环/ : /前置任务必须检查通过/)
        return { action: 'ask', message: 'Clarify evidence' }
      }
    ], { tasks: [parent, child], replies: [receipt(parent), receipt(child)] })
    await subject.run()
  }
})

test('rejecting both dependency results is valid without acceptance, but cannot finalize delivery', async () => {
  for (const finishNow of [false, true]) {
    const parent = pending('parent'), child = pending('child', ['parent'])
    const subject = fixture([
      { action: 'review_batch', reviews: [review(child, false), review(parent, false)], finish: finishNow, message: 'Both require repair' },
      (state) => {
        assert.ok(state.coordination!.tasks.every((task) => task.status === (finishNow ? 'review' : 'failed')))
        assert.ok(state.coordination!.tasks.every((task) => finishNow ? !task.review : !!task.review))
        return { action: 'ask', message: 'Confirm revised acceptance' }
      }
    ], { tasks: [parent, child], replies: [receipt(parent), receipt(child)] })
    await subject.run()
  }
})

test('reviews bind the current completed worker reply and reject duplicates or stale references atomically', async () => {
  for (const variant of ['stale', 'duplicate', 'wrong-task', 'wrong-owner', 'failed'] as const) {
    const task = pending('one'), reply = receipt(task)
    if (variant === 'wrong-task') reply.taskId = 'other'
    if (variant === 'wrong-owner') reply.employeeId = 'other'
    if (variant === 'failed') reply.status = 'failed'
    const item = review(task)
    if (variant === 'stale') item.replyId = 'previous-attempt'
    const subject = fixture([
      { action: 'review_batch', reviews: variant === 'duplicate' ? [item, item] : [item], finish: true, message: 'invalid source' },
      (state) => {
        assert.equal(state.coordination!.tasks[0].status, 'review')
        assert.equal(state.coordination!.tasks[0].review, undefined)
        return { action: 'ask', message: 'Need valid evidence' }
      }
    ], { tasks: [task], replies: [reply] })
    await subject.run()
  }
})

test('historical reviews require a retained delivery reference, not just a status label', async () => {
  for (const reference of [false, true]) {
    const task = pending('historical')
    if (!reference) task.replyId = undefined
    const subject = fixture([
      { action: 'review_batch', reviews: [review(task)], finish: true, message: 'Evidence checked against retained delivery' },
      (state, extra) => {
        assert.deepEqual(state.coordination!.tasks, [])
        assert.match(extra, /缺少对应的最新交付回复/)
        return finish
      }
    ], { previousTasks: [task] })
    await subject.run()
    assert.equal(subject.counts().leadCalls, reference ? 1 : 2)
  }
})

test('invalid plans validate cycles and duplicate IDs before publishing recruits or artifacts', async () => {
  for (const tasks of [
    [{ ...spec('a', 'new-worker'), id: 'a', dependsOn: ['b'] }, { ...spec('b'), id: 'b', dependsOn: ['a'] }],
    [{ ...spec('a', 'new-worker'), id: 'duplicate' }, { ...spec('b'), id: 'duplicate' }],
    [{ ...spec('a', 'new-worker'), id: 'a', dependsOn: ['missing'] }]
  ]) {
    const subject = fixture([
      { action: 'plan', tasks, recruit, artifacts, message: 'invalid plan' },
      (state) => {
        assert.deepEqual(state.coordination!.tasks, [])
        assert.equal(subject.request.employees.length, 3)
        assert.deepEqual(subject.request.artifacts, [])
        assert.equal(state.sharedArtifacts, undefined)
        return finish
      }
    ])
    await subject.run()
  }
})

test('plan cycle validation includes existing tasks, not only the submitted subset', async () => {
  const a = { ...pending('a', ['b']), status: 'ready' as const, attempts: 0 }
  const b = { ...pending('b'), status: 'ready' as const, attempts: 0 }
  const subject = fixture([
    { action: 'plan', tasks: [{ ...spec('b'), id: 'b', dependsOn: ['a'] }], message: 'introduce cross-plan cycle' },
    (state, extra) => {
      assert.deepEqual(state.coordination!.tasks[1].dependencies, [])
      assert.match(extra, /依赖存在环/)
      return { action: 'ask', message: 'Need a revised dependency' }
    }
  ], { tasks: [a, b] })
  await subject.run()
})

test('invalid dispatch batches publish neither recruits nor artifacts and start no workers', async () => {
  const subject = fixture([
    { ...batch, tasks: [spec('new', 'new-worker'), spec('bad', 'missing')], recruit, artifacts },
    (state) => {
      assert.equal(subject.request.employees.length, 3)
      assert.deepEqual(subject.request.artifacts, [])
      assert.deepEqual(state.coordination!.tasks, [])
      return finish
    }
  ])
  await subject.run()
  assert.equal(subject.counts().workerCalls, 0)
})

test('valid same-decision recruitment and artifacts are visible when dispatch starts', async () => {
  const subject = fixture([
    { action: 'delegate', ...spec('new', 'new-worker'), recruit, artifacts, message: 'recruit and dispatch' }, finalBatch
  ], { worker: async (_task, _attempt, extra) => {
    assert.equal(subject.request.employees.at(-1)!.id, 'new-worker')
    assert.equal(subject.request.artifacts[0].content, 'VALID-CONTRACT')
    assert.match(extra, /实际验证命令/)
    return {}
  } })
  await subject.run()
  assert.equal(subject.counts().workerCalls, 1)
})

test('equivalent repeated plans cannot consume the whole coordinator budget or duplicate tasks', async () => {
  const plan = { action: 'plan', tasks: [spec('one')], message: 'plan' }
  const subject = fixture([plan, plan, plan, plan])
  await assert.rejects(subject.run(), /连续三次.*等价计划/)
  assert.equal(subject.counts().leadCalls, 4)
  assert.equal(subject.snapshot.coordination!.tasks.length, 1)
  assert.match(subject.instructions.at(-1)!, /delegate taskId=/)
})

test('plan cannot overwrite executed work or reset a failed task to ready', async () => {
  const task = { ...pending('one'), status: 'failed' as const, attempts: 2, error: 'build failed' }
  const subject = fixture([
    { action: 'plan', tasks: [{ ...spec('different'), id: task.id }], message: 'overwrite old work' },
    (state) => {
      assert.deepEqual(state.coordination!.tasks[0], task)
      return { action: 'ask', message: 'Need a new scope' }
    }
  ], { tasks: [task] })
  await subject.run()
})

test('equivalent dispatch cannot bypass task retry limits by omitting the original task ID', async () => {
  const definition = spec('one')
  const task: DelegatedTask = { id: 'original', title: definition.title, description: definition.description, acceptance: definition.acceptance, owner: 'worker', dependencies: [], status: 'failed', attempts: 3, error: 'exhausted' }
  const subject = fixture([
    { action: 'delegate', ...definition, employeeId: 'worker-two', message: 'new ID retry' },
    (state, extra) => {
      assert.deepEqual(state.coordination!.tasks, [task])
      assert.match(extra, /"remainingAttempts":0/)
      assert.match(extra, /"nextActions"/)
      assert.match(extra, /原 taskId/)
      return { action: 'ask', message: 'Need a different approach' }
    }
  ], { tasks: [task] })
  await subject.run()
  assert.equal(subject.counts().workerCalls, 0)
})

test('a new plan ID cannot clone exhausted work to reset its retry allowance', async () => {
  const definition = spec('one')
  const task: DelegatedTask = { id: 'original', title: definition.title, description: definition.description, acceptance: definition.acceptance, owner: 'worker', dependencies: [], status: 'failed', attempts: 3 }
  const subject = fixture([
    { action: 'plan', tasks: [{ ...definition, employeeId: 'worker-two', id: 'replacement-id' }], message: 'Repeat old work as new' },
    (state, extra) => {
      assert.deepEqual(state.coordination!.tasks, [task])
      assert.match(extra, /不要使用新计划 ID/)
      return { action: 'ask', message: 'Need a different scope' }
    }
  ], { tasks: [task] })
  await subject.run()
  assert.equal(subject.counts().workerCalls, 0)
})

test('rework retains review and execution failure context until a new result arrives', async () => {
  const definition = spec('one')
  const task: DelegatedTask = { id: 'original', title: definition.title, description: definition.description, acceptance: definition.acceptance, owner: 'worker', dependencies: [], status: 'failed', attempts: 1, error: 'BUILD-FAILED', review: 'FIX-NULL-HANDLING' }
  const subject = fixture([
    { action: 'delegate', ...definition, taskId: task.id, message: 'repair same task' },
    (state) => {
      assert.equal(state.coordination!.tasks[0].review, undefined)
      assert.equal(state.coordination!.tasks[0].error, undefined)
      return finalBatch(state)
    }
  ], { tasks: [task], worker: async (current, _attempt, extra) => {
    assert.equal(current.error, 'BUILD-FAILED')
    assert.equal(current.review, 'FIX-NULL-HANDLING')
    assert.match(extra, /BUILD-FAILED/)
    assert.match(extra, /FIX-NULL-HANDLING/)
    return {}
  } })
  await subject.run()
  assert.equal(subject.snapshot.coordination!.tasks[0].attempts, 2)
})

test('assistant storage failure cannot publish the decision plan, recruits or artifacts', async () => {
  let actions = 0
  const subject = fixture([
    { action: 'ask', tasks: [{ ...spec('one', 'new-worker'), id: 'one' }], recruit, artifacts,
      memoryUpdates: [{ kind: 'preference', content: 'explicit preference' }], message: 'save and ask' },
    (state) => {
      assert.deepEqual(state.coordination!.tasks, [])
      assert.equal(subject.request.employees.length, 3)
      assert.deepEqual(subject.request.artifacts, [])
      return finish
    }
  ], { assistantActions: async () => { actions++; throw new Error('storage rejected') } })
  await subject.run()
  assert.equal(actions, 1)
})
