import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { conversationFeed, conversationSearchText } from '../src/renderer/src/lib/conversation-feed'
import { createWorkspace, type TeamMessage } from '../src/renderer/src/lib/collaboration-data'
import { ExecutionDetails } from '../src/renderer/src/components/ExecutionDetails'
import { CollaborationWorkspace } from '../src/renderer/src/components/CollaborationWorkspace'
import { useCollaboration } from '../src/renderer/src/stores/collaboration'
import { useProviders } from '../src/renderer/src/stores/providers'
import type { RunPermissionRecord, RunSnapshot, WorkReceipt } from '../src/shared/runtime'

useCollaboration.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })

function message(id: string, patch: Partial<TeamMessage> = {}): TeamMessage {
  return { id, author: 'worker', to: 'all', time: '10:00', kind: 'message', sample: false,
    runId: 'run-a', runtimeReplyId: id, status: 'completed', text: `Body ${id}`, ...patch }
}
function approval(id: string, patch: Partial<TeamMessage> = {}, permissionPatch: Partial<RunPermissionRecord> = {}): TeamMessage {
  const author = patch.author || 'worker'
  const permission: RunPermissionRecord = {
    id, employeeId: author, replyId: 'reply-a', title: 'Write fixture.txt',
    detail: JSON.stringify({ file_path: 'fixture.txt', content: `RAW-PAYLOAD-${id}` }),
    options: [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }],
    createdAt: '2026-10-09T00:00:00Z', status: 'answered', optionId: 'allow', optionLabel: 'Yes',
    ...permissionPatch
  }
  return message(`permission-${id}`, { author, text: `Approval ${id}`, ...patch, toolPermission: permission })
}
function liveRun(tools: TeamMessage[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return { id: 'run-a', workspaceId: 'workspace', status: 'needs_permission', createdAt: '', replies: [],
    contextTrimmed: false, permissions: tools.map((tool) => tool.toolPermission!), ...patch }
}
function renderDetails(tools: TeamMessage[], runs: Record<string, RunSnapshot> = {}, receipt?: WorkReceipt) {
  return renderToStaticMarkup(createElement(ExecutionDetails, {
    tools, runs, receipt, onAnswer: async () => assert.fail('Rendering must never submit an approval')
  }))
}
function enclosingDetails(html: string, offset: number): string[] {
  const stack: string[] = []
  for (const match of html.slice(0, offset).matchAll(/<\/?details\b[^>]*>/g)) {
    if (match[0].startsWith('</')) stack.pop()
    else stack.push(match[0])
  }
  return stack
}
function historySummary(html: string): string {
  return /<details class="execution-history"[^>]*>\s*<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] || ''
}

test('multiple answered approvals project into their reply without changing persisted messages', () => {
  const input = [message('user', { author: 'you', text: 'Please edit' }), message('reply-a'),
    approval('first'), approval('second'), approval('third')]
  const saved = structuredClone(input)
  const feed = conversationFeed(input)
  assert.deepEqual(input, saved)
  assert.deepEqual(feed.map((item) => item.id), ['user', 'reply-a'])
  assert.deepEqual(feed[1].toolMessages.map((item) => item.toolPermission!.id), ['first', 'second', 'third'])
  assert.equal(feed.filter((item) => item.toolPermission).length, 0)
  assert.equal(input.filter((item) => item.toolPermission).length, 3)
})

test('same permission id stays isolated across run, employee, and reply identities', () => {
  const replies = [
    message('a', { runtimeReplyId: 'reply-a' }),
    message('b', { runtimeReplyId: 'reply-b' }),
    message('other-employee', { author: 'reviewer', runtimeReplyId: 'reply-a' }),
    message('other-run', { runId: 'run-b', runtimeReplyId: 'reply-a' })
  ]
  const tools = [approval('shared', { id: 'tool-a' }),
    approval('shared', { id: 'tool-b' }, { replyId: 'reply-b' }),
    approval('shared', { id: 'tool-reviewer', author: 'reviewer' }),
    approval('shared', { id: 'tool-run-b', runId: 'run-b' })]
  const feed = conversationFeed([...replies, ...tools])
  for (let index = 0; index < replies.length; index++) {
    const item = feed.find((entry) => entry.id === replies[index].id)!
    assert.deepEqual(item.toolMessages.map((tool) => tool.id), [tools[index].id], replies[index].id)
  }
})

test('duplicate permission history for the same run, employee and reply appears only once', () => {
  const first = approval('duplicate')
  const feed = conversationFeed([message('reply-a'), first, structuredClone(first),
    { ...structuredClone(first), id: 'replayed-message' }])
  assert.equal(feed.length, 1)
  assert.equal(feed[0].toolMessages.length, 1)
})

test('orphan history remains available as a collapsible activity group without a fake reply', () => {
  const feed = conversationFeed([approval('orphan-a'), approval('orphan-b')])
  assert.equal(feed.length, 1)
  assert.equal(feed[0].activityOnly, true)
  assert.equal(feed[0].text, '')
  assert.equal(feed[0].toolMessages.length, 2)
  const html = renderDetails(feed[0].toolMessages)
  assert.match(html, /<details class="execution-history"/)
  assert.match(html, /2 项工具审批/)
  assert.match(html, /RAW-PAYLOAD-orphan-a/)
  assert.doesNotMatch(html, /<button|<details[^>]*\sopen(?:[\s=>])/)
})

test('orphan history does not mix employees that share a reply id', () => {
  const feed = conversationFeed([approval('orphan-a'), approval('orphan-b', { author: 'reviewer' })])
  assert.equal(feed.length, 2)
  assert.deepEqual(feed.map((item) => item.toolMessages.map((tool) => tool.author)), [['worker'], ['reviewer']])
})

test('unknown reply history never attaches to another reply from the same employee', () => {
  const feed = conversationFeed([message('reply-b'), approval('historical')])
  assert.equal(feed.find((item) => item.id === 'reply-b')!.toolMessages.length, 0)
  assert.equal(feed.find((item) => item.activityOnly)!.toolMessages[0].toolPermission!.replyId, 'reply-a')
})

test('projection preserves body, error, image, attachment, artifact and receipt messages', () => {
  const input = [
    message('body', { text: 'Visible response' }),
    message('error', { text: '', status: 'failed', error: 'Model unavailable' }),
    message('image', { text: '', images: [{ dataUrl: 'data:image/png;base64,ZmFrZQ==', alt: 'Generated image' }] }),
    message('attachment', { text: '', attachments: [{ id: 'file', name: 'fixture.txt', mime: 'text/plain', size: 1, path: 'fixture.txt' }] }),
    message('artifact', { text: '', artifactId: 'result-file' }),
    message('receipt', { text: '', receipt: { commands: [{ command: 'npm test', exitCode: 1, summary: 'One test failed' }] } })
  ]
  const feed = conversationFeed(input)
  assert.deepEqual(feed.map(({ toolMessages: _tools, ...entry }) => entry), input)
})

test('empty completed placeholders may disappear while running and actionable replies remain', () => {
  const feed = conversationFeed([
    message('internal-empty', { text: '' }), message('internal-whitespace', { text: '   ' }),
    message('running', { text: '', status: 'running' }), message('queued', { text: '', status: 'queued' }),
    message('needs-permission', { text: '', status: 'needs_permission' }),
    message('reply-a', { text: '' }), approval('tool')
  ])
  assert.deepEqual(feed.map((entry) => entry.id), ['running', 'queued', 'needs-permission', 'reply-a'])
})

test('search still finds folded tool titles and raw details alongside reply text and errors', () => {
  const entry = conversationFeed([message('reply-a', { error: 'Connection failure' }), approval('searchable')])[0]
  const searchable = conversationSearchText(entry)
  for (const text of ['body reply-a', 'connection failure', 'write fixture.txt', 'raw-payload-searchable'])
    assert.ok(searchable.includes(text), text)
})

test('pending approval buttons stay outside every collapsed history or raw-detail disclosure', () => {
  const pending = approval('pending', {}, { status: 'pending', optionId: undefined, optionLabel: undefined })
  const html = renderDetails([approval('history'), pending], { 'run-a': liveRun([pending]) })
  const buttons = [...html.matchAll(/<button\b/g)]
  assert.equal(buttons.length, 2)
  for (const button of buttons) assert.deepEqual(enclosingDetails(html, button.index!), [])
  assert.match(html, />允许本次<\/button>/)
  assert.match(html, />拒绝本次<\/button>/)
  assert.ok(html.indexOf('<button') < html.indexOf('<details class="execution-history"'))
})

test('missing, finished, failed or foreign runs never resurrect historical approval buttons', () => {
  const pending = approval('pending', {}, { status: 'pending' })
  const variants = [
    {}, { 'run-b': liveRun([pending], { id: 'run-b' }) },
    ...(['completed', 'failed', 'cancelled'] as const).map((status) => ({ 'run-a': liveRun([pending], { status }) })),
    { 'run-a': liveRun([]) }
  ]
  for (const runs of variants) assert.doesNotMatch(renderDetails([pending], runs), /<button\b/)
})

test('answered history does not gain buttons from a stale pending snapshot with the same id', () => {
  const answered = approval('stale')
  assert.doesNotMatch(renderDetails([answered], { 'run-a': liveRun([answered]) }), /<button\b/)
})

test('live approval lookup also matches employee and reply identity', () => {
  const pending = approval('collision', {}, { status: 'pending' })
  const otherEmployee = approval('collision', { author: 'reviewer' }, { status: 'pending' })
  const otherReply = approval('collision', {}, { status: 'pending', replyId: 'reply-b' })
  for (const foreign of [otherEmployee, otherReply])
    assert.doesNotMatch(renderDetails([pending], { 'run-a': liveRun([foreign]) }), /<button\b/)
})

test('raw JSON is present for inspection and closed by default', () => {
  const html = renderDetails([approval('raw')])
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])/)
  const rawOffset = html.indexOf('RAW-PAYLOAD-raw')
  assert.ok(rawOffset >= 0)
  assert.ok(enclosingDetails(html, rawOffset).length >= 2, 'raw payload must be inside both history and per-tool disclosures')
})

test('collapsed history names command failures and renders structured receipts as readable text', () => {
  const html = renderDetails([], {}, {
    filesModified: ['src/example.ts', 'src/example.ts'],
    commands: [{ command: 'npm test', exitCode: 1, summary: 'ASSERTION-FAILURE' }, { command: 'npm run build', exitCode: 0 }]
  })
  const summary = historySummary(html)
  assert.match(summary, /1 条命令失败/)
  assert.match(summary, /2 条命令/)
  assert.match(summary, /修改 1 个文件/)
  assert.match(html, /npm test|ASSERTION-FAILURE/)
  assert.match(html, /退出码 1/)
  assert.doesNotMatch(html, /\[object Object\]|<details[^>]*\sopen(?:[\s=>])/)
})

test('denied tools are labelled denied rather than successful execution', () => {
  const html = renderDetails([approval('denied', {}, { optionId: 'deny', optionLabel: 'No' })])
  assert.match(historySummary(html), /1 项已拒绝/)
  assert.match(html, /execution-tool-state">已拒绝/)
  assert.doesNotMatch(html, /执行成功|已成功|已允许|execution-tool-state">已完成/)
  assert.doesNotMatch(html, /<button\b/)
})

test('workspace renders one reply bubble for grouped approvals and retains the saved audit trail', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const initial = useCollaboration.getState(), initialProviders = useProviders.getState()
  const team = createWorkspace('conversation', 'grok'), lead = team.members[0]
  team.sample = false
  team.messages = [message('reply-a', { author: lead.id, text: 'VISIBLE-REPLY-TEXT', error: 'VISIBLE-ERROR',
    images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', alt: 'VISIBLE-IMAGE' }] }),
    approval('one', { author: lead.id }), approval('two', { author: lead.id })]
  const saved = structuredClone(team.messages)
  useCollaboration.setState({ teams: [team], activeTeamId: team.id, runs: {}, drafts: {}, attachmentDrafts: {}, taskSchedules: {}, runtimeError: null })
  useProviders.setState({ checked: true, checking: false, error: null, diagnostics: [] })
  try {
    const html = renderToStaticMarkup(createElement(CollaborationWorkspace))
    assert.equal([...html.matchAll(/<article class="team-message /g)].length, 1)
    assert.match(html, /VISIBLE-REPLY-TEXT/)
    assert.match(html, /VISIBLE-ERROR/)
    assert.match(html, /<img[^>]*alt="VISIBLE-IMAGE"/)
    assert.match(html, /2 项工具审批/)
    assert.equal([...html.matchAll(/class="execution-history"/g)].length, 1)
    assert.deepEqual(useCollaboration.getState().teams[0].messages, saved)
  } finally { useCollaboration.setState(initial); useProviders.setState(initialProviders) }
})
