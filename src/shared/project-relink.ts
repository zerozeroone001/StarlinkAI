export interface ProjectRelinkPreview {
  token: string
  projectId: string
  directory: string
  files: number
  bytes: number
  warnings: { name: string; reason: string }[]
}

export interface ProjectRelinkApi {
  prepare(workspaceText: string, projectId: string): Promise<ProjectRelinkPreview | null>
  commit(token: string, allowIncomplete: boolean): Promise<{ workspaceText: string }>
  finish(token: string): Promise<void>
  cancel(token?: string): Promise<void>
  status(): Promise<{ phase: 'idle' | 'preparing' | 'preview' | 'committing'; done: number; total: number; cancellable: boolean }>
}
