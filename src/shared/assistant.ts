export type AssistantStyle = 'balanced' | 'professional' | 'warm' | 'companion'
export type AssistantMemoryKind = 'preference' | 'fact' | 'agreement'

export interface AssistantProfile {
  scopeId: string
  name: string
  persona: string
  addressing: string
  style: AssistantStyle
  updatedAt: string
}

export interface AssistantMemory {
  id: string
  content: string
  kind: AssistantMemoryKind
  createdAt: string
  updatedAt: string
  source?: string
}

export interface AssistantCommitment {
  id: string
  title: string
  dueAt?: string
  status: 'open' | 'done'
  createdAt: string
  updatedAt: string
  notifiedAt?: string
}

export interface AssistantSnapshot {
  profile: AssistantProfile
  memories: AssistantMemory[]
  commitments: AssistantCommitment[]
  revision: number
  /** Legacy snapshots default to false; portable imports start paused. */
  remindersPaused?: boolean
}

export type AssistantProfilePatch = Partial<Pick<AssistantProfile, 'name' | 'persona' | 'addressing' | 'style'>>
export type AssistantMemoryInput = Pick<AssistantMemory, 'content' | 'kind' | 'source'> & { id?: string }
export type AssistantCommitmentInput = Pick<AssistantCommitment, 'title'> & {
  id?: string
  dueAt?: string | null
  status?: AssistantCommitment['status']
  notifiedAt?: string | null
}

export interface AssistantActions {
  memoryUpdates?: Array<Omit<AssistantMemoryInput, 'source'>>
  forgetMemoryIds?: string[]
  commitmentUpdates?: Array<Omit<AssistantCommitmentInput, 'notifiedAt'>>
}

export const ASSISTANT_LIMITS = {
  name: 48,
  persona: 20000,
  addressing: 80,
  memory: 4000,
  source: 500,
  commitment: 200,
  memories: 100,
  commitments: 100,
  context: 12000
} as const
