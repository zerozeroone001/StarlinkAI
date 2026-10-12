import { hasDependencyCycle, taskDependencies, type Team } from './collaboration-data'

export interface TaskSchedule {
  remaining: string[]
  status: 'running' | 'waiting_review' | 'paused' | 'failed' | 'completed'
  runId?: string
  taskId?: string
  error?: string
}

export function affectedTasks(team: Team, roots: Iterable<string>) {
  const affected = new Set(roots)
  for (let changed = true; changed;) {
    changed = false
    for (const task of team.tasks) if (taskDependencies(task).some((id) => affected.has(id)) && !affected.has(task.id)) {
      affected.add(task.id); changed = true
    }
  }
  return affected
}

export function invalidateTaskResults(team: Team, affected: Set<string>) {
  return team.tasks.map((task) => affected.has(task.id)
    ? { ...task, state: 'ready' as const, resultRunId: undefined, acceptedRunId: undefined,
      ...(task.managedRunId ? { managedStatus: 'failed' as const, reviewNote: undefined } : {}) } : task)
}

export function selectScheduledTask(team: Team, remaining: string[]) {
  const unconfirmed = team.tasks.find((task) => task.dependencyError)
  if (unconfirmed) return { error: `任务“${unconfirmed.title}”的依赖需要编辑确认后再调度。` }
  if (team.tasks.some((task) => taskDependencies(task).some((id) => !team.tasks.some((item) => item.id === id)) ||
    hasDependencyCycle(team.tasks, task.id, task.dependency)))
    return { error: '任务依赖存在循环或引用了不存在的任务，请修改后重新安排。' }
  const tasks = remaining.map((id) => team.tasks.find((task) => task.id === id))
  if (tasks.some((task) => !task)) return { error: '队列中的任务已被删除，请重新安排。' }
  const pending = tasks.filter((task) => task && !['done', 'review'].includes(task.state))
  const ready = pending.find((task) => task!.state === 'ready' &&
    taskDependencies(task!)
      .every((id) => team.tasks.some((previous) => previous.id === id && previous.state === 'done')))
  return { task: ready, pending: pending.map((task) => task!.id), waiting: !ready && pending.length > 0 }
}

export function taskPrompt(task: Team['tasks'][number]) {
  return `请执行任务：${task.title}\n\n任务说明：${task.description}\n\n验收标准：${task.acceptance || '清楚说明交付结果。'}` +
    (task.reviewNote ? `\n\n上一轮评审与返工要求：${task.reviewNote}` : '') +
    '\n\n交接时逐项对照验收标准列明实际产出、文件路径、已运行的验证和未完成事项；不得把计划运行的验证写成已运行。完成后等待用户验收。'
}
