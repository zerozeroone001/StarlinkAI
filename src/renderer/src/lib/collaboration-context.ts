import { taskDependencies, type Team, type TeamMessage } from './collaboration-data'
import type { RunRequest } from '@shared/runtime'

// Compression belongs to the runtime so persona, skills, history and handoffs share one budget.
export function collaborationContext(
  team: Team,
  parent: Team | undefined,
  history: TeamMessage[],
  taskId?: string,
  siblings: Team[] = []
) {
  // Only explicit shared artifacts from this project may cross conversation boundaries.
  parent = parent?.id === team.parentId ? parent : undefined
  siblings = parent ? siblings.filter((sibling) => sibling.parentId === parent.id && sibling.id !== team.id) : []
  const context: RunRequest['context'] = []
  const artifacts: RunRequest['artifacts'] = []
  const goals = [parent?.goal ? `项目目标：${parent.goal}` : '', team.goal ? `当前目标：${team.goal}` : ''].filter(Boolean).join('\n\n')
  let contextTrimmed = goals.length > 5000
  const task = team.tasks.find((t) => t.id === taskId)
  const prerequisites = task ? taskDependencies(task).map((id) => team.tasks.find((item) => item.id === id))
    .filter((item): item is Team['tasks'][number] => !!item) : []
  const prerequisite = prerequisites.find((item) => item.id === task?.dependency)
  if (task) {
    artifacts.push({ name: '当前任务与前置任务.json', content: JSON.stringify({ task, prerequisites }) })
  }
  if (goals.length > 5000) artifacts.push({ name: '完整项目与当前目标.txt', content: goals })
  for (const message of history) {
    if (message.sample) continue
    const member = team.members.find((employee) => employee.id === message.author)
    const paths = (message.images || []).map((image) => image.path || '').filter((value) => value && value.length <= 4096)
    if (paths.length !== (message.images?.length || 0)) contextTrimmed = true
    // UI errors live outside the message body; include them in the budgeted text and archive.
    const text = message.text + (message.error ? `\n[运行时错误] ${message.error}` : '') +
      (paths.length ? `\n图片文件：${paths.join('\n')}` : '') +
      (message.attachments?.length ? `\n用户附件：${JSON.stringify(message.attachments.map(({ name, path }) => ({ name, path })))}` : '')
    context.push({ id: message.id, authorId: message.author,
      author: message.author === 'you' ? '用户' : message.authorName || member?.name || '系统',
      provider: message.provider || member?.provider, status: message.status, kind: message.kind,
      taskId: message.taskId, runId: message.runId, replyId: message.runtimeReplyId, text })
  }
  artifacts.push(
    ...[...team.artifacts].reverse().filter((a) => !a.sample).map((a) => ({ name: a.name, content: a.content })),
    ...[...(parent?.artifacts || [])].reverse().filter((a) => !a.sample).map((a) => ({ name: `项目共享：${a.name}`, content: a.content })),
    ...siblings.flatMap((sibling) =>
      [...sibling.artifacts].reverse().filter((a) => !a.sample).map((a) => ({
        name: `项目会话（${sibling.name}）共享：${a.name}`,
        content: a.content
      }))
    )
  )
  const projectTasks = [
    ...(parent?.tasks || []).map((t) => ({ scope: parent!.name, id: t.id, title: t.title, state: t.state, acceptance: t.acceptance })),
    ...siblings.flatMap((s) => s.tasks.map((t) => ({ scope: s.name, id: t.id, title: t.title, state: t.state, acceptance: t.acceptance })))
  ]
  if (projectTasks.length) {
    artifacts.push({
      name: '项目跨会话任务看板摘要.json',
      content: JSON.stringify(projectTasks.slice(-40))
    })
  }
  return { goal: goals.slice(0, 5000), context, artifacts, contextTrimmed,
    ...(task ? { task: { id: task.id, title: task.title, description: task.description, owner: task.owner,
      acceptance: task.acceptance, review: task.reviewNote,
      dependencies: prerequisites.map((prerequisite) => ({ id: prerequisite.id, state: prerequisite.state,
        ...(prerequisite.state === 'done' ? { acceptedRunId: prerequisite.acceptedRunId || prerequisite.resultRunId } : {}) })),
      dependency: prerequisite ? { id: prerequisite.id, state: prerequisite.state } : null } } : {}) }
}

export function historyForRetry(messages: TeamMessage[], sourceId: string, replyId?: string): TeamMessage[] {
  const sourceIndex = messages.findIndex((message) => message.id === sourceId)
  if (sourceIndex < 0) return []
  if (!replyId) return messages.slice(0, sourceIndex)
  const targetIndex = messages.findIndex((message) => message.id === replyId)
  const source = messages[sourceIndex]
  return messages.filter((message, index) => index < sourceIndex ||
    (index > sourceIndex && index < targetIndex && message.author !== 'you' &&
      (message.sourceMessageId === sourceId || (!!source.runId && message.runId === source.runId))))
}
