/** Bounds apply to actual expanded bytes, independently of ZIP metadata. */
export const PORTABLE_LIMITS = {
  manifestBytes: 64 * 1024 * 1024,
  assetBytes: 32 * 1024 * 1024,
  totalAssetBytes: 512 * 1024 * 1024,
  files: 10000,
  archiveBytes: 600 * 1024 * 1024
} as const

export interface PortableCounts {
  projects: number; conversations: number; messages: number; drafts: number
  assistants: number; memories: number; reminders: number; attachments: number; images: number
  files: number; bytes: number
}
export interface PortableWarning { name: string; reason: string }
export interface PortablePreview {
  token: string
  kind: 'export' | 'import'
  name: string
  createdAt: string
  counts: PortableCounts
  warnings: PortableWarning[]
}
export interface PortableProgress {
  phase: 'idle' | 'collecting' | 'validating' | 'preview' | 'writing' | 'preparing' | 'committing' | 'complete' | 'failed'
  done: number
  total: number
  cancellable: boolean
}
export interface PortableRestorePlan { operationId: string; workspaceText: string }
export interface PortableBackupApi {
  beginExport(workspaceText: string): Promise<PortablePreview>
  inspectImport(): Promise<PortablePreview | null>
  writeExport(token: string, allowIncomplete: boolean): Promise<{ name: string } | null>
  prepareRestore(token: string, allowIncomplete: boolean): Promise<PortableRestorePlan>
  prepareRollback(): Promise<string>
  reconcile(marker: string | null, activeScopes: string[]): Promise<void>
  cancel(token?: string): Promise<void>
  status(): Promise<PortableProgress>
  setRemindersPaused(scopeId: string, paused: boolean, revision: number): Promise<import('./assistant').AssistantSnapshot>
}
