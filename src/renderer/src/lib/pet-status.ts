import type { GitState, PermissionRequest, PetLiveStatus, ThreadMeta } from '@shared/types'

export function derivePetStatus(input: {
  threads: ThreadMeta[]
  activeThreadId: string | null
  git: GitState | null
  permission: PermissionRequest | null
}): PetLiveStatus {
  const waiting = input.threads.filter((t) => t.status === 'needs_input')
  const running = input.threads.filter((t) => t.status === 'running')
  const active = input.threads.find((t) => t.id === input.activeThreadId)

  if (input.permission || waiting.length) {
    const thread = waiting.find((t) => t.id === input.activeThreadId) || waiting[0] || active
    return {
      mood: 'waiting',
      title: thread?.title || 'StarlinkAI',
      hint: 'Needs approval',
      threadId: thread?.id || input.permission?.sessionId || null,
      runningCount: running.length,
      needsInput: true
    }
  }

  if (running.length) {
    const thread = running.find((t) => t.id === input.activeThreadId) || running[0]
    return {
      mood: 'running',
      title: thread.title,
      hint: running.length > 1 ? `${running.length} tasks running` : 'StarlinkAI is working',
      threadId: thread.id,
      runningCount: running.length,
      needsInput: false
    }
  }

  if (active?.status === 'error') {
    return {
      mood: 'failed',
      title: active.title,
      hint: 'Something failed',
      threadId: active.id,
      runningCount: 0,
      needsInput: false
    }
  }

  if (input.git?.dirty) {
    return {
      mood: 'review',
      title: active?.title || 'Review',
      hint: 'Ready for review',
      threadId: active?.id || null,
      runningCount: 0,
      needsInput: false
    }
  }

  return {
    mood: 'idle',
    title: active?.title || 'StarlinkAI',
    hint: 'Ready',
    threadId: active?.id || null,
    runningCount: 0,
    needsInput: false
  }
}
