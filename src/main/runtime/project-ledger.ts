import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DelegatedTask, SharedArtifactUpdate, WorkReceipt } from '../../shared/runtime'
import { atomicJson } from './run-journal'

export interface LedgerEntry {
  workspaceId: string
  runId: string
  employeeId: string
  employeeName: string
  provider: string
  taskId?: string
  summary: string
  receipt?: WorkReceipt
  updatedAt: string
}

export interface ProjectLedgerData {
  version: 1
  updatedAt: string
  decisions: { id: string; workspaceId: string; author: string; text: string; updatedAt: string }[]
  sharedArtifacts: SharedArtifactUpdate[]
  tasks: DelegatedTask[]
  recentWork: LedgerEntry[]
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'release', '.tmp', '.grok-desktop-context', '.grok-desktop'])

export function snapshotWorkspaceFiles(cwd: string, maxFiles = 600): Map<string, number> {
  const map = new Map<string, number>()
  try {
    if (!cwd || !fs.existsSync(cwd)) return map
    const queue: string[] = [cwd]
    while (queue.length > 0 && map.size < maxFiles) {
      const current = queue.shift()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (map.size >= maxFiles) break
        if (entry.name.startsWith('.') && entry.name !== '.env.example') {
          if (IGNORED_DIRS.has(entry.name)) continue
        }
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          queue.push(full)
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full)
            const rel = path.relative(cwd, full).replace(/\\/g, '/')
            map.set(rel, Math.floor(stat.mtimeMs))
          } catch {
            // ignore transient files
          }
        }
      }
    }
  } catch {
    // ignore snapshot errors
  }
  return map
}

export function diffWorkspaceFiles(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = []
  for (const [file, mtime] of after.entries()) {
    const prev = before.get(file)
    if (prev === undefined || prev !== mtime) changed.push(file)
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(`${file} (deleted)`)
  }
  return changed.slice(0, 50)
}

export function mergeWorkReceipt(toolReceipt: WorkReceipt | undefined, fsChanges: string[]): WorkReceipt | undefined {
  const filesRead = [...new Set(toolReceipt?.filesRead || [])].slice(0, 30)
  const filesModified = [...new Set([...(toolReceipt?.filesModified || []), ...fsChanges])].slice(0, 40)
  const commands = (toolReceipt?.commands || []).slice(0, 20)
  const gitChanges = [...new Set([...(toolReceipt?.gitChanges || []), ...fsChanges])].slice(0, 40)
  if (!filesRead.length && !filesModified.length && !commands.length && !gitChanges.length) return undefined
  return {
    ...(filesRead.length ? { filesRead } : {}),
    ...(filesModified.length ? { filesModified } : {}),
    ...(commands.length ? { commands } : {}),
    ...(gitChanges.length ? { gitChanges } : {})
  }
}

export function formatWorkReceipt(receipt?: WorkReceipt): string {
  if (!receipt) return ''
  const parts: string[] = []
  if (receipt.filesModified?.length) parts.push(`实际变更文件：${receipt.filesModified.join('、')}`)
  if (receipt.commands?.length) {
    parts.push(
      `执行命令：${receipt.commands
        .map((c) => `${c.command}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`)
        .join('；')}`
    )
  }
  if (receipt.filesRead?.length && !receipt.filesModified?.length) {
    parts.push(`查阅文件：${receipt.filesRead.slice(0, 10).join('、')}`)
  }
  return parts.join(' | ')
}

export function extractSharedArtifacts(
  text: string,
  ownerId: string
): { cleanText: string; artifacts: SharedArtifactUpdate[] } {
  const artifacts: SharedArtifactUpdate[] = []
  const cleanText = text.replace(/```grok-artifact\s*\n([\s\S]*?)\n```/g, (_match, body: string) => {
    const lines = body.trim().split(/\r?\n/)
    if (!lines.length) return ''
    try {
      const meta = JSON.parse(lines[0]) as { name?: string; description?: string; format?: string }
      const content = lines.slice(1).join('\n').trim()
      if (meta && typeof meta.name === 'string' && meta.name.trim() && content) {
        const rawExt = (meta.format || meta.name.split('.').at(-1) || 'md').toLowerCase()
        const format = (['md', 'txt', 'json', 'csv'].includes(rawExt) ? rawExt : 'md') as SharedArtifactUpdate['format']
        const normalizedName = /\.(md|txt|json|csv)$/i.test(meta.name.trim())
          ? meta.name.trim()
          : `${meta.name.trim()}.${format}`
        artifacts.push({
          name: normalizedName.slice(0, 80),
          description: (typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : '智能体协作产出成果').slice(0, 200),
          owner: ownerId,
          format,
          content: content.slice(0, 120000)
        })
        return `\n> 已沉淀共享成果：《${normalizedName}》\n`
      }
    } catch {
      // keep original if not valid artifact header
    }
    return _match
  })
  return { cleanText: cleanText.trim(), artifacts }
}

export async function loadProjectLedger(cwd: string): Promise<ProjectLedgerData | null> {
  try {
    const file = path.join(cwd, '.grok-desktop', 'project-ledger.json')
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as ProjectLedgerData
    if (parsed && parsed.version === 1) return parsed
  } catch {
    // ignore missing ledger
  }
  return null
}

export async function updateProjectLedger(
  cwd: string,
  input: {
    workspaceId: string
    runId: string
    decisions?: { id: string; author: string; text: string }[]
    artifacts?: SharedArtifactUpdate[]
    tasks?: DelegatedTask[]
    workEntries?: LedgerEntry[]
  }
): Promise<ProjectLedgerData | null> {
  try {
    const directory = path.join(cwd, '.grok-desktop')
    await fsp.mkdir(directory, { recursive: true })
    const relative = path.relative(await fsp.realpath(cwd), await fsp.realpath(directory))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    const existing = (await loadProjectLedger(cwd)) || {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      decisions: [],
      sharedArtifacts: [],
      tasks: [],
      recentWork: []
    }
    const now = new Date().toISOString()
    for (const d of input.decisions || []) {
      if (!existing.decisions.some((item) => item.id === d.id)) {
        existing.decisions.push({ ...d, workspaceId: input.workspaceId, updatedAt: now })
      }
    }
    existing.decisions = existing.decisions.slice(-40)

    for (const artifact of input.artifacts || []) {
      const idx = existing.sharedArtifacts.findIndex((a) => a.name === artifact.name)
      if (idx >= 0) existing.sharedArtifacts[idx] = artifact
      else existing.sharedArtifacts.push(artifact)
    }
    existing.sharedArtifacts = existing.sharedArtifacts.slice(-30)

    if (input.tasks?.length) {
      for (const task of input.tasks) {
        const idx = existing.tasks.findIndex((t) => t.id === task.id)
        if (idx >= 0) existing.tasks[idx] = task
        else existing.tasks.push(task)
      }
      existing.tasks = existing.tasks.slice(-60)
    }

    if (input.workEntries?.length) {
      existing.recentWork.push(...input.workEntries)
      existing.recentWork = existing.recentWork.slice(-40)
    }

    existing.updatedAt = now
    await atomicJson(path.join(directory, 'project-ledger.json'), existing, false)
    return existing
  } catch {
    return null
  }
}
