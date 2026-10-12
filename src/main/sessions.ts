import fs from 'node:fs'
import path from 'node:path'
import { extractMediaFromContent, extractMediaFromText, unwrapText } from '../shared/media'
import type {
  ChatImage,
  ChatMessage,
  HistoryCursor,
  HistoryPage,
  Project,
  PromptAttachment,
  ThreadMeta,
  ToolCallState
} from '../shared/types'
import { grokHome } from './paths'

interface SummaryFile {
  info?: { id?: string; cwd?: string }
  session_summary?: string
  generated_title?: string
  created_at?: string
  updated_at?: string
  last_active_at?: string
  current_model_id?: string
  reasoning_effort?: string
  num_messages?: number
}

const HISTORY_PAGE_SIZE = 30
const HISTORY_READ_CHUNK_BYTES = 256 * 1024

interface HistoryLine {
  offset: number
  text: string
}

interface ParsedHistoryMessage {
  sourceOffset: number
  sourceIndex: number
  message: ChatMessage
}

function readHistoryWindow(
  file: string,
  before: number,
  bytes: number,
  keepFirstLine = false
): HistoryLine[] {
  const start = Math.max(0, before - bytes)
  const length = before - start
  const buffer = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  let bytesRead = 0
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, start)
  } finally {
    fs.closeSync(fd)
  }
  let cursor = 0
  // An arbitrary read window normally starts in the middle of a JSONL record.
  // Keep only complete records so every returned cursor is a stable byte boundary.
  if (start > 0 && !keepFirstLine) {
    const firstBreak = buffer.indexOf(10, 0)
    if (firstBreak < 0 || firstBreak >= bytesRead) return []
    cursor = firstBreak + 1
  }

  const lines: HistoryLine[] = []
  while (cursor < bytesRead) {
    const nextBreak = buffer.indexOf(10, cursor)
    const end = nextBreak >= 0 && nextBreak < bytesRead ? nextBreak : bytesRead
    let text = buffer.toString('utf8', cursor, end)
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (text.trim()) lines.push({ offset: start + cursor, text })
    if (nextBreak < 0 || nextBreak >= bytesRead) break
    cursor = nextBreak + 1
  }
  return lines
}

function uniqueImages(...lists: ChatImage[][]): ChatImage[] {
  const out: ChatImage[] = []
  const seen = new Set<string>()
  for (const image of lists.flat()) {
    const key = image.dataUrl || image.path || ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(image)
  }
  return out
}

function walkSummaries(root: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(root)) return out

  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === 'summary.json') out.push(full)
    }
  }
  return out
}

export function listThreads(): ThreadMeta[] {
  const files = walkSummaries(path.join(grokHome(), 'sessions'))
  const threads: ThreadMeta[] = []

  for (const file of files) {
    try {
      const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as SummaryFile
      const cwd = summary.info?.cwd || path.dirname(path.dirname(file))
      const id = summary.info?.id || path.basename(path.dirname(file))
      if (!validSessionId(id)) continue
      const title =
        summary.generated_title ||
        summary.session_summary ||
        'New thread'
      threads.push({
        id,
        title: title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'New thread',
        cwd,
        projectName: path.basename(cwd.replace(/[\\/]+$/, '')) || cwd,
        updatedAt: summary.last_active_at || summary.updated_at || summary.created_at || '',
        createdAt: summary.created_at,
        model: summary.current_model_id,
        effort: summary.reasoning_effort,
        status: 'idle',
        messageCount: summary.num_messages
      })
    } catch {
      /* skip corrupt */
    }
  }

  threads.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return threads
}

export function projectsFromThreads(threads: ThreadMeta[]): Project[] {
  const map = new Map<string, Project>()
  for (const thread of threads) {
    const existing = map.get(thread.cwd)
    if (!existing) {
      map.set(thread.cwd, {
        id: thread.cwd,
        name: thread.projectName,
        path: thread.cwd,
        lastActiveAt: thread.updatedAt
      })
    }
  }
  return [...map.values()].sort((a, b) =>
    (b.lastActiveAt || '').localeCompare(a.lastActiveAt || '')
  )
}

function extractUserText(content: unknown): string {
  const chunks: string[] = []
  if (typeof content === 'string') chunks.push(content)
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') chunks.push(part)
      else if (part && typeof part === 'object' && 'text' in part) {
        chunks.push(String((part as { text: string }).text || ''))
      }
    }
  }
  const text = chunks.join('\n')
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (query) return query[1].trim()
  if (text.includes('<user_info>') || text.includes('<system-reminder>')) return ''
  return text.trim()
}

function toolNameToPath(name: string, args: unknown): { path?: string; command?: string; diff?: string } {
  if (!args || typeof args !== 'object') return {}
  const rec = args as Record<string, unknown>
  const file =
    (rec.target_file as string) ||
    (rec.file_path as string) ||
    (rec.path as string) ||
    (rec.command as string)
  if (name === 'run_terminal_command' || name === 'run_terminal_cmd') {
    return { command: String(rec.command || '') }
  }
  if (typeof rec.old_string === 'string' && typeof rec.new_string === 'string') {
    return {
      path: String(rec.target_file || rec.file_path || ''),
      diff: `--- a/${file}\n+++ b/${file}\n@@\n-${rec.old_string.split('\n').join('\n-')}\n+${rec.new_string.split('\n').join('\n+')}`
    }
  }
  return { path: typeof file === 'string' ? file : undefined }
}

function validSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(sessionId) && sessionId !== '__new__'
}

function safeSessionDir(candidate: string): string | null {
  try {
    const root = fs.realpathSync(path.join(grokHome(), 'sessions'))
    const resolved = fs.realpathSync(candidate)
    const relative = path.relative(root, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      relative.split(path.sep).length < 2 || !fs.statSync(resolved).isDirectory()) return null
    return resolved
  } catch { return null }
}

export function sessionDir(sessionId: string, cwd: string): string | null {
  if (!validSessionId(sessionId) || typeof cwd !== 'string') return null
  if (sessionId && sessionId !== '__new__' && cwd) {
    const variants = [cwd, cwd.replace(/\\/g, '/'), cwd.replace(/\//g, '\\')]
    for (const variant of variants) {
      const direct = path.join(grokHome(), 'sessions', encodeURIComponent(variant), sessionId)
      const resolved = safeSessionDir(direct)
      if (resolved) return resolved
    }
  }
  if (sessionId && sessionId !== '__new__') {
    const files = walkSummaries(path.join(grokHome(), 'sessions'))
    for (const file of files) {
      if (path.basename(path.dirname(file)) === sessionId) return safeSessionDir(path.dirname(file))
    }
  }
  return null
}

export function renameThread(sessionId: string, cwd: string, title: string): boolean {
  const dir = sessionDir(sessionId, cwd)
  if (!dir) return false
  const file = path.join(dir, 'summary.json')
  try {
    const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as SummaryFile & Record<string, unknown>
    summary.generated_title = title
    summary.session_summary = title
    fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function deleteThread(sessionId: string, cwd: string): boolean {
  const dir = sessionDir(sessionId, cwd)
  if (!dir) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function parseHistoryLines(sessionId: string, lines: HistoryLine[]): ParsedHistoryMessage[] {
  const messages: ParsedHistoryMessage[] = []

  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line.text) as Record<string, unknown>
    } catch {
      continue
    }
    const type = String(row.type || '')
    const id = `${sessionId}-${line.offset}`
    let sourceIndex = 0

    const push = (message: ChatMessage) => {
      messages.push({ sourceOffset: line.offset, sourceIndex: sourceIndex++, message })
    }

    if (type === 'user') {
      const text = extractUserText(row.content)
      const attachments = userAttachments(row.content)
      if (!text && !attachments.length) continue
      push({
        id,
        kind: 'user',
        text,
        createdAt: '',
        attachments: attachments.length ? attachments : undefined
      })
    } else if (type === 'assistant') {
      const text = extractUserText(row.content)
      const images = extractMediaFromText(text)
      if (text || images.length) {
        push({
          id,
          kind: 'assistant',
          text,
          createdAt: '',
          images: images.length ? images : undefined
        })
      }
      const calls = row.tool_calls as Array<Record<string, unknown>> | undefined
      if (Array.isArray(calls)) {
        for (const [callIndex, call] of calls.entries()) {
          const name = String(call.name || 'tool')
          let args: unknown = call.arguments
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              /* keep string */
            }
          }
          const extra = toolNameToPath(name, args)
          const tool: ToolCallState = {
            id: String(call.id || `${id}-tool-${callIndex}`),
            name,
            title: extra.path || extra.command || name,
            status: 'completed',
            input: args,
            ...extra
          }
          push({
            id: `${id}-${tool.id}`,
            kind: 'tool',
            text: '',
            createdAt: '',
            tool
          })
        }
      }
    } else if (type === 'tool_result') {
      const callId = String(row.tool_call_id || '')
      const text = unwrapText(row.content)
      const images = uniqueImages(
        extractMediaFromContent(row.content),
        extractMediaFromText(text)
      )
      const parsed = messages.find(
        (item) => item.message.tool &&
          (item.message.tool.id === callId || item.message.tool.id.endsWith(callId))
      )
      if (parsed?.message.tool) {
        parsed.message.tool.output = text.slice(0, 8000)
        if (images[0]?.path) parsed.message.tool.path = images[0].path
        if (images.length) parsed.message.tool.images = images
      } else if (images.length) {
        push({
          id,
          kind: 'tool',
          text: '',
          createdAt: '',
          tool: {
            id: callId || id,
            name: 'image',
            title: images[0].alt || images[0].path || 'image',
            status: 'completed',
            path: images[0].path,
            images,
            output: text.slice(0, 8000)
          }
        })
      }
    } else if (type === 'reasoning') {
      const summary = row.summary as Array<{ text?: string }> | undefined
      const text = summary?.map((s) => s.text || '').join('\n').trim()
      if (text) push({ id, kind: 'thinking', text, createdAt: '' })
    }
  }

  return messages
}

export function loadHistoryPage(
  sessionId: string,
  cwd: string,
  cursor?: HistoryCursor | null
): HistoryPage {
  const dir = sessionDir(sessionId, cwd)
  if (!dir) return { messages: [], nextCursor: null, hasMore: false }
  const file = path.join(dir, 'chat_history.jsonl')
  if (!fs.existsSync(file)) return { messages: [], nextCursor: null, hasMore: false }

  const fileSize = fs.statSync(file).size
  const end = Math.max(0, Math.min(cursor?.before ?? fileSize, fileSize))
  if (!end) return { messages: [], nextCursor: null, hasMore: false }

  const continuation =
    cursor?.intraOffset && cursor.groupEnd && cursor.groupEnd > end
      ? readHistoryWindow(file, cursor.groupEnd, cursor.groupEnd - end, true)
      : []
  let bytes = Math.min(HISTORY_READ_CHUNK_BYTES, end)
  let parsed: ParsedHistoryMessage[] = []
  let eligible: ParsedHistoryMessage[] = []
  let conversation: ParsedHistoryMessage[] = []
  while (true) {
    const lines = [...readHistoryWindow(file, end, bytes), ...continuation]
    parsed = parseHistoryLines(sessionId, lines)
    eligible = parsed.filter(
      (item) =>
        item.sourceOffset < end ||
        (item.sourceOffset === end && item.sourceIndex < (cursor?.intraOffset || 0))
    )
    conversation = eligible.filter(
      (item) => item.message.kind === 'user' || item.message.kind === 'assistant'
    )
    if (conversation.length >= HISTORY_PAGE_SIZE || bytes >= end) break
    bytes = Math.min(end, bytes * 2)
  }

  if (!conversation.length) return { messages: [], nextCursor: null, hasMore: false }
  const visiblePage = conversation.slice(-HISTORY_PAGE_SIZE)
  const first = visiblePage[0]
  const page = eligible.filter(
    (item) =>
      item.sourceOffset > first.sourceOffset ||
      (item.sourceOffset === first.sourceOffset && item.sourceIndex >= first.sourceIndex)
  )
  const hasMore = first.sourceOffset > 0 || first.sourceIndex > 0
  const nextSource = parsed.find((item) => item.sourceOffset > first.sourceOffset)?.sourceOffset
  const groupEnd = nextSource ?? cursor?.groupEnd ?? fileSize
  const nextCursor: HistoryCursor | null = hasMore
    ? {
        before: first.sourceOffset,
        ...(first.sourceIndex > 0
          ? { intraOffset: first.sourceIndex, groupEnd }
          : {})
      }
    : null
  return {
    messages: page.map((item) => item.message),
    nextCursor,
    hasMore
  }
}

function userAttachments(content: unknown): PromptAttachment[] {
  if (!Array.isArray(content)) return []
  const out: PromptAttachment[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as Record<string, unknown>
    if (rec.type !== 'image') continue
    const url = typeof rec.url === 'string' ? rec.url : typeof rec.dataUrl === 'string' ? rec.dataUrl : ''
    const file = typeof rec.path === 'string' ? rec.path : ''
    const dataMime = /^data:([^;]+);/i.exec(url)?.[1]
    const mime = typeof rec.mimeType === 'string' ? rec.mimeType : dataMime
    const ext =
      mime === 'image/jpeg'
        ? 'jpg'
        : mime === 'image/svg+xml'
          ? 'svg'
          : mime?.startsWith('image/')
            ? mime.slice(6).replace('svg+xml', 'svg')
            : ''
    out.push({
      name: String(rec.name || (file ? path.basename(file) : ext ? `image.${ext}` : 'image')),
      path: file,
      dataUrl: url.startsWith('data:') ? url : undefined,
      mime
    })
  }
  return out
}
