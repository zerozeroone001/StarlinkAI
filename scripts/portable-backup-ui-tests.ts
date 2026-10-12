import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { portableCountRows, portableErrorMessage, portableProgressLabel, portableProgressValue, portableSize } from '../src/renderer/src/lib/portable-backup-display'
import { AssistantPanel } from '../src/renderer/src/components/AssistantPanel'
import { WorkspaceDialog } from '../src/renderer/src/components/WorkspaceDialogs'
import { useAssistant } from '../src/renderer/src/stores/assistant'
import type { AssistantSnapshot } from '../src/shared/assistant'

test('portable summary includes assistant records and actual included bytes separately from references', () => {
  const rows = Object.fromEntries(portableCountRows({ projects: 1, conversations: 2, messages: 3, drafts: 4,
    assistants: 5, memories: 6, reminders: 7, attachments: 8, images: 9, files: 2, bytes: 2048 }))
  assert.equal(rows['助手资料'], '5'); assert.equal(rows['记忆'], '6'); assert.equal(rows['提醒'], '7')
  assert.equal(rows['附件引用'], '8'); assert.equal(rows['图片引用'], '9'); assert.equal(rows['已包含文件'], '2 个 · 2.0 KiB')
  assert.equal(rows['草稿'], '4')
})
test('unknown progress remains indeterminate and backend completion is not a durable success message', () => {
  const progress = { phase: 'preparing' as const, done: 0, total: 0, cancellable: true }
  assert.equal(portableProgressValue(progress), undefined)
  assert.equal(portableProgressValue({ ...progress, done: Number.NaN, total: 10 }), undefined)
  assert.deepEqual(portableProgressValue({ ...progress, done: 15, total: 10 }), { value: 10, max: 10 })
  assert.doesNotMatch(portableProgressLabel('complete'), /已保存|恢复成功|已完成/)
  assert.match(portableProgressLabel('committing'), /提交并保存/)
})
test('failure messaging preserves the partial commit instruction and omits IPC stack wrappers', () => {
  const instruction = '数据已写入，恢复收尾尚未确认；请重试加载工作区，不要重复导入。'
  assert.equal(portableErrorMessage(new Error(`Error invoking remote method 'backup:reconcile': Error: ${instruction}\n at internal.js:20`)), instruction)
  assert.doesNotMatch(portableErrorMessage(new Error('磁盘暂不可用\n at private-file.ts:10')), /private-file| at /)
  assert.equal(portableSize(0), '0 B'); assert.equal(portableSize(1024 * 1024), '1.0 MiB')
  assert.equal(portableSize(Infinity), '未知大小')
})
test('committing dialogs visibly disable their close action', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceDialog, { title: '恢复中', close: () => {}, closeDisabled: true, children: '正在提交' }))
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="关闭弹窗"/)
})
test('restored reminders explain their paused state and require an explicit resume action', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const previous = useAssistant.getState(), oldWindow = globalThis.window
  t.after(() => { useAssistant.setState(previous); globalThis.window = oldWindow })
  globalThis.window = { grok: { backup: {} } } as Window & typeof globalThis
  const snapshot: AssistantSnapshot = { profile: { scopeId: 'restored-project', name: 'Saved assistant', addressing: '', persona: '', style: 'balanced', updatedAt: '' },
    revision: 7, remindersPaused: true, memories: [], commitments: [{ id: 'retained-reminder', title: 'Saved reminder', dueAt: '2099-01-01T00:00:00Z', status: 'open', createdAt: '', updatedAt: '' }] }
  useAssistant.setState({ snapshots: { [snapshot.profile.scopeId]: snapshot }, loading: {}, saving: {}, errors: {} })
  const html = renderToStaticMarkup(createElement(AssistantPanel, { scopeId: snapshot.profile.scopeId, onClose: () => {}, initialTab: 'commitments' }))
  assert.match(html, /提醒通知已暂停/); assert.match(html, /Saved reminder/)
  assert.match(html, /恢复此助手的提醒通知/); assert.match(html, /不会自动执行任务/)
  assert.doesNotMatch(html, /通知已恢复/)
  useAssistant.setState({ saving: { [snapshot.profile.scopeId]: 1 } })
  const saving = renderToStaticMarkup(createElement(AssistantPanel, { scopeId: snapshot.profile.scopeId, onClose: () => {}, initialTab: 'commitments' }))
  assert.match(saving, /<button[^>]*disabled=""[^>]*>恢复此助手的提醒通知/)
})
test('legacy assistant snapshots do not claim reminders were paused or offer a resume action', (t) => {
  t.mock.method(React, 'useSyncExternalStore', (_subscribe, getSnapshot) => getSnapshot())
  const previous = useAssistant.getState(), oldWindow = globalThis.window
  t.after(() => { useAssistant.setState(previous); globalThis.window = oldWindow })
  globalThis.window = { grok: { backup: {} } } as Window & typeof globalThis
  useAssistant.setState({ snapshots: { legacy: { profile: { scopeId: 'legacy', name: 'Legacy assistant', addressing: '', persona: '', style: 'balanced', updatedAt: '' }, revision: 1, memories: [], commitments: [] } }, saving: {}, loading: {}, errors: {} })
  const html = renderToStaticMarkup(createElement(AssistantPanel, { scopeId: 'legacy', onClose: () => {}, initialTab: 'commitments' }))
  assert.doesNotMatch(html, /提醒通知已暂停|恢复此助手的提醒通知/)
})
