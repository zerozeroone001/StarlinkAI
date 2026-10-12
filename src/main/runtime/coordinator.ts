import { randomUUID } from 'node:crypto'
import type {
  DelegatedTask,
  RecruitedEmployee,
  RunReply,
  RunRequest,
  RunSnapshot,
  RuntimeEmployee,
  SharedArtifactUpdate
} from '../../shared/runtime'
import type { ProviderId } from '../../shared/types'
import { excerptText } from '../../shared/context'
import { extractSharedArtifacts, formatWorkReceipt } from './project-ledger'
import { ASSISTANT_LIMITS, type AssistantActions } from '../../shared/assistant'

export interface PlannedTaskSpec {
  id?: string
  employeeId: string
  title: string
  description: string
  acceptance: string
  dependsOn: string[]
}

export interface RecruitSpec {
  id?: string
  name: string
  provider?: ProviderId
  role: string
  persona?: string
}

export interface ArtifactSpec {
  name: string
  description?: string
  format?: 'md' | 'txt' | 'json' | 'csv'
  content: string
}

interface BaseDecision extends AssistantActions {
  recruit?: RecruitSpec[]
  artifacts?: ArtifactSpec[]
  message: string
}

interface ReviewSpec {
  taskId: string
  replyId?: string
  accepted: boolean
  evidence: string
}

export type Decision =
  | (BaseDecision & {
      action: 'delegate'
      employeeId: string
      taskId?: string
      title: string
      description: string
      acceptance: string
      dependsOn: string[]
    })
  | (BaseDecision & {
      action: 'delegate_parallel'
      tasks: {
        employeeId: string
        taskId?: string
        title: string
        description: string
        acceptance: string
        dependsOn: string[]
      }[]
    })
  | (BaseDecision & {
      action: 'plan'
      tasks: PlannedTaskSpec[]
      awaitConfirmation?: boolean
    })
  | (BaseDecision & {
      action: 'ask'
      tasks?: PlannedTaskSpec[]
    })
  | (BaseDecision & ReviewSpec & { action: 'review' })
  | (BaseDecision & {
      action: 'review_batch'
      reviews: ReviewSpec[]
      finish?: boolean
    })
  | (BaseDecision & {
      action: 'finish' | 'blocked'
    })

const VALID_PROVIDERS = new Set(['claude', 'codex', 'grok', 'gemini'])

function validTaskItem(item: any): boolean {
  const str = (v: unknown, max: number, req = true) =>
    typeof v === 'string' && v.length <= max && (!req || !!v.trim())
  return (
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    str(item.employeeId, 150) &&
    str(item.title, 100) &&
    str(item.description, 2000) &&
    str(item.acceptance, 1000) &&
    (item.id === undefined || str(item.id, 150)) &&
    (item.taskId === undefined || str(item.taskId, 150)) &&
    Array.isArray(item.dependsOn) &&
    item.dependsOn.length <= 20 &&
    item.dependsOn.every((id: unknown) => typeof id === 'string' && id.length <= 150)
  )
}

function validReviewItem(item: any): boolean {
  return !!item && typeof item === 'object' && !Array.isArray(item) &&
    typeof item.taskId === 'string' && !!item.taskId.trim() && item.taskId.length <= 150 &&
    (item.replyId === undefined || (typeof item.replyId === 'string' && !!item.replyId.trim() && item.replyId.length <= 150)) &&
    typeof item.accepted === 'boolean' && typeof item.evidence === 'string' &&
    !!item.evidence.trim() && item.evidence.length <= 2000
}

export function parseDecision(text: string): Decision {
  // Only a dedicated control response is executable; prose, worker output and history never are.
  const dispatchBlocks = [...text.matchAll(/```grok-dispatch\s*\n([\s\S]*?)\n```/g)]
  const blocks = dispatchBlocks.length
    ? dispatchBlocks
    : [...text.matchAll(/```(?:json|grok-dispatch)\s*\n([\s\S]*?)\n```/g)]
  if (blocks.length > 1) throw new Error('每次只允许一个调度 JSON 对象。')
  let value: any
  try {
    value = JSON.parse(blocks.length ? blocks[0][1] : text)
  } catch {
    // ACP streams tool preambles and the final answer through the same callback. Accept
    // one complete final control object after narration; never guess missing JSON syntax.
    if (blocks.length) throw new Error('调度代码块必须包含一个完整 JSON 对象。')
    const candidates: { value: any; end: number }[] = []
    for (const match of text.matchAll(/\{\s*"action"\s*:/g)) {
      let depth = 0,
        quoted = false,
        escaped = false
      for (let index = match.index!; index < text.length; index++) {
        const char = text[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
        } else if (char === '"') quoted = true
        else if (char === '{') depth++
        else if (char === '}' && --depth === 0) {
          try {
            candidates.push({ value: JSON.parse(text.slice(match.index, index + 1)), end: index + 1 })
          } catch {
            /* invalid JSON is not executable */
          }
          break
        }
      }
    }
    if (candidates.length !== 1 || text.slice(candidates[0].end).trim())
      throw new Error('调度回复必须包含唯一的完整最终 JSON 对象。')
    value = candidates[0].value
  }
  const str = (key: string, max: number, required = true) =>
    typeof value?.[key] === 'string' &&
    value[key].length <= max &&
    (!required || !!value[key].trim())
  if (!value || Array.isArray(value) || !str('message', 12000))
    throw new Error('调度说明缺失或过长。')
  const recordId = (id: unknown) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)
  const optionalId = (id: unknown) => id === undefined || recordId(id)
  const validText = (text: unknown, maximum: number) => typeof text === 'string' && !!text.trim() && text.length <= maximum && !text.includes('\0')
  if (value.memoryUpdates !== undefined && (!Array.isArray(value.memoryUpdates) || value.memoryUpdates.length > 10 ||
    value.memoryUpdates.some((item: any) => !item || !optionalId(item.id) || !validText(item.content, ASSISTANT_LIMITS.memory) ||
      !['preference', 'fact', 'agreement'].includes(item.kind) || Object.keys(item).some((key) => !['id', 'content', 'kind'].includes(key)))))
    throw new Error('助手记忆变更参数无效。')
  if (value.forgetMemoryIds !== undefined && (!Array.isArray(value.forgetMemoryIds) || value.forgetMemoryIds.length > 10 || !value.forgetMemoryIds.every(recordId)))
    throw new Error('助手记忆删除参数无效。')
  if (value.commitmentUpdates !== undefined && (!Array.isArray(value.commitmentUpdates) || value.commitmentUpdates.length > 10 ||
    value.commitmentUpdates.some((item: any) => !item || !optionalId(item.id) || !validText(item.title, ASSISTANT_LIMITS.commitment) ||
      (item.status !== undefined && !['open', 'done'].includes(item.status)) ||
      (item.dueAt !== undefined && item.dueAt !== null && (typeof item.dueAt !== 'string' || item.dueAt.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(item.dueAt) || !Number.isFinite(Date.parse(item.dueAt)))) ||
      Object.keys(item).some((key) => !['id', 'title', 'dueAt', 'status'].includes(key)))))
    throw new Error('助手提醒变更参数无效。')
  if (
    value.recruit !== undefined &&
    (!Array.isArray(value.recruit) ||
      value.recruit.length > 8 ||
      !value.recruit.every(
        (r: any) =>
          r &&
          typeof r === 'object' &&
          typeof r.name === 'string' &&
          r.name.trim().length > 0 &&
          r.name.length <= 60 &&
          typeof r.role === 'string' &&
          r.role.trim().length > 0 &&
          r.role.length <= 500 &&
          (r.id === undefined || (typeof r.id === 'string' && r.id.length <= 150)) &&
          (r.provider === undefined || VALID_PROVIDERS.has(r.provider)) &&
          (r.persona === undefined || (typeof r.persona === 'string' && r.persona.length <= 2000))
      ))
  ) {
    throw new Error('招募子 agent 参数无效。')
  }
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.length > 10 ||
      !value.artifacts.every(
        (a: any) =>
          a &&
          typeof a === 'object' &&
          typeof a.name === 'string' &&
          a.name.trim().length > 0 &&
          a.name.length <= 120 &&
          typeof a.content === 'string' &&
          a.content.trim().length > 0 &&
          a.content.length <= 120000 &&
          (a.description === undefined || (typeof a.description === 'string' && a.description.length <= 2000)) &&
          (a.format === undefined || ['md', 'txt', 'json', 'csv'].includes(a.format))
      ))
  ) {
    throw new Error('共享成果参数无效。')
  }
  if (
    value.action === 'delegate' &&
    str('employeeId', 150) &&
    str('title', 100) &&
    str('description', 2000) &&
    str('acceptance', 1000) &&
    (value.taskId === undefined || str('taskId', 150)) &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.length <= 20 &&
    value.dependsOn.every((id: unknown) => typeof id === 'string' && id.length <= 150)
  )
    return value
  if (
    value.action === 'delegate_parallel' &&
    Array.isArray(value.tasks) &&
    value.tasks.length >= 1 &&
    value.tasks.length <= 4 &&
    value.tasks.every(validTaskItem)
  )
    return value
  if (
    value.action === 'plan' &&
    Array.isArray(value.tasks) &&
    value.tasks.length >= 1 &&
    value.tasks.length <= 20 &&
    value.tasks.every(validTaskItem) &&
    (value.awaitConfirmation === undefined || typeof value.awaitConfirmation === 'boolean')
  )
    return value
  if (
    value.action === 'ask' &&
    (value.tasks === undefined ||
      (Array.isArray(value.tasks) && value.tasks.length <= 20 && value.tasks.every(validTaskItem)))
  )
    return value
  if (value.action === 'review' && validReviewItem(value)) return value
  if (value.action === 'review_batch' && Array.isArray(value.reviews) &&
    value.reviews.length >= 1 && value.reviews.length <= 20 && value.reviews.every(validReviewItem) &&
    (value.finish === undefined || typeof value.finish === 'boolean')) return value
  if (['finish', 'blocked'].includes(value.action)) return value
  throw new Error('调度指令参数无效。')
}

export const COORDINATOR_PROTOCOL = `你是用户的管家、个人助手、思考伙伴和当前空间的主 agent。根据用户当下需要自然交流、一起梳理想法、提供支持，或在确有执行需求时协调员工。简单问答、日常陪伴和讨论可直接 finish 回复，不必建立任务或把交流转为开发流程。需要实际执行时：分析需求 -> 必要时确认 -> 制定任务 -> 按员工职责分配 -> 检查验收并交付。能力、运行状态和完成情况必须诚实；没有宿主支持时不能声称后台监控、主动联系或将来自动行动。个人档案、私有记忆和私人聊天只供你理解用户，不得转交员工或写入项目共享成果；委派时仅提供完成任务所必需的公开资料。
宿主会执行你返回的调度指令，子 agent 执行结束后再次调用你，并提供真实结果与文件变更回执。最终回复只提供一个完整 JSON 对象，包裹在语言名为 grok-dispatch 的 Markdown 代码块中；只能有一个调度代码块。message 是向用户展示的沟通内容、任务规划说明、调度进度或最终回答。
1. 沟通确认（当需求范围不明确、需向用户提问或请用户确认方案后再启动开发时）：
{"action":"ask","tasks":[可选：预拟定的任务草案列表],"recruit":[可选：建议新增的子 agent],"message":"向用户提出的澄清问题、需求分析及初步任务规划"}。
2. 制定任务计划（当需求明确，一次性拆解完整开发任务清单上墙到任务看板时）：
{"action":"plan","recruit":[{"id":"emp-fe","name":"前端开发","provider":"claude","role":"负责小程序页面与交互实现"}],"tasks":[{"id":"task-1","employeeId":"员工 ID","title":"任务标题","description":"明确范围、交付文件和工作内容","acceptance":"可验证的验收要求","dependsOn":[]}],"awaitConfirmation":false,"artifacts":[{"name":"架构与接口设计.md","description":"全局技术规范","format":"md","content":"..."}],"message":"说明整体任务规划与分工"}。awaitConfirmation 为 true 时会先展示给用户确认；为 false 时立即进入后续调度执行。当空间缺少对应职责的子 agent 时，可在 recruit 中按职责自动添加子 agent。
3. 分配单任务：{"action":"delegate","employeeId":"名单中的员工 ID","taskId":"已规划或返工的任务 ID（新建时可省略）","title":"任务标题","description":"明确范围、交付文件和需执行的工作","acceptance":"可验证的验收要求","dependsOn":[],"message":"说明正在指派哪位子 agent 做什么"}。有依赖时填写已检查通过的任务 ID；返工必须填写同一 taskId。
4. 批量分配多任务（多个子任务无相互依赖时；当前宿主为保护同一工作目录，会依次执行）：
{"action":"delegate_parallel","tasks":[{"employeeId":"员工 ID","taskId":"可选","title":"任务标题","description":"...","acceptance":"...","dependsOn":[]}],"message":"说明正在批量调度哪些子 agent"}。
5. 检查验收：{"action":"review","taskId":"任务 ID","accepted":true,"evidence":"实际核对的文件、变更回执或测试证据","message":"检查结论"}。子 agent 执行成功只进入待检查；你必须依据交付物、工作回执和验收要求检查，不能只凭口头声称成功就通过。缺陷用 accepted:false，接着 delegate 同一 taskId 返工或改派其他子 agent。
多个结果已返回时，优先一次批量验收：{"action":"review_batch","reviews":[{"taskId":"任务 ID","replyId":"本次交付回复 ID","accepted":true,"evidence":"该任务对应的交付文件、回执、测试命令与结果；未验证项须明确说明"}],"finish":true,"message":"逐项验证后的最终交付"}。每项均须提供独立依据，replyId 必须对应任务最新交付；整批全部有效才提交。finish:true 仅在本轮全部任务通过检查时使用，可同轮交付而不再单独 finish；仍有待执行或返工任务则省略 finish。历史任务须有可定位的交付回复与实际验收证据；历史状态或员工自述不等于宿主独立验证。
6. 汇总交付：{"action":"finish","artifacts":[可选：最终汇总文档],"message":"用户可直接阅读的最终结果，包含交付物及验证结论"}。只有本轮所有任务通过你的检查后才可 finish。
7. 阻塞：{"action":"blocked","message":"无法继续的具体原因、已有成果以及用户需要补充的信息或操作"}。仅在遇到外部阻塞或错误无法继续时使用；正常向用户提问澄清请用 ask。
助手资料：仅当用户明确请求记住、更正、遗忘或设置提醒时，才能在 ask/finish 中附带 memoryUpdates:[{"id":"可选，更新已有记忆时填写","content":"事实或偏好","kind":"preference|fact|agreement"}]、forgetMemoryIds:["已有记忆ID"]、commitmentUpdates:[{"id":"可选","title":"提醒内容","dueAt":"带时区的ISO日期，可选","status":"open|done"}]。相对日期必须依据宿主提供的当前时间与时区计算；日期、具体时刻或时区不明确时先 ask。不要推测或固化用户情绪，不要自动记忆私密聊天。宿主才负责保存，若返回失败不得声称成功。提醒只是本应用内的提醒记录，不能声称自动重新执行工作或应用关闭后仍会主动通知。
调度效率与边界：目标、输入与验收已明确时直接 delegate 或一次批量分配，无需先 plan；仅较复杂依赖才单独规划。不要反复确认用户已授权的普通步骤，不确定但可安全核实的细节先检查，仅关键缺失信息、不可逆影响或真实阻塞才 ask。每项任务限定负责文件/模块、明确不做的范围、输入依赖、交付物及验收命令或可观测结果；员工失败或验收拒绝后，同一 taskId 返工并带上具体缺陷，不得通过新建等价任务绕过尝试上限。不要重复提交等价 plan、重复委派已待验收或已完成的工作。任务依赖必须无环；同目录始终依次执行。宿主反馈列出实际状态、剩余尝试与 nextActions，优先按反馈推进。
历史调度任务作为参考单独提供。用户要求继续之前的工作时，可 delegate 历史未完成或已规划（ready）任务的 taskId 来接续执行；有交付引用的历史待检查任务可 review。宿主自动执行最多 24 次，单个任务最多执行 3 次。`

export const ASSISTANT_CONVERSATION_PROTOCOL = `你正在与用户私下文字交流，可以自然聊天、陪伴、讨论和梳理想法。不要安排员工、开发任务、文件操作或共享成果。本轮只返回一个 grok-dispatch JSON 代码块，格式为 {"action":"finish","message":"自然回复"}；需要用户补充时用 action:"ask"。message 会直接显示给用户，不要在其中解释调度协议。
仅当用户明确请求记住、更正、遗忘或提醒时，可在这个对象附加 memoryUpdates:[{"id":"更新已有记录时填写，新建时省略","content":"用户明确要求记住的内容","kind":"preference|fact|agreement"}]、forgetMemoryIds:["已有记忆ID"]、commitmentUpdates:[{"id":"更新时填写，新建省略","title":"提醒内容","dueAt":"带时区的ISO时间，可省略","status":"open|done"}]。宿主会保存，若宿主反馈失败应更正或如实说明，不能继续声称已保存。不要推测用户情绪并自动保存。相对日期必须依据宿主提供的当前时间与时区计算；日期、具体时刻或时区不明确时先 ask，不猜测日期。提醒仅在应用打开时检查，不表示已安排自动执行。禁止 tasks、recruit、artifacts、delegate、review 等工作调度；需要实际工作时在文字中说明应切回工作模式。`

export async function coordinate(input: {
  request: RunRequest
  snapshot: RunSnapshot
  signal: AbortSignal
  availableProviders?: ProviderId[]
  conversationOnly?: boolean
  assistantActions?(actions: AssistantActions): Promise<void>
  run(
    employee: RuntimeEmployee,
    extra: string,
    task?: DelegatedTask,
    control?: boolean
  ): Promise<RunReply>
  changed(): Promise<void>
}) {
  const { request, snapshot, signal, run, changed } = input
  const state = snapshot.coordination!
  const lead = request.employees.find((employee) => employee.id === state.leadId)!
  let feedback = ''
  let invalid = 0
  let executions = 0
  const previousTasks = request.coordination?.previousTasks || []
  const compactTasks = (tasks: DelegatedTask[]) =>
    tasks.map((task) => ({
      ...task,
      description: excerptText(task.description, 200),
      acceptance: excerptText(task.acceptance, 400),
      review: task.review ? excerptText(task.review, 300) : undefined,
      error: task.error ? excerptText(task.error, 300) : undefined
    }))
  const previous = (id: string) => previousTasks.find((task) => task.id === id)
  const copyTask = (task: DelegatedTask): DelegatedTask => ({ ...task, dependencies: [...task.dependencies] })
  const createDraft = () => ({
    employees: [...request.employees],
    tasks: state.tasks.map(copyTask),
    recruited: [...(state.recruited || [])],
    sharedArtifacts: [...(snapshot.sharedArtifacts || [])],
    artifacts: [...request.artifacts]
  })
  type Draft = ReturnType<typeof createDraft>
  const passed = (id: string, tasks: DelegatedTask[]) =>
    (tasks.find((task) => task.id === id) || previous(id))?.status === 'completed'
  const commitDraft = (draft: Draft) => {
    signal.throwIfAborted()
    request.employees = draft.employees
    request.artifacts = draft.artifacts
    state.tasks = draft.tasks
    if (state.recruited || draft.recruited.length) state.recruited = draft.recruited
    if (snapshot.sharedArtifacts || draft.sharedArtifacts.length) snapshot.sharedArtifacts = draft.sharedArtifacts
  }
  const upsertArtifact = (draft: Draft, item: SharedArtifactUpdate) => {
    const idx = draft.sharedArtifacts.findIndex((a) => a.name === item.name)
    if (idx >= 0) draft.sharedArtifacts[idx] = item
    else draft.sharedArtifacts.push(item)
    const reqIdx = draft.artifacts.findIndex((a) => a.name === item.name)
    if (reqIdx >= 0) draft.artifacts[reqIdx] = { name: item.name, content: item.content }
    else draft.artifacts.push({ name: item.name, content: item.content })
  }
  const applyRecruitsAndArtifacts = (decision: Decision, draft: Draft) => {
    if (decision.recruit?.length) {
      const allowedProviders = input.availableProviders?.length
        ? input.availableProviders
        : [lead.provider]
      for (const spec of decision.recruit) {
        const existing = draft.employees.find(
          (e) => e.id === spec.id || e.name.trim() === spec.name.trim()
        )
        if (existing) continue
        const chosenProvider =
          spec.provider && allowedProviders.includes(spec.provider)
            ? spec.provider
            : allowedProviders[0] || lead.provider
        const id =
          spec.id &&
          /^[\w:-]{1,120}$/.test(spec.id) &&
          !['you', 'system', 'all'].includes(spec.id) &&
          !draft.employees.some((e) => e.id === spec.id)
            ? spec.id
            : `employee-${randomUUID()}`
        const member: RecruitedEmployee = {
          id,
          name: spec.name.trim(),
          provider: chosenProvider,
          role: spec.role.trim(),
          persona: (spec.persona || '').trim(),
          isLead: false
        }
        draft.employees.push(member)
        draft.recruited.push(member)
      }
    }
    if (decision.artifacts?.length) {
      for (const art of decision.artifacts) {
        const format = (
          ['md', 'txt', 'json', 'csv'].includes(String(art.format)) ? art.format : 'md'
        ) as SharedArtifactUpdate['format']
        const name = /\.(md|txt|json|csv)$/i.test(art.name.trim())
          ? art.name.trim()
          : `${art.name.trim()}.${format}`
        const item: SharedArtifactUpdate = {
          name,
          description: (art.description || '主 agent 共享文档').trim(),
          owner: lead.id,
          format,
          content: art.content
        }
        upsertArtifact(draft, item)
      }
    }
  }

  const sameScope = (task: DelegatedTask, spec: PlannedTaskSpec) =>
    task.title === spec.title && task.description === spec.description &&
    task.acceptance === spec.acceptance && task.dependencies.length === new Set(spec.dependsOn).size &&
    task.dependencies.every((id) => spec.dependsOn.includes(id))
  const validateDependencies = (tasks: DelegatedTask[]) => {
    const graph = new Map([...previousTasks, ...tasks].map((task) => [task.id, task]))
    const visiting = new Set<string>(), visited = new Set<string>()
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error(`任务依赖存在环（${id}），请拆除循环依赖。`)
      if (visited.has(id)) return
      const task = graph.get(id)
      if (!task) throw new Error(`前置依赖 ID（${id}）不存在。`)
      visiting.add(id)
      for (const dependency of task.dependencies) visit(dependency)
      visiting.delete(id)
      visited.add(id)
    }
    for (const task of tasks) visit(task.id)
  }
  const registerPlannedTasks = (specs: PlannedTaskSpec[], draft: Draft) => {
    const staged: DelegatedTask[] = []
    for (const [idx, spec] of specs.entries()) {
      const employee = draft.employees.find((m) => m.id === spec.employeeId)
      if (!employee) throw new Error(`员工 ID（${spec.employeeId}）不在当前空间名单中。`)
      if (spec.id && !/^[\w:-]{1,120}$/.test(spec.id)) throw new Error('计划任务 ID 格式无效。')
      const equivalent = !spec.id ? [...draft.tasks, ...staged].find((task) => task.owner === employee.id && sameScope(task, spec)) : undefined
      const id = spec.id || equivalent?.id || `delegated-${randomUUID()}-${idx + 1}`
      if (staged.some((task) => task.id === id)) throw new Error(`计划中任务 ID（${id}）重复。`)
      const duplicate = [...draft.tasks, ...staged].find((task) => task.id !== id && sameScope(task, spec))
      if (duplicate) throw new Error(`等价任务 ${duplicate.id} 已存在；请沿用原 taskId，不要使用新计划 ID 重复创建。`)
      const existing = draft.tasks.find((t) => t.id === id) || previous(id)
      if (existing && (existing.status !== 'ready' || existing.attempts > 0)) {
        if (existing.owner !== employee.id || !sameScope(existing, spec))
          throw new Error(`任务 ${id} 已执行，不可用 plan 覆盖；返工请 delegate 同一 taskId，新范围请创建新任务。`)
        staged.push(copyTask(existing))
        continue
      }
      staged.push({
        id,
        title: spec.title,
        description: spec.description,
        acceptance: spec.acceptance,
        owner: employee.id,
        dependencies: [...new Set(spec.dependsOn)],
        status: 'ready',
        attempts: existing?.attempts || 0
      })
    }
    for (const task of staged) {
      const idx = draft.tasks.findIndex((t) => t.id === task.id)
      if (idx >= 0) draft.tasks[idx] = task
      else draft.tasks.push(task)
    }
    validateDependencies(draft.tasks)
  }

  const prepareDelegatedTask = (spec: {
    employeeId: string
    taskId?: string
    title: string
    description: string
    acceptance: string
    dependsOn: string[]
  }, draft: Draft, staged: DelegatedTask[] = []): { employee: RuntimeEmployee; task: DelegatedTask } => {
    const employee = draft.employees.find((member) => member.id === spec.employeeId)
    if (!employee) throw new Error('员工 ID 不在当前空间名单中。')
    if (executions + staged.length >= 24)
      throw new Error('已达到本轮 24 次执行预算，请汇总当前状态并返回 blocked。')
    let task = spec.taskId
      ? [...staged, ...draft.tasks].find((item) => item.id === spec.taskId)
      : [...staged, ...draft.tasks].find(
          (item) =>
            item.status === 'ready' &&
            item.attempts === 0 &&
            item.title === spec.title &&
            item.owner === employee.id
        )
    if (!spec.taskId && !task) {
      const duplicate = [...staged, ...draft.tasks].find((item) => sameScope(item, spec))
      if (duplicate) throw new Error(`等价任务 ${duplicate.id} 已存在（${duplicate.status}）；请验收或使用原 taskId 返工，不要重复创建。`)
    }
    if (task) task = { ...task, dependencies: [...task.dependencies] }
    const historical = spec.taskId && !task ? previous(spec.taskId) : undefined
    if (historical && historical.status !== 'completed') {
      task = {
        ...historical,
        dependencies: [...historical.dependencies],
        attempts: 0,
        status:
          historical.status === 'review'
            ? 'review'
            : historical.status === 'ready'
              ? 'ready'
              : 'failed'
      }
    }
    if (spec.taskId && !task) throw new Error('返工任务 ID 不存在。')
    if (task && !['ready', 'failed', 'review'].includes(task.status))
      throw new Error('仅失败或待检查任务可返工；已通过的任务请创建后续任务。')
    if (task && task.attempts >= 3)
      throw new Error('此任务已经执行三次，请选择其他方案或返回 blocked。')
    if (
      task &&
      task.status !== 'ready' &&
      (task.title !== spec.title || task.dependencies.join('\0') !== spec.dependsOn.join('\0'))
    )
      throw new Error('返工须保持任务标题和依赖，新的工作请创建新任务。')
    if (spec.dependsOn.some((id) => id === task?.id || !passed(id, draft.tasks)))
      throw new Error('前置任务必须存在并由主 agent 检查通过。')
    if (!task) {
      task = {
        id: `delegated-${randomUUID()}`,
        title: spec.title,
        description: spec.description,
        acceptance: spec.acceptance,
        owner: employee.id,
        dependencies: [...new Set(spec.dependsOn)],
        status: 'ready',
        attempts: 0
      }
    }
    task.owner = employee.id
    task.title = spec.title
    task.description = spec.description
    task.acceptance = spec.acceptance
    task.dependencies = [...new Set(spec.dependsOn)]
    task.status = 'working'
    task.attempts++
    return { employee, task }
  }

  const reviewTasks = (reviews: ReviewSpec[], draft: Draft) => {
    const seen = new Set<string>()
    for (const review of reviews) {
      if (seen.has(review.taskId)) throw new Error(`同批不能重复检查任务 ${review.taskId}。`)
      seen.add(review.taskId)
      let task = draft.tasks.find((item) => item.id === review.taskId)
      if (!task) {
        const historical = previous(review.taskId)
        if (historical?.status === 'review') {
          task = { ...copyTask(historical), attempts: 0 }
          draft.tasks.push(task)
        }
      }
      if (!task || task.status !== 'review') throw new Error('只能检查已经执行成功且待检查的任务。')
      if (!task.replyId || (review.replyId !== undefined && review.replyId !== task.replyId))
        throw new Error(`任务 ${task.id} 缺少对应的最新交付回复，不能验收；请检查交付或重新执行。`)
      const source = snapshot.replies.find((reply) => reply.id === task.replyId)
      const historical = previous(task.id)
      if ((!source && (historical?.status !== 'review' || historical.replyId !== task.replyId)) ||
        (source && (source.status !== 'completed' || source.taskId !== task.id || source.employeeId !== task.owner)))
        throw new Error(`任务 ${task.id} 的交付回复与当前执行不匹配，不能验收。`)
      task.review = review.evidence
      task.status = review.accepted ? 'completed' : 'failed'
    }
    validateDependencies(draft.tasks)
    // Evaluate dependencies against the whole staged batch, independent of response order.
    for (const review of reviews) {
      const task = draft.tasks.find((item) => item.id === review.taskId)!
      if (review.accepted && task.dependencies.some((id) => !passed(id, draft.tasks)))
        throw new Error('前置任务必须检查通过后才能验收后续结果；整批检查尚未提交。')
    }
  }

  const statusFeedback = (reason?: string) => JSON.stringify({
    ...(reason ? { reason } : {}),
    remainingExecutions: Math.max(0, 24 - executions),
    remainingCorrections: Math.max(0, 3 - invalid),
    tasks: state.tasks.map(({ id, status, attempts, replyId, review, error }) => ({
      id, status, attempts, remainingAttempts: Math.max(0, 3 - attempts), replyId,
      ...(review ? { review: excerptText(review, 500) } : {}),
      ...(error ? { error: excerptText(error, 500) } : {})
    })),
    nextActions: [
      ...(state.tasks.some((task) => task.status === 'review') ? ['review_batch（逐项 evidence，可全部通过后 finish:true）或 review'] : []),
      ...state.tasks.filter((task) => ['ready', 'failed'].includes(task.status) && task.attempts < 3 && executions < 24 && task.dependencies.every((id) => passed(id, state.tasks)))
        .map((task) => `delegate taskId=${task.id}`),
      ...(state.tasks.every((task) => task.status === 'completed') ? ['finish'] : []),
      '仅确需用户补充时 ask；无法继续时 blocked'
    ]
  })

  const commitDelegatedTask = (task: DelegatedTask) => {
    signal.throwIfAborted()
    const index = state.tasks.findIndex((item) => item.id === task.id)
    if (index < 0) state.tasks.push(task)
    else state.tasks[index] = task
    executions++
  }

  for (let round = 0; round < (input.conversationOnly ? 3 : 72); round++) {
    signal.throwIfAborted()
    state.phase = state.tasks.some((task) => task.status === 'review') ? 'reviewing' : 'planning'
    await changed()
    const extra = input.conversationOnly ? ASSISTANT_CONVERSATION_PROTOCOL + (feedback ? `\n宿主反馈：${feedback}` : '') :
      COORDINATOR_PROTOCOL +
      '\n员工名单（只有所列 ID 可以被指派，长职责为原文摘录）：\n' +
      JSON.stringify(
        request.employees.map(({ id, name, provider, role, model, effort }) => ({
          id,
          name,
          provider,
          role: excerptText(role, 400),
          model,
          effort
        }))
      ) +
      '\n本轮任务的实际状态（completed 表示主 agent 已检查通过；长文本为原文摘录，完整交付需读取交接和文件核对）：\n' +
      JSON.stringify(compactTasks(state.tasks)) +
      '\n历史调度任务参考（按用户当前意图选择是否接续，长内容见共享存档）：\n' +
      JSON.stringify(
        previousTasks.map((task) => ({
          id: task.id,
          title: task.title,
          owner: task.owner,
          status: task.status,
          dependencies: task.dependencies
        }))
      ) +
      '\n宿主调度状态与可执行下一步：\n' + statusFeedback() +
      (feedback ? `\n宿主反馈：${feedback}` : '')
    const execution = await run(lead, extra, undefined, true)
    const reply = snapshot.replies.find((item) => item.id === execution.id)!
    signal.throwIfAborted()
    const raw = execution.text
    // Keep control JSON out of the conversation and out of future worker handoffs.
    reply.text = ''
    reply.kind = 'decision'
    try {
      const decision = parseDecision(raw)
      if (input.conversationOnly && (!['ask', 'finish'].includes(decision.action) ||
        'tasks' in decision || decision.recruit !== undefined || decision.artifacts !== undefined))
        throw new Error('纯聊天仅允许 ask/finish 和用户明确要求的助手记忆或提醒，不执行工作调度。')
      const hasAssistantActions = !!(decision.memoryUpdates?.length || decision.forgetMemoryIds?.length || decision.commitmentUpdates?.length)
      const assistantActions: AssistantActions = {
        memoryUpdates: decision.memoryUpdates,
        forgetMemoryIds: decision.forgetMemoryIds,
        commitmentUpdates: decision.commitmentUpdates
      }
      if (hasAssistantActions && (!input.assistantActions || !['ask', 'finish'].includes(decision.action)))
        throw new Error('当前助手资料变更不可执行；请在有助手空间的 ask 或 finish 中提交。')
      // Stage the entire decision before any roster, plan, artifact or review becomes visible.
      const draft = createDraft()
      const before = JSON.stringify(draft)
      applyRecruitsAndArtifacts(decision, draft)
      const extracted = input.conversationOnly
        ? { cleanText: decision.message, artifacts: [] }
        : extractSharedArtifacts(decision.message, lead.id)
      for (const art of extracted.artifacts) upsertArtifact(draft, art)
      const displayMessage = extracted.cleanText || decision.message
      const prepared: ReturnType<typeof prepareDelegatedTask>[] = []
      if ((decision.action === 'ask' || decision.action === 'plan') && decision.tasks?.length)
        registerPlannedTasks(decision.tasks, draft)
      if (decision.action === 'plan' && JSON.stringify(draft) === before)
        throw new Error('等价计划已登记，未产生新任务或变更；请按现有 taskId 分配、验收或交付，不要重复 plan。')
      if (decision.action === 'delegate') prepared.push(prepareDelegatedTask(decision, draft))
      if (decision.action === 'delegate_parallel')
        for (const spec of decision.tasks) prepared.push(prepareDelegatedTask(spec, draft, prepared.map((item) => item.task)))
      if (decision.action === 'review') reviewTasks([decision], draft)
      if (decision.action === 'review_batch') reviewTasks(decision.reviews, draft)
      if ((decision.action === 'finish' || (decision.action === 'review_batch' && decision.finish)) &&
        draft.tasks.some((task) => task.status !== 'completed'))
        throw new Error('还有未通过检查的任务，不能宣告完成，请继续调度或返回 blocked。')
      if (hasAssistantActions) await input.assistantActions!(assistantActions)
      commitDraft(draft)
      if (decision.action === 'ask') {
        reply.text = displayMessage
        reply.kind = 'message'
        state.phase = 'completed'
        await changed()
        return
      } else if (decision.action === 'plan') {
        reply.text = displayMessage
        if (decision.awaitConfirmation) {
          reply.kind = 'message'
          state.phase = 'completed'
          await changed()
          return
        }
        feedback = `已将 ${decision.tasks.length} 项开发任务登记到任务看板（状态 ready）。请立即按依赖关系使用 delegate 或 delegate_parallel 分配给对应子 agent 执行。`
      } else if (decision.action === 'delegate') {
        const { employee, task } = prepared[0]
        commitDelegatedTask(task)
        state.phase = 'executing'
        reply.text = displayMessage
        await changed()
        const worker = await run(
          employee,
          `主 agent 已分配任务：${JSON.stringify(task)}\n严格限定本任务范围，遵守已有项目约定，不改无关文件。返工须逐项解决上次 review/error，不得重复声称成功。返回交付文件、实际验证命令与结果、未验证/未完成项及阻塞；缺乏证据应如实说明。若产出了可供团队复用的设计文档、接口契约或规范，可使用 \`\`\`grok-artifact 代码块（首行 JSON 含 name/description/format）沉淀为共享成果。后续由主 agent 检查并继续调度，不要冒充已获得检查通过。`,
          task
        )
        task.replyId = worker.id
        task.status = worker.status === 'completed' ? 'review' : 'failed'
        task.error = worker.error
        task.review = undefined
        const receiptNote = formatWorkReceipt(worker.receipt)
        feedback = `任务 ${task.id} 执行${task.status === 'review' ? '结束，须检查' : '失败，可返工或改派'}。${receiptNote ? `宿主工作回执：${receiptNote}` : ''}`
      } else if (decision.action === 'delegate_parallel') {
        state.phase = 'executing'
        reply.text = displayMessage
        const summaries: string[] = []
        // Validate the whole batch before mutating state, then serialize writes to the shared cwd.
        for (const { employee, task } of prepared) {
          commitDelegatedTask(task)
          await changed()
          const worker = await run(
            employee,
            `主 agent 已批量分配任务（同目录内依次执行）：${JSON.stringify(task)}\n严格限定本任务范围，遵守已有项目约定，不改无关文件。返工须解决上次 review/error。返回交付文件、实际验证命令与结果、未验证/未完成项及阻塞；缺乏证据应如实说明。后续由主 agent 检查并继续调度，不要冒充已获得检查通过。`,
            task
          )
          task.replyId = worker.id
          task.status = worker.status === 'completed' ? 'review' : 'failed'
          task.error = worker.error
          task.review = undefined
          const receiptNote = formatWorkReceipt(worker.receipt)
          summaries.push(
            `任务 ${task.id}（${task.title}）${task.status === 'review' ? '待检查' : '执行失败'}${receiptNote ? ` [${receiptNote}]` : ''}`
          )
        }
        feedback = `批量任务执行结束：${summaries.join('；')}。请用 review_batch 一次逐项检查；全部任务通过时可附 finish:true 同轮交付。`
      } else if (decision.action === 'review' || decision.action === 'review_batch') {
        const reviews = decision.action === 'review' ? [decision] : decision.reviews
        reply.text = `${displayMessage}\n\n检查依据：${reviews.map((review) => `${review.taskId}：${review.evidence}`).join('\n')}`
        if (decision.action === 'review_batch' && decision.finish) {
          reply.kind = 'message'
          state.phase = 'completed'
          await changed()
          return
        }
        const remainingReady = state.tasks.filter((t) => t.status === 'ready').map((t) => t.id)
        feedback = reviews.map((review) => `任务 ${review.taskId} ${review.accepted ? '检查通过' : '检查未通过，需要按原 taskId 返工'}`).join('；') +
          (remainingReady.length ? `；待推进任务：${remainingReady.join('、')}。` : '。请按实际任务状态继续或交付。')
      } else if (decision.action === 'finish') {
        reply.text = displayMessage
        reply.kind = 'message'
        state.phase = 'completed'
        await changed()
        return
      } else {
        reply.text = displayMessage
        state.phase = 'blocked'
        await changed()
        throw new Error(decision.message)
      }
      invalid = 0
      await changed()
    } catch (error) {
      if (state.phase === 'blocked' || signal.aborted) throw error
      const reason = error instanceof Error ? error.message : '调度指令无法执行。'
      invalid++
      feedback = `${statusFeedback(reason)}\n请按 nextActions 纠正，最终回复用唯一的 grok-dispatch 代码块包裹一个调度 JSON 对象。你上次返回的内容（仅供纠错）：${JSON.stringify(excerptText(raw, 2000))}`
      reply.text ||= `调度指令未执行：${reason}`
      await changed()
      if (invalid >= 3) throw new Error(`主 agent 连续三次未提供可执行的调度指令：${reason}`)
    }
  }
  throw new Error('本轮调度次数已达到上限，已有成果已保留，请继续处理未完成任务。')
}

