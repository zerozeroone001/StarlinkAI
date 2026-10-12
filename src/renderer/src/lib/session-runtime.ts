import { extractMediaFromContent, extractMediaFromText, unwrapText } from '@shared/media'
import type {
  ChatImage,
  ChatMessage,
  HistoryCursor,
  PermissionRequest,
  PlanItem,
  ThreadMeta,
  ThreadStatus,
  ToolCallState
} from '@shared/types'

export const NEW_THREAD_KEY = '__new__'

export interface ThreadRuntime {
  messages: ChatMessage[]
  running: boolean
  plan: PlanItem[]
  permission: PermissionRequest | null
  historyCursor: HistoryCursor | null
  hasMoreHistory: boolean
  loadingHistory: boolean
}

export function emptyRuntime(): ThreadRuntime {
  return {
    messages: [],
    running: false,
    plan: [],
    permission: null,
    historyCursor: null,
    hasMoreHistory: false,
    loadingHistory: false
  }
}

export function uid(): string {
  return crypto.randomUUID()
}

function chunkText(update: Record<string, unknown>): string {
  const content = update.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
  }
  if (typeof update.text === 'string') return update.text
  return ''
}

function appendStreaming(
  messages: ChatMessage[],
  kind: 'assistant' | 'thinking',
  text: string
): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last?.kind === kind && last.streaming) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [
    ...messages,
    {
      id: uid(),
      kind,
      text,
      createdAt: new Date().toISOString(),
      streaming: true
    }
  ]
}

export function applySessionUpdate(
  runtime: ThreadRuntime,
  update: Record<string, unknown>
): ThreadRuntime {
  const kind = String(update.sessionUpdate || update.type || '')
  const text = chunkText(update)

  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const media = extractMediaFromContent(update.content).concat(extractMediaFromText(text))
    if (!text && media.length) {
      const last = runtime.messages[runtime.messages.length - 1]
      if (last?.kind === 'assistant') {
        return {
          ...runtime,
          running: true,
          messages: [
            ...runtime.messages.slice(0, -1),
            { ...last, images: mergeImages(last.images, media) }
          ]
        }
      }
      return {
        ...runtime,
        running: true,
        messages: [
          ...runtime.messages,
          {
            id: uid(),
            kind: 'assistant',
            text: '',
            createdAt: new Date().toISOString(),
            images: media,
            streaming: true
          }
        ]
      }
    }
    const messages = appendStreaming(runtime.messages, 'assistant', text)
    if (media.length) {
      const last = messages[messages.length - 1]
      messages[messages.length - 1] = { ...last, images: mergeImages(last.images, media) }
    }
    return { ...runtime, running: true, messages }
  }

  if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
    return {
      ...runtime,
      messages: appendStreaming(runtime.messages, 'thinking', text)
    }
  }

  if (kind === 'tool_call') {
    const rec = update
    const title = String(rec.title || rec.kind || rec.name || 'tool')
    const images = extractMediaFromContent(rec.content || rec.rawOutput)
    const tool: ToolCallState = {
      id: String(rec.toolCallId || uid()),
      name: String(rec.name || rec.title || rec.kind || 'tool'),
      kind: rec.kind as string | undefined,
      title,
      status: (rec.status as ToolCallState['status']) || 'in_progress',
      input: rec.rawInput || rec.input,
      path: (rec.locations as Array<{ path?: string }> | undefined)?.[0]?.path || images[0]?.path,
      images: images.length ? images : undefined
    }
    return {
      ...runtime,
      running: true,
      messages: [
        ...runtime.messages,
        { id: tool.id, kind: 'tool', text: '', createdAt: new Date().toISOString(), tool }
      ]
    }
  }

  if (kind === 'tool_call_update') {
    const rec = update
    const id = String(rec.toolCallId || '')
    return {
      ...runtime,
      messages: runtime.messages.map((m) => {
        if (m.tool?.id !== id) return m
        const content = rec.content
        let output = m.tool.output
        let diff = m.tool.diff
        const text = unwrapText(content)
        if (text) output = text
        if (Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if (part.type === 'diff' && typeof part.diff === 'string') diff = part.diff
            if (part.type === 'content' && typeof part.text === 'string') output = part.text
          }
        }
        const images = mergeImages(
          m.tool.images,
          extractMediaFromContent(content),
          extractMediaFromContent(rec.rawOutput),
          extractMediaFromContent(rec.locations),
          extractMediaFromText(text)
        )
        const path = m.tool.path || images[0]?.path
        return {
          ...m,
          tool: {
            ...m.tool,
            status: (rec.status as ToolCallState['status']) || m.tool.status,
            output,
            diff,
            path,
            images: images.length ? images : m.tool.images,
            title: String(rec.title || m.tool.title),
            kind: (rec.kind as string) || m.tool.kind
          }
        }
      })
    }
  }

  if (kind === 'plan') {
    return { ...runtime, plan: (update.entries as PlanItem[]) || [] }
  }

  return runtime
}

export function finishRun(runtime: ThreadRuntime): ThreadRuntime {
  return {
    ...runtime,
    running: false,
    permission: null,
    messages: runtime.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
  }
}

export function withThreadStatus(
  threads: ThreadMeta[],
  id: string,
  status: ThreadStatus,
  patch?: Partial<ThreadMeta>
): ThreadMeta[] {
  return threads.map((t) =>
    t.id === id ? { ...t, status, updatedAt: new Date().toISOString(), ...patch } : t
  )
}

export function mergeDiskThreads(disk: ThreadMeta[], local: ThreadMeta[]): ThreadMeta[] {
  const localById = new Map(local.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const out: ThreadMeta[] = []
  for (const t of disk) {
    seen.add(t.id)
    const live = localById.get(t.id)
    if (live && (live.status === 'running' || live.status === 'needs_input')) {
      out.push({
        ...t,
        status: live.status,
        unread: live.unread,
        title: t.title || live.title
      })
    } else if (live) {
      out.push({
        ...t,
        status: live.status === 'error' ? 'error' : t.status,
        unread: live.unread
      })
    } else {
      out.push(t)
    }
  }
  for (const t of local) {
    if (!seen.has(t.id)) out.unshift(t)
  }
  return out
}

function mergeImages(...lists: Array<ChatImage[] | undefined>): ChatImage[] {
  const out: ChatImage[] = []
  for (const list of lists) {
    if (!list) continue
    for (const img of list) {
      const key = img.dataUrl || img.path || ''
      if (!key) continue
      if (out.some((item) => (item.dataUrl || item.path) === key)) continue
      out.push(img)
    }
  }
  return out
}

export function visibleThreads(list: ThreadMeta[], limit = 12): ThreadMeta[] {
  const live = list.filter((t) => t.status === 'running' || t.status === 'needs_input')
  const rest = list.filter((t) => t.status !== 'running' && t.status !== 'needs_input')
  const out = [...live]
  for (const t of rest) {
    if (out.length >= Math.max(limit, live.length)) break
    out.push(t)
  }
  return out
}
