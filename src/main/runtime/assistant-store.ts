import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  ASSISTANT_LIMITS,
  type AssistantActions,
  type AssistantCommitment,
  type AssistantCommitmentInput,
  type AssistantMemory,
  type AssistantMemoryInput,
  type AssistantProfilePatch,
  type AssistantSnapshot,
  type AssistantStyle
} from '../../shared/assistant'
import { grokHome } from '../paths'
import { atomicJson } from './run-journal'
import { assertUnlinkedPath, readBoundedFile } from '../file-boundary'

const styles: AssistantStyle[] = ['balanced', 'professional', 'warm', 'companion']
const kinds = ['preference', 'fact', 'agreement']
const MAX_FILE_BYTES = 2 * 1024 * 1024

export class AssistantRevisionConflictError extends Error {
  readonly code = 'ASSISTANT_REVISION_CONFLICT'
  constructor() {
    super('用户已在本轮运行期间更新或遗忘助理资料，本轮旧决定未保存；不得重新创建这些资料。')
    this.name = 'AssistantRevisionConflictError'
  }
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('助理或记录编号无效')
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (required && !value.trim()))
    throw new Error('助理资料为空、格式无效或超过长度限制')
  return value.trim()
}

function date(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('提醒时间无效，请选择有效日期和时间')
  return new Date(value).toISOString()
}

function empty(scopeId: string): AssistantSnapshot {
  return {
    profile: { scopeId, name: '主 agent', persona: '', addressing: '', style: 'balanced', updatedAt: new Date(0).toISOString() },
    memories: [], commitments: [], revision: 0, remindersPaused: false
  }
}

function profilePatch(value: unknown): AssistantProfilePatch {
  if (!record(value) || Object.keys(value).some((key) => !['name', 'persona', 'addressing', 'style'].includes(key)))
    throw new Error('助理资料字段无效')
  const patch: AssistantProfilePatch = {}
  if (value.name !== undefined) patch.name = text(value.name, ASSISTANT_LIMITS.name, true)
  if (value.persona !== undefined) patch.persona = text(value.persona, ASSISTANT_LIMITS.persona)
  if (value.addressing !== undefined) patch.addressing = text(value.addressing, ASSISTANT_LIMITS.addressing)
  if (value.style !== undefined) {
    if (!styles.includes(value.style as AssistantStyle)) throw new Error('助理交流风格无效')
    patch.style = value.style as AssistantStyle
  }
  return patch
}

function memoryInput(value: unknown): AssistantMemoryInput {
  if (!record(value) || Object.keys(value).some((key) => !['id', 'content', 'kind', 'source'].includes(key)) || !kinds.includes(value.kind as string))
    throw new Error('记忆内容或类型无效')
  return {
    ...(value.id !== undefined ? { id: validId(value.id) } : {}),
    content: text(value.content, ASSISTANT_LIMITS.memory, true),
    kind: value.kind as AssistantMemory['kind'],
    ...(value.source !== undefined ? { source: text(value.source, ASSISTANT_LIMITS.source) } : {})
  }
}

function commitmentInput(value: unknown): AssistantCommitmentInput {
  if (!record(value) || Object.keys(value).some((key) => !['id', 'title', 'dueAt', 'status', 'notifiedAt'].includes(key)) ||
    (value.status !== undefined && !['open', 'done'].includes(value.status as string)))
    throw new Error('承诺或提醒格式无效')
  return {
    ...(value.id !== undefined ? { id: validId(value.id) } : {}),
    title: text(value.title, ASSISTANT_LIMITS.commitment, true),
    ...(value.status !== undefined ? { status: value.status as AssistantCommitment['status'] } : {}),
    ...(value.dueAt !== undefined ? { dueAt: value.dueAt === null ? null : date(value.dueAt) } : {}),
    ...(value.notifiedAt !== undefined ? { notifiedAt: value.notifiedAt === null ? null : date(value.notifiedAt) } : {})
  }
}

function storedSnapshot(raw: unknown, scopeId: string): AssistantSnapshot {
  if (!record(raw) || raw.version !== 1 || !record(raw.snapshot)) throw new Error('助理资料格式无效')
  return validateAssistantSnapshot(raw.snapshot, scopeId)
}

/** Validate and copy portable data without accepting arbitrary fields or paths. */
export function validateAssistantSnapshot(value: unknown, scopeId: string): AssistantSnapshot {
  validId(scopeId)
  if (!record(value)) throw new Error('助理资料格式无效')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !record(value.profile) ||
    value.profile.scopeId !== scopeId || !Array.isArray(value.memories) || !Array.isArray(value.commitments) ||
    value.memories.length > ASSISTANT_LIMITS.memories || value.commitments.length > ASSISTANT_LIMITS.commitments ||
    (value.remindersPaused !== undefined && typeof value.remindersPaused !== 'boolean'))
    throw new Error('助理资料格式无效')
  const p = value.profile
  const patch = profilePatch({ name: p.name, persona: p.persona, addressing: p.addressing, style: p.style })
  if (Object.keys(patch).length !== 4) throw new Error('助理资料不完整')
  const memories = value.memories.map((m): AssistantMemory => {
    if (!record(m)) throw new Error('记忆格式无效')
    return { ...memoryInput({ id: m.id, content: m.content, kind: m.kind, source: m.source }),
      id: validId(m.id), createdAt: date(m.createdAt), updatedAt: date(m.updatedAt) }
  })
  const commitments = value.commitments.map((c): AssistantCommitment => {
    if (!record(c)) throw new Error('承诺格式无效')
    const input = commitmentInput({ id: c.id, title: c.title, dueAt: c.dueAt, status: c.status, notifiedAt: c.notifiedAt })
    if (!input.status || input.dueAt === null || input.notifiedAt === null) throw new Error('承诺格式无效')
    return { id: validId(c.id), title: input.title, status: input.status,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}), ...(input.notifiedAt ? { notifiedAt: input.notifiedAt } : {}),
      createdAt: date(c.createdAt), updatedAt: date(c.updatedAt) }
  })
  if (new Set(memories.map((m) => m.id)).size !== memories.length || new Set(commitments.map((c) => c.id)).size !== commitments.length)
    throw new Error('助理记录编号重复')
  return { profile: { ...empty(scopeId).profile, ...patch, updatedAt: date(p.updatedAt) },
    memories, commitments, revision: value.revision as number, remindersPaused: value.remindersPaused === true }
}

function importedSnapshot(scopeId: string, input: AssistantSnapshot): AssistantSnapshot {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(scopeId)) throw new Error('导入助理必须使用全新的 UUID scope')
  const validated = validateAssistantSnapshot(input, input?.profile?.scopeId)
  return { ...validated, profile: { ...validated.profile, scopeId }, remindersPaused: true }
}

function putMemory(snapshot: AssistantSnapshot, value: AssistantMemoryInput) {
  const existing = value.id ? snapshot.memories.find((m) => m.id === value.id) : undefined
  if (value.id && !existing) throw new Error('记忆不存在，请刷新后重试')
  if (!existing && snapshot.memories.length >= ASSISTANT_LIMITS.memories) throw new Error('最多保存 100 条记忆，请先整理旧记忆')
  const now = new Date().toISOString()
  if (existing) Object.assign(existing, value, { updatedAt: now })
  else snapshot.memories.push({ ...value, id: randomUUID(), createdAt: now, updatedAt: now })
}

function putCommitment(snapshot: AssistantSnapshot, value: AssistantCommitmentInput) {
  const existing = value.id ? snapshot.commitments.find((c) => c.id === value.id) : undefined
  if (value.id && !existing) throw new Error('承诺不存在，请刷新后重试')
  if (!existing && snapshot.commitments.length >= ASSISTANT_LIMITS.commitments) throw new Error('最多保存 100 条承诺，请先整理旧承诺')
  const now = new Date().toISOString()
  const commitment: AssistantCommitment = existing || { id: randomUUID(), title: value.title, status: 'open', createdAt: now, updatedAt: now }
  if ((value.dueAt !== undefined && value.dueAt !== commitment.dueAt) || (commitment.status === 'done' && value.status === 'open'))
    delete commitment.notifiedAt
  commitment.title = value.title
  commitment.updatedAt = now
  if (value.status) commitment.status = value.status
  if (value.dueAt === null) delete commitment.dueAt
  else if (value.dueAt !== undefined) commitment.dueAt = value.dueAt
  if (value.notifiedAt === null) delete commitment.notifiedAt
  else if (value.notifiedAt !== undefined) commitment.notifiedAt = value.notifiedAt
  if (!existing) snapshot.commitments.push(commitment)
}

export function createAssistantStore(root: string) {
  const operations = new Map<string, Promise<unknown>>()
  // Hashing avoids reserved Windows filenames and case-insensitive scope collisions.
  const fileFor = (scopeId: string) => path.join(root, `${createHash('sha256').update(scopeId).digest('hex')}.json`)
  function sequential<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
    validId(scopeId)
    const pending = (operations.get(scopeId) || Promise.resolve()).catch(() => {}).then(operation)
    operations.set(scopeId, pending)
    void pending.finally(() => { if (operations.get(scopeId) === pending) operations.delete(scopeId) }).catch(() => {})
    return pending
  }
  async function load(scopeId: string, repair = true): Promise<AssistantSnapshot> {
    const file = fileFor(scopeId)
    let invalid = false
    const available: Array<{ file: string; snapshot: AssistantSnapshot }> = []
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const stat = await fs.stat(candidate)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('助理资料超过大小限制')
        const snapshot = storedSnapshot(JSON.parse(await fs.readFile(candidate, 'utf8')), scopeId)
        available.push({ file: candidate, snapshot })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = true
      }
    }
    const latest = available.sort((a, b) => b.snapshot.revision - a.snapshot.revision)[0]
    if (latest) {
      if (repair && latest.file !== file) await atomicJson(file, { version: 1, snapshot: latest.snapshot }, false)
      return latest.snapshot
    }
    if (invalid) throw new Error('助理资料及备份无法读取，请保留文件并恢复备份；现有资料未被覆盖。')
    return empty(scopeId)
  }
  function mutate(scopeId: string, apply: (snapshot: AssistantSnapshot) => boolean, expectedRevision?: number) {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      throw new Error('助理资料预期版本无效')
    return sequential(scopeId, async () => {
      const snapshot = await load(scopeId)
      if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) throw new AssistantRevisionConflictError()
      if (apply(snapshot)) {
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER) throw new Error('助理资料版本超出范围')
        snapshot.revision += 1
        const record = { version: 1, snapshot }
        if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_FILE_BYTES) throw new Error('助理资料超过大小限制')
        // Both replicas contain the latest state so recovery cannot resurrect forgotten memories.
        await atomicJson(`${fileFor(scopeId)}.bak`, record, false)
        await atomicJson(fileFor(scopeId), record, false)
      }
      return snapshot
    })
  }
  const store = {
    async get(scopeId: string) { return sequential(scopeId, () => load(scopeId)) },
    async exportSnapshot(scopeId: string) { return sequential(scopeId, () => load(scopeId, false)) },
    async importSnapshot(scopeId: string, input: AssistantSnapshot) {
      const snapshot = importedSnapshot(scopeId, input)
      const content = JSON.stringify({ version: 1, snapshot })
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('助理资料超过大小限制')
      return sequential(scopeId, async () => {
        const targets = [`${fileFor(scopeId)}.bak`, fileFor(scopeId)]
        for (const target of targets) {
          try { await fs.lstat(target); throw new Error('导入目标助理已存在，原资料未被覆盖') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        await fs.mkdir(root, { recursive: true })
        const created: Array<{ path: string; ino: number; dev: number }> = []
        try {
          // Exclusive creation cannot replace a target claimed after the checks.
          // This fresh scope stays inactive until the workspace import commits;
          // an interrupted write cannot modify any pre-existing assistant.
          for (const target of targets) {
            const handle = await fs.open(target, 'wx', 0o600)
            try {
              const stat = await handle.stat(); created.push({ path: target, ino: stat.ino, dev: stat.dev })
              await handle.writeFile(content, 'utf8'); await handle.sync()
            } finally { await handle.close() }
          }
          return snapshot
        } catch (error) {
          for (const target of created) {
            const current = await fs.lstat(target.path).catch(() => null)
            if (current?.ino === target.ino && current.dev === target.dev) await fs.unlink(target.path)
          }
          throw error
        }
      })
    },
    async discardImportedSnapshot(scopeId: string, source: AssistantSnapshot) {
      const expected = Buffer.from(JSON.stringify({ version: 1, snapshot: importedSnapshot(scopeId, source) }), 'utf8')
      return sequential(scopeId, async () => {
        for (const file of [fileFor(scopeId), `${fileFor(scopeId)}.bak`]) {
          try {
            const before = fsSync.lstatSync(file, { bigint: true })
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) continue
            const canonical = assertUnlinkedPath(file)
            if (!readBoundedFile(file, MAX_FILE_BYTES).equals(expected)) continue
            // No asynchronous work between the final identity check and unlink.
            // A changed file, linked parent, or independently modified replica
            // is retained even when the other original replica can be removed.
            if (assertUnlinkedPath(file) !== canonical) continue
            const after = fsSync.lstatSync(file, { bigint: true })
            if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
              before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) continue
            fsSync.unlinkSync(file)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            // Cleanup is deliberately conservative: unreadable/linked content
            // is evidence to retain, not a reason to broaden removal.
          }
        }
      })
    },
    async setRemindersPaused(scopeId: string, paused: boolean, expectedRevision: number) {
      if (typeof paused !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('助理提醒状态或预期版本无效')
      return mutate(scopeId, (snapshot) => {
        if (snapshot.remindersPaused === paused) return false
        snapshot.remindersPaused = paused
        return true
      }, expectedRevision)
    },
    async clear(scopeId: string) {
      return mutate(scopeId, (snapshot) => {
        snapshot.profile = empty(scopeId).profile
        snapshot.memories = []
        snapshot.commitments = []
        return true
      })
    },
    async update(scopeId: string, input: AssistantProfilePatch) {
      const patch = profilePatch(input)
      return mutate(scopeId, (snapshot) => {
        if (!Object.entries(patch).some(([key, value]) => snapshot.profile[key as keyof AssistantProfilePatch] !== value)) return false
        snapshot.profile = { ...snapshot.profile, ...patch, updatedAt: new Date().toISOString() }
        return true
      })
    },
    async saveMemory(scopeId: string, input: AssistantMemoryInput) {
      const value = memoryInput(input)
      return mutate(scopeId, (snapshot) => {
        putMemory(snapshot, value)
        return true
      })
    },
    async forgetMemory(scopeId: string, id: string) {
      validId(id)
      return mutate(scopeId, (snapshot) => {
        const before = snapshot.memories.length
        snapshot.memories = snapshot.memories.filter((m) => m.id !== id)
        return before !== snapshot.memories.length
      })
    },
    async saveCommitment(scopeId: string, input: AssistantCommitmentInput) {
      const value = commitmentInput(input)
      return mutate(scopeId, (snapshot) => {
        putCommitment(snapshot, value)
        return true
      })
    },
    async deleteCommitment(scopeId: string, id: string) {
      validId(id)
      return mutate(scopeId, (snapshot) => {
        const before = snapshot.commitments.length
        snapshot.commitments = snapshot.commitments.filter((c) => c.id !== id)
        return before !== snapshot.commitments.length
      })
    },
    async applyActions(scopeId: string, actions: AssistantActions, source: string, expectedRevision?: number) {
      if (!record(actions) || Object.keys(actions).some((key) => !['memoryUpdates', 'forgetMemoryIds', 'commitmentUpdates'].includes(key)))
        throw new Error('助理更新指令无效')
      const origin = text(source, ASSISTANT_LIMITS.source, true)
      const array = (value: unknown): unknown[] => {
        if (value === undefined) return []
        if (!Array.isArray(value) || value.length > 20) throw new Error('每次最多更新 20 条助理记录')
        return value
      }
      const memories = array(actions.memoryUpdates).map((value) => {
        if (!record(value) || 'source' in value) throw new Error('记忆来源由宿主设置')
        return memoryInput({ ...value, source: origin })
      })
      const forget = array(actions.forgetMemoryIds).map(validId)
      const commitments = array(actions.commitmentUpdates).map((value) => {
        if (!record(value) || 'notifiedAt' in value) throw new Error('通知状态由宿主设置')
        return commitmentInput(value)
      })
      const memoryIds = memories.flatMap((m) => m.id ? [m.id] : [])
      const commitmentIds = commitments.flatMap((c) => c.id ? [c.id] : [])
      if (new Set([...memoryIds, ...forget]).size !== memoryIds.length + forget.length || new Set(commitmentIds).size !== commitmentIds.length)
        throw new Error('同一助理记录不能在一次更新中重复修改或同时遗忘')
      return mutate(scopeId, (snapshot) => {
        const before = JSON.stringify(snapshot)
        snapshot.memories = snapshot.memories.filter((m) => !forget.includes(m.id))
        for (const value of memories) {
          if (!value.id && snapshot.memories.some((m) => m.kind === value.kind && m.content === value.content)) continue
          putMemory(snapshot, value)
        }
        for (const value of commitments) {
          if (!value.id && snapshot.commitments.some((c) => c.title === value.title && c.dueAt === (value.dueAt || undefined) && c.status === (value.status || 'open'))) continue
          putCommitment(snapshot, value)
        }
        return JSON.stringify(snapshot) !== before
      }, expectedRevision)
    },
    async markNotified(scopeId: string, id: string, dueAt: string, notifiedAt: string) {
      validId(id)
      const due = date(dueAt), notified = date(notifiedAt)
      return mutate(scopeId, (snapshot) => {
        const commitment = snapshot.commitments.find((c) => c.id === id)
        if (snapshot.remindersPaused || !commitment || commitment.status !== 'open' || commitment.dueAt !== due || commitment.notifiedAt) return false
        commitment.notifiedAt = notified
        commitment.updatedAt = new Date().toISOString()
        return true
      })
    },
    async due(now = Date.now(), activeScopes?: readonly string[]): Promise<Array<{ scopeId: string; assistantName: string; commitment: AssistantCommitment }>> {
      if (!Number.isFinite(now)) throw new Error('提醒检查时间无效')
      const result: Array<{ scopeId: string; assistantName: string; commitment: AssistantCommitment }> = []
      const append = (scopeId: string, snapshot: AssistantSnapshot) => {
        if (snapshot.remindersPaused) return
        for (const commitment of snapshot.commitments) {
          if (commitment.status === 'open' && commitment.dueAt && Date.parse(commitment.dueAt) <= now && !commitment.notifiedAt)
            result.push({ scopeId, assistantName: snapshot.profile.name, commitment })
        }
      }
      if (activeScopes !== undefined) {
        if (!Array.isArray(activeScopes)) throw new Error('助理 scope 列表无效')
        for (const scopeId of new Set(activeScopes.map(validId))) {
          try { append(scopeId, await store.get(scopeId)) } catch { /* Preserve damaged scopes without scheduling them. */ }
        }
        return result
      }
      let files: string[]
      try { files = await fs.readdir(root) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
      const names = [...new Set(files.filter((name) => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(name)).map((name) => name.replace(/\.bak$/, '')))]
      for (const name of names) {
        for (const candidate of [name, `${name}.bak`]) {
          try {
            const file = path.join(root, candidate)
            if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue
            const raw = JSON.parse(await fs.readFile(file, 'utf8'))
            const scopeId = validId(raw?.snapshot?.profile?.scopeId)
            if (path.basename(fileFor(scopeId)) !== name) continue
            const snapshot = await store.get(scopeId)
            append(scopeId, snapshot)
            break
          } catch { /* A damaged profile stays available for explicit recovery in its project. */ }
        }
      }
      return result
    }
  }
  return store
}

const stores = new Map<string, ReturnType<typeof createAssistantStore>>()
function currentStore() {
  const root = path.resolve(grokHome(), 'desktop', 'assistants')
  let store = stores.get(root)
  if (!store) { store = createAssistantStore(root); stores.set(root, store) }
  return store
}
export const getAssistant = (scopeId: string) => currentStore().get(scopeId)
export const exportAssistantSnapshot = (scopeId: string) => currentStore().exportSnapshot(scopeId)
export const importAssistantSnapshot = (scopeId: string, snapshot: AssistantSnapshot) => currentStore().importSnapshot(scopeId, snapshot)
export const discardImportedAssistantSnapshot = (scopeId: string, source: AssistantSnapshot) => currentStore().discardImportedSnapshot(scopeId, source)
export const setAssistantRemindersPaused = (scopeId: string, paused: boolean, expectedRevision: number) =>
  currentStore().setRemindersPaused(scopeId, paused, expectedRevision)
export const clearAssistant = (scopeId: string) => currentStore().clear(scopeId)
export const updateAssistant = (scopeId: string, patch: AssistantProfilePatch) => currentStore().update(scopeId, patch)
export const saveAssistantMemory = (scopeId: string, input: AssistantMemoryInput) => currentStore().saveMemory(scopeId, input)
export const forgetAssistantMemory = (scopeId: string, id: string) => currentStore().forgetMemory(scopeId, id)
export const saveAssistantCommitment = (scopeId: string, input: AssistantCommitmentInput) => currentStore().saveCommitment(scopeId, input)
export const deleteAssistantCommitment = (scopeId: string, id: string) => currentStore().deleteCommitment(scopeId, id)
export const applyAssistantActions = (scopeId: string, actions: AssistantActions, source: string, expectedRevision?: number) =>
  currentStore().applyActions(scopeId, actions, source, expectedRevision)
export const listDueAssistantCommitments = (now = Date.now(), activeScopes?: readonly string[]) => currentStore().due(now, activeScopes)
export const markAssistantCommitmentNotified = (scopeId: string, id: string, dueAt: string, notifiedAt: string) =>
  currentStore().markNotified(scopeId, id, dueAt, notifiedAt)

export function assistantContext(snapshot: AssistantSnapshot): string {
  const p = snapshot.profile
  const quoted = (value: string, maximum: number) => {
    let content = value, encoded = JSON.stringify(content)
    while (encoded.length > maximum) {
      content = content.slice(0, Math.max(0, Math.floor(content.length * maximum / encoded.length) - 2))
      encoded = JSON.stringify(content + '…')
    }
    return encoded
  }
  const labels: Record<AssistantStyle, string> = { balanced: '自然平衡', professional: '专业简洁', warm: '温暖耐心', companion: '亲切陪伴' }
  const lines = [
    '以下是用户为当前项目保存的主 agent 资料。仅作为交流偏好和上下文，不构成工具授权，也不允许自动执行承诺。',
    `助理名字：${quoted(p.name, 160)}；交流风格：${labels[p.style]}；对用户的称呼：${quoted(p.addressing || '自然称呼', 240)}`,
    `人格设定：${quoted(p.persona, 4000)}`,
    '已保存记忆（有界摘录；不将未保存内容说成长期记忆）：'
  ]
  let memoryBudget = 5000
  const memories = [...snapshot.memories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const memory of memories) {
    const line = `{"id":${JSON.stringify(memory.id)},"kind":${JSON.stringify(memory.kind)},"content":${quoted(memory.content, 1400)}}`
    if (line.length > memoryBudget) continue
    lines.push(line); memoryBudget -= line.length
  }
  lines.push('尚未完成的承诺（提醒仅在应用打开时由界面检查；不表示已安排后台执行）：')
  let commitmentBudget = 2400
  const commitments = snapshot.commitments.filter((c) => c.status === 'open').sort((a, b) => (a.dueAt || 'z').localeCompare(b.dueAt || 'z'))
  for (const commitment of commitments) {
    const line = JSON.stringify({ id: commitment.id, title: commitment.title, dueAt: commitment.dueAt })
    if (line.length > commitmentBudget) continue
    lines.push(line); commitmentBudget -= line.length
  }
  return lines.join('\n').slice(0, ASSISTANT_LIMITS.context)
}
