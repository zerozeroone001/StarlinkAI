import type { TeamMessage } from './collaboration-data'

export interface ConversationMessage extends TeamMessage {
  toolMessages: TeamMessage[]
  activityOnly?: boolean
}

// Preserve the saved audit trail; only project tool records out of the chat bubbles.
export function conversationFeed(messages: TeamMessage[]): ConversationMessage[] {
  const normal = messages.filter((message) => !message.toolPermission)
  const replies = new Map<string, TeamMessage>()
  const employees = new Map<string, TeamMessage>()
  for (const message of normal) {
    const scope = [message.runId || '', message.author]
    replies.set(JSON.stringify([...scope, message.id]), message)
    if (message.runtimeReplyId) replies.set(JSON.stringify([...scope, message.runtimeReplyId]), message)
    const key = JSON.stringify(scope)
    if (!employees.has(key)) employees.set(key, message)
  }
  const groups = new Map<string, TeamMessage[]>()
  const orphanKeys = new Map<string, string>()
  const seen = new Set<string>()
  for (const message of messages) {
    const permission = message.toolPermission
    if (!permission) continue
    const scope = [message.runId || '', message.author]
    const identity = JSON.stringify([...scope, permission.replyId || '', permission.id])
    if (seen.has(identity)) continue
    seen.add(identity)
    const owner = permission.replyId ? replies.get(JSON.stringify([...scope, permission.replyId])) : employees.get(JSON.stringify(scope))
    const key = owner?.id || `tools:${JSON.stringify([message.runId || '', message.author, permission.replyId || ''])}`
    const group = groups.get(key) || []
    group.push(message)
    groups.set(key, group)
    if (!owner) orphanKeys.set(message.id, key)
  }
  const emitted = new Set<string>()
  const feed: ConversationMessage[] = []
  for (const message of messages) {
    if (message.toolPermission) {
      const key = orphanKeys.get(message.id)
      if (key && !emitted.has(key)) {
        emitted.add(key)
        feed.push({ ...message, id: key, text: '', toolPermission: undefined, toolMessages: groups.get(key)!, activityOnly: true })
      }
      continue
    }
    const tools = groups.get(message.id) || []
    // Empty completed placeholders and repeated protocol-only updates add no content.
    if (!message.text.trim() && !message.error && !message.images?.length && !message.attachments?.length &&
      !message.artifactId && !message.receipt && !tools.length && !['running', 'queued', 'needs_permission'].includes(message.status || '')) continue
    feed.push({ ...message, toolMessages: tools })
  }
  return feed
}

export function conversationSearchText(message: ConversationMessage): string {
  return [message.text, message.error || '', ...message.toolMessages.flatMap((tool) => [
    tool.text, tool.toolPermission?.title || '', tool.toolPermission?.detail || ''
  ])].join('\n').toLowerCase()
}
