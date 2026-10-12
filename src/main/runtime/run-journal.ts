import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunRequest, RunSnapshot, DelegatedTask } from '../../shared/runtime'

export interface RunRecord { version: 1; fingerprint: string; snapshot: RunSnapshot }
export interface RunJournal {
  load(id: string): Promise<RunRecord | null>
  save(record: RunRecord): Promise<void>
}
function validId(id: string) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new Error('执行编号无效')
  return id
}

export async function atomicJson(file: string, value: unknown, backup = true) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync() }
    finally { await handle.close() }
    if (backup) {
      try { await fs.copyFile(file, `${file}.bak`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await fs.rename(temporary, file)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

export function createRunJournal(root: string): RunJournal {
  const operations = new Map<string, Promise<unknown>>()
  const serialized = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const pending = (operations.get(id) || Promise.resolve()).catch(() => {}).then(operation)
    operations.set(id, pending)
    void pending.finally(() => { if (operations.get(id) === pending) operations.delete(id) }).catch(() => {})
    return pending
  }
  return {
    async load(id) {
      const file = path.join(root, `${validId(id)}.json`)
      // Backup recovery writes the primary file, so it must share the save queue.
      return serialized(id, async () => {
        let primaryError: unknown
        for (const candidate of [file, `${file}.bak`]) {
          try {
            const stat = await fs.stat(candidate)
            if (stat.size > 20 * 1024 * 1024) throw new Error('执行记录超过大小限制')
            const record = JSON.parse(await fs.readFile(candidate, 'utf8')) as RunRecord
            if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
              record.snapshot?.id !== id || !Array.isArray(record.snapshot.replies) ||
              !['queued', 'running', 'needs_permission', 'completed', 'failed', 'cancelled'].includes(record.snapshot.status))
              throw new Error('执行记录格式无效')
            if (candidate !== file) await atomicJson(file, record, false)
            return record
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') primaryError ||= error
          }
        }
        // Corrupt receipts must never turn a repeated start into a new model invocation.
        if (primaryError) throw new Error('执行记录无法读取，请保留本机数据并恢复备份；未重新执行。')
        return null
      })
    },
    save(record) {
      const id = validId(record.snapshot.id)
      const copy = structuredClone(record)
      return serialized(id, () =>
        atomicJson(path.join(root, `${id}.json`), copy))
    }
  }
}

export async function archiveContext(cwd: string, request: RunRequest, handoffs: unknown[], tasks?: DelegatedTask[]) {
  const directory = path.join(cwd, '.grok-desktop-context')
  await fs.mkdir(directory, { recursive: true })
  const relative = path.relative(await fs.realpath(cwd), await fs.realpath(directory))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('上下文存档目录必须位于当前工作目录内')
  const file = path.join(directory, `${validId(request.id)}.json`)
  await atomicJson(file, { version: 1, workspaceId: request.workspaceId, runId: request.id,
    goal: request.goal, task: request.task, prompt: request.prompt, history: request.context,
    artifacts: request.artifacts, attachments: request.attachments,
    employees: request.employees, coordination: request.coordination, tasks, handoffs }, false)
  return file
}
