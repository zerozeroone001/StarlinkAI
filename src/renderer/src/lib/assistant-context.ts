import type { Team, TeamMessage } from './collaboration-data'
import type { RunRequest } from '@shared/runtime'

export function assistantScopeId(team: Pick<Team, 'id' | 'parentId'>): string {
  return team.parentId || team.id
}

export function isAssistantPrivateMessage(message: TeamMessage, leadId?: string): boolean {
  if (message.private !== undefined) return message.private
  if (message.interaction === 'conversation') return true
  // Legacy records predate privacy labels; keep direct, non-task lead exchanges private.
  return !!leadId && !message.taskId &&
    (message.author === leadId || (message.author === 'you' && message.to === leadId))
}

export function separateAssistantContext(context: RunRequest['context'], history: TeamMessage[], leadId?: string) {
  const privateIds = new Set(history.filter((message) => isAssistantPrivateMessage(message, leadId)).map((message) => message.id))
  return {
    context: context.filter((record) => !record.id || !privateIds.has(record.id)),
    privateContext: context.filter((record) => record.id && privateIds.has(record.id)).slice(-200)
  }
}

export function isStopWorkMessage(text: string): boolean {
  return /^(?:请)?(?:暂停|停止|取消)(?:一下)?(?:刚才的|当前的|正在运行的|当前|刚才)?任务[。！!]?$/u.test(text.trim())
}
