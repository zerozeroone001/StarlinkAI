import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  seedTeams,
  isValidTeam,
  hasDependencyCycle,
  taskDependencies,
  recoverTaskGraph,
  createWorkspace,
  migrateLegacyTeam,
  parsePersonaFile,
  employeeReferenced
} from '../src/renderer/src/lib/collaboration-data.ts'

const task = (owner, id = 'task-1', dependency = null) => ({
  id,
  owner,
  dependency,
  title: '验证',
  description: '',
  acceptance: '',
  state: 'ready'
})
const legacy = () => ({
  id: 'legacy',
  name: '原有工作',
  goal: '保持记录',
  sample: false,
  paused: false,
  members: [
    { id: 'claude', name: 'Claude', role: '设计' },
    { id: 'codex', name: 'GPT', role: '开发' }
  ],
  tasks: [task('codex')],
  messages: [
    {
      id: 'm',
      author: 'claude',
      to: 'codex',
      text: '交接',
      time: '12:00',
      kind: 'handoff',
      sample: false,
      artifactId: 'a'
    }
  ],
  artifacts: [
    {
      id: 'a',
      name: '说明.md',
      description: '',
      owner: 'claude',
      version: 1,
      content: '# 说明',
      format: 'md',
      sample: false
    }
  ]
})

test('new spaces snapshot the selected model with one independent lead employee', () => {
  for (const kind of ['project', 'conversation']) {
    const workspace = createWorkspace(kind, 'gemini')
    assert.ok(isValidTeam(workspace))
    assert.equal(workspace.defaultProvider, 'gemini')
    assert.equal(workspace.members.length, 1)
    assert.equal(workspace.members[0].provider, 'gemini')
    assert.notEqual(workspace.members[0].id, 'gemini')
    assert.ok(workspace.members[0].isLead)
    createWorkspace(kind, 'claude')
    assert.equal(workspace.defaultProvider, 'gemini')
  }
  assert.ok(seedTeams().every(isValidTeam))
})

test('multiple employees can use the same model without sharing identity or ownership', () => {
  const w = createWorkspace('conversation', 'claude')
  w.members.push({
    ...w.members[0],
    id: 'employee-2',
    name: '自定义员工',
    isLead: false,
    role: '独立职责',
    persona: '简洁'
  })
  w.tasks.push(task('employee-2'))
  assert.ok(isValidTeam(w))
  assert.equal(employeeReferenced(w, 'employee-2'), true)
  assert.equal(employeeReferenced(w, w.members[0].id), false)
  w.members[1].persona = '严谨'
  assert.equal(w.members[0].persona, '')
  w.members[1].id = w.members[0].id
  assert.equal(isValidTeam(w), false)
})

test('project conversations copy employee configuration and later edits stay local', () => {
  const project = createWorkspace('project', 'codex', '项目')
  project.members[0].persona = '客观'
  const child = createWorkspace('conversation', 'grok', '', '', project)
  assert.equal(child.parentId, project.id)
  assert.equal(child.defaultProvider, 'codex')
  assert.notEqual(child.members[0].id, project.members[0].id)
  assert.ok(isValidTeam(child))
  child.members[0].persona = '友好'
  assert.equal(project.members[0].persona, '客观')
  project.members[0].role = '新的项目职责'
  assert.notEqual(child.members[0].role, project.members[0].role)
})

test('v1 migration preserves IDs and content while translating every employee reference', () => {
  const old = legacy()
  const migrated = migrateLegacyTeam(old)
  assert.ok(migrated && isValidTeam(migrated))
  assert.equal(migrated.id, old.id)
  assert.equal(migrated.name, old.name)
  assert.equal(migrated.kind, 'conversation')
  assert.equal(migrated.tasks[0].owner, migrated.members[1].id)
  assert.equal(migrated.messages[0].author, migrated.members[0].id)
  assert.equal(migrated.messages[0].to, migrated.members[1].id)
  assert.equal(migrated.artifacts[0].owner, migrated.members[0].id)
  assert.equal(migrated.messages[0].artifactId, 'a')
  assert.equal(migrated.artifacts[0].content, '# 说明')
  assert.deepEqual(old, legacy())
})

test('malformed snapshots and invalid legacy provider references are rejected without crashing', () => {
  for (const value of [
    null,
    {},
    [],
    { ...seedTeams()[0], members: [null] },
    { ...seedTeams()[0], tasks: [null] }
  ])
    assert.equal(isValidTeam(value), false)
  for (const value of [
    null,
    {},
    { ...legacy(), members: [null] },
    { ...legacy(), tasks: [null] },
    { ...legacy(), members: [{ id: 'unknown' }] }
  ])
    assert.equal(migrateLegacyTeam(value), null)
  const invalid = legacy()
  invalid.messages[0].to = 'unknown'
  assert.equal(migrateLegacyTeam(invalid), null)
})

test('a workspace has exactly one lead and a matching current model', () => {
  const w = seedTeams()[0]
  w.defaultProvider = 'unknown'
  assert.equal(isValidTeam(w), false)
  w.defaultProvider = 'claude'
  assert.equal(isValidTeam(w), false)
  w.defaultProvider = w.members[0].provider
  w.members[0].isLead = false
  assert.equal(isValidTeam(w), false)
  w.members[0].isLead = true
  w.members.push({ ...w.members[0], id: 'extra' })
  assert.equal(isValidTeam(w), false)
})

test('self, transitive and dangling task dependencies are rejected', () => {
  const w = seedTeams()[0]
  const owner = w.members[0].id
  w.tasks = [task(owner), task(owner, 'task-2', 'task-1'), task(owner, 'task-3', 'task-2')]
  assert.ok(isValidTeam(w))
  assert.equal(hasDependencyCycle(w.tasks, 'task-1', 'task-1'), true)
  assert.equal(hasDependencyCycle(w.tasks, 'task-1', 'task-3'), true)
  assert.equal(hasDependencyCycle(w.tasks, 'task-3', 'task-1'), false)
  w.tasks[0].dependency = 'task-3'
  assert.equal(isValidTeam(w), false)
  w.tasks[0].dependency = 'missing'
  assert.equal(isValidTeam(w), false)
})

test('all managed dependencies participate in cycle and missing-reference validation', () => {
  const workspace = seedTeams()[0]
  const owner = workspace.members[0].id
  workspace.tasks = [
    { ...task(owner, 'A', 'B'), managedDependencies: ['B', 'C'] },
    task(owner, 'B'),
    task(owner, 'C')
  ]
  assert.ok(isValidTeam(workspace))
  assert.deepEqual(taskDependencies(workspace.tasks[0]), ['B', 'C'])
  assert.equal(hasDependencyCycle(workspace.tasks, 'C', 'A'), true)
  workspace.tasks[2].dependency = 'A'
  assert.equal(isValidTeam(workspace), false)
  workspace.tasks[2].dependency = null
  workspace.tasks[0].managedDependencies = ['B', 'missing']
  assert.equal(isValidTeam(workspace), false)
})

test('editing the complete dependency selection removes old managed edges without hiding new cycles', () => {
  const workspace = seedTeams()[0]
  const owner = workspace.members[0].id
  workspace.tasks = [
    { ...task(owner, 'A', 'B'), managedDependencies: ['B', 'C'] },
    task(owner, 'B'),
    task(owner, 'C', 'A')
  ]
  assert.equal(hasDependencyCycle(workspace.tasks, 'A', 'B'), true)
  assert.equal(hasDependencyCycle(workspace.tasks, 'A', 'B', ['B']), false)
  assert.equal(hasDependencyCycle(workspace.tasks, 'A', null, []), false)
  assert.equal(hasDependencyCycle(workspace.tasks, 'A', 'B', ['B', 'A']), true)
})

test('recovering a saved dependency cycle preserves project content and requires explicit confirmation', () => {
  const workspace = seedTeams()[0]
  const owner = workspace.members[0].id
  workspace.messages.push({ id: 'kept-message', author: 'you', to: owner, text: 'Keep the original request', time: '12:00', kind: 'message', sample: false })
  workspace.tasks = [
    { ...task(owner, 'A', 'B'), managedDependencies: ['B', 'C'], state: 'done', resultRunId: 'delivery', acceptedRunId: 'delivery', reviewNote: 'Original review' },
    task(owner, 'B'), task(owner, 'C', 'A'), task(owner, 'unrelated')
  ]
  const before = structuredClone(workspace)
  assert.equal(isValidTeam(workspace), false)
  assert.equal([workspace].every(isValidTeam), false)
  assert.equal(isValidTeam(workspace, false), true)
  const recovered = recoverTaskGraph(workspace)
  assert.equal(isValidTeam(recovered), true)
  assert.deepEqual(workspace, before)
  assert.deepEqual(recovered.messages, workspace.messages)
  assert.deepEqual(recovered.members, workspace.members)
  assert.equal(recovered.tasks[0].title, workspace.tasks[0].title)
  assert.equal(recovered.tasks[0].state, 'ready')
  assert.equal(recovered.tasks[0].acceptedRunId, undefined)
  assert.equal(recovered.tasks[0].resultRunId, undefined)
  assert.deepEqual(taskDependencies(recovered.tasks[0]), [])
  assert.match(recovered.tasks[0].dependencyError, /B、C/)
  assert.match(recovered.tasks[0].reviewNote, /Original review/)
  assert.equal(recovered.tasks[3], workspace.tasks[3])
  assert.equal(recoverTaskGraph(recovered), recovered)
})

test('recovering a missing predecessor revokes affected downstream acceptance and still rejects invalid data shapes', () => {
  const workspace = seedTeams()[0]
  const owner = workspace.members[0].id
  workspace.tasks = [task(owner, 'root', 'missing'), { ...task(owner, 'downstream', 'root'), state: 'done', resultRunId: 'run', acceptedRunId: 'run' }]
  const recovered = recoverTaskGraph(workspace)
  assert.ok(recovered.tasks.every((item) => item.dependencyError && item.state === 'ready' && !item.acceptedRunId))
  assert.equal(isValidTeam({ ...workspace, tasks: [null] }, false), false)
  assert.equal(isValidTeam({ ...workspace, tasks: [workspace.tasks[0], workspace.tasks[0]] }, false), false)
})

test('persona imports accept plain text, BOM, JSON text and supported character fields', () => {
  assert.equal(parsePersonaFile('persona.md', '\uFEFF# 行为\n保持简洁'), '# 行为\n保持简洁')
  assert.equal(parsePersonaFile('tone.txt', '  友好  '), '友好')
  assert.equal(parsePersonaFile('tone.json', '"友好"'), '友好')
  assert.equal(
    parsePersonaFile('tone.JSON', '{"character":"虚构角色","behavior":"先给结论","tone":"温和"}'),
    '参考角色：虚构角色\n\n行为方式：先给结论\n\n语气：温和'
  )
})

test('persona import rejects malformed, empty, oversized or unsupported content', () => {
  for (const [name, content] of [
    ['x.exe', 'hello'],
    ['x.txt', ''],
    ['x.json', '{'],
    ['x.json', '[]'],
    ['x.json', '{}'],
    ['x.json', '{"tone": {"value":"温和"}}'],
    ['x.txt', 'a'.repeat(20001)],
    ['x.txt', 'a'.repeat(128 * 1024 + 1)]
  ]) {
    assert.throws(() => parsePersonaFile(name, content))
  }
})

test('project conversations preserve concrete model and reasoning snapshots', () => {
  const project = createWorkspace('project', 'codex', '模型继承验证')
  project.members[0].model = 'gpt-5.6-sol'
  project.members[0].effort = 'high'
  const child = createWorkspace('conversation', 'grok', '', '', project)
  assert.equal(child.members[0].model, 'gpt-5.6-sol')
  assert.equal(child.members[0].effort, 'high')
  child.members[0].effort = 'low'
  assert.equal(project.members[0].effort, 'high')
  assert.equal(isValidTeam(child), true)
})

test('invalid persisted model choices and execution statuses are rejected', () => {
  const workspace = createWorkspace('conversation', 'codex')
  workspace.members[0].model = { bad: true }
  assert.equal(isValidTeam(workspace), false)
  workspace.members[0].model = 'gpt-5.6-sol'
  workspace.messages.push({ id:'m',author:'you',to:workspace.members[0].id,text:'hello',time:'12:00',kind:'message',sample:false,status:'not-a-status' })
  assert.equal(isValidTeam(workspace), false)
})
