import type { DelegatedTask, RunRequest } from '../../shared/runtime'
import type { Handoff } from './context'
import { excerptText } from '../../shared/context'

export interface WorkerFocus {
  task: DelegatedTask
  tasks: DelegatedTask[]
}

interface WorkerSource {
  taskId: string
  role: 'accepted-prerequisite' | 'previous-attempt'
  id?: string
  replyId?: string
  runId?: string
  author: string
  authorId?: string
  provider?: string
  status?: string
  text: string
  compressed?: boolean
}

export function focusWorkerContext(request: RunRequest, handoffs: Handoff[], focus?: WorkerFocus) {
  const task = focus?.task || request.task
  if (!task) return undefined
  const tasks = new Map(focus?.tasks.map((item) => [item.id, item]))
  const dependencies = focus
    ? [...new Set(focus.task.dependencies)].map((id) => ({
      id, state: tasks.get(id)?.status || 'missing', replyId: tasks.get(id)?.replyId,
      acceptedRunId: undefined as string | undefined, owner: tasks.get(id)?.owner
    }))
    : [...new Map<string, { id: string; state: string; acceptedRunId?: string }>([...(request.task?.dependency ? [request.task.dependency] : []),
      ...(request.task?.dependencies || [])].map((item) => [item.id, item])).values()]
      .map((item) => ({ ...item, replyId: undefined as string | undefined, owner: undefined as string | undefined }))
  const records: WorkerSource[] = [...request.context.map((record) => ({
    ...record, taskId: record.taskId || '', role: 'accepted-prerequisite' as const
  })), ...handoffs.map((item) => ({
    id: item.id, replyId: item.id, taskId: item.taskId || '', author: item.name, authorId: item.employeeId,
    provider: item.provider, status: item.status,
    text: item.text + (item.images.length ? `\n图片文件：${item.images.join('\n')}` : ''),
    compressed: item.truncated, role: 'accepted-prerequisite' as const
  }))]
  const sources: WorkerSource[] = []
  const selectedIds = new Set<string>()
  const add = (record: WorkerSource, taskId: string, role: WorkerSource['role']) => {
    const key = record.replyId || record.id
    if (key && selectedIds.has(key)) return
    if (key) selectedIds.add(key)
    sources.push({ ...record, taskId, role })
  }
  const sourceFor = (id: string, replyId?: string, runId?: string, accepted = true) => {
    const candidates = records.filter((record) => (!accepted || record.status === 'completed') &&
      record.authorId !== 'you' && record.author !== '用户' && record.author !== 'you' &&
      (!record.taskId || record.taskId === id) &&
      (replyId ? record.replyId === replyId || record.id === replyId
        : runId ? record.runId === runId && (!record.taskId || record.taskId === id)
          : record.taskId === id))
    // Without a persisted run/reply identity, only the latest task result is evidence.
    return replyId || runId ? candidates : candidates.slice(-1)
  }
  const prerequisites = dependencies.map((dependency) => {
    const accepted = dependency.state === 'done' || dependency.state === 'completed'
    const outputs = accepted ? sourceFor(dependency.id, dependency.replyId, dependency.acceptedRunId) : []
    for (const record of outputs) add(record, dependency.id, 'accepted-prerequisite')
    return { ...dependency, accepted, outputAvailable: outputs.length > 0,
      outputBinding: dependency.replyId ? 'reply' : dependency.acceptedRunId ? 'run' : 'legacy-latest-task-record' }
  })
  const previous = sourceFor(task.id, focus?.task.replyId, undefined, false)
  for (const record of previous) add(record, task.id, 'previous-attempt')
  const context = request.context.filter((record) => {
    if ((record.replyId && selectedIds.has(record.replyId)) || (record.id && selectedIds.has(record.id))) return false
    const user = record.authorId === 'you' || record.author === '用户'
    return (!record.taskId || record.taskId === task.id) && (user || record.kind === 'decision')
  })
  const contract = {
    projectGoal: request.goal,
    task: { id: task.id, title: task.title, description: task.description, acceptance: task.acceptance,
      owner: task.owner, review: task.review, ...(focus ? { previousError: focus.task.error } : {}) },
    prerequisites,
    evidence: sources.map(({ text: _text, ...source }) => source)
  }
  const represented = new Set(sources.flatMap((source) => [source.id, source.replyId].filter(Boolean)))
  const filteredMessages = request.context.filter((record) => !context.includes(record) &&
    !(record.id && represented.has(record.id)) && !(record.replyId && represented.has(record.replyId))).length
  const filteredHandoffs = handoffs.filter((item) => !item.id || !represented.has(item.id)).length
  return { request: { ...request, context }, sources, contract, filteredMessages, filteredHandoffs }
}

// Every dependency keeps a source-labelled excerpt; none can consume another's allocation.
function minimumWorkerSources(sources: WorkerSource[]) {
  return sources.map((source) => ({ ...source, text: excerptText(source.text, 160),
    ...(source.text.length > 160 ? { compressed: true } : {}) }))
}

export function workerSourceMinimumBudget(sources: WorkerSource[]) {
  return JSON.stringify(minimumWorkerSources(sources)).length
}

export function compactWorkerSources(sources: WorkerSource[], budget: number) {
  if (!sources.length) return { text: '[]', compressed: 0 }
  const full = JSON.stringify(sources)
  if (full.length <= budget) return { text: full, compressed: sources.filter((source) => source.compressed).length }
  const minimum = minimumWorkerSources(sources)
  const minimumSize = JSON.stringify(minimum).length
  if (minimumSize > budget) throw new Error('任务前置交付的来源与摘录超过上下文预算，请减少前置任务或缩短本次输入；未丢弃验收要求。')
  let remaining = budget - minimumSize
  let compressed = 0
  const values = minimum.map((value, index) => {
    const source = sources[index]
    const base = JSON.stringify(value).length
    const allowance = base + Math.floor(remaining / (sources.length - index))
    let low = Math.min(160, source.text.length), high = Math.min(source.text.length, allowance), best = value
    while (low <= high) {
      const limit = Math.floor((low + high) / 2)
      const candidate = { ...source, text: excerptText(source.text, limit),
        ...(limit < source.text.length ? { compressed: true } : {}) }
      if (JSON.stringify(candidate).length <= allowance) { best = candidate; low = limit + 1 }
      else high = limit - 1
    }
    remaining -= JSON.stringify(best).length - base
    if (best.compressed) compressed++
    return best
  })
  return { text: JSON.stringify(values), compressed }
}
