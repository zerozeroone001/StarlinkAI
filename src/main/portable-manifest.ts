import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { extractMediaFromText } from '../shared/media'
import { PORTABLE_LIMITS, type PortableCounts, type PortableWarning } from '../shared/portable-backup'
import type { AssistantSnapshot } from '../shared/assistant'
import { createWorkspaceBackup, parseWorkspaceBackup, type WorkspaceBackupState } from '../renderer/src/lib/workspace-backup'
import { validateAssistantSnapshot } from './runtime/assistant-store'

export interface BackupResource {
  key: string; hash?: string; size?: number; extension?: string; missing?: string
}
export interface PortableManifest {
  format: 'independent-workspace-backup'; version: 1; createdAt: string
  workspace: unknown
  assistants: { scopeId: string; snapshot: AssistantSnapshot }[]
  resources: BackupResource[]
}
export interface AssetReference {
  key: string; teamId: string; scopeId: string; source: string; cwd?: string
  kind: 'attachment' | 'image'; name: string; aliases: string[]
  replace: (file: string, size?: number) => void
  finalize?: () => void
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const parsePortableWorkspace = (text: string) => parseWorkspaceBackup(text, PORTABLE_LIMITS.manifestBytes, true)
export const serializePortableWorkspace = (state: WorkspaceBackupState) => createWorkspaceBackup(state, PORTABLE_LIMITS.manifestBytes, true)
export const workspaceScopes = (state: WorkspaceBackupState): string[] => [...new Set(state.teams.map((t) => t.parentId || t.id))]

/** Only explicit attachment/image references are inventoried; receipts and arbitrary tool paths are never read. */
export function assetReferences(state: WorkspaceBackupState): AssetReference[] {
  const refs: AssetReference[] = []
  const addText = (teamId: string, scopeId: string, key: string[], text: string, cwd: string | undefined, set: (text: string) => void) => {
    const replacements = new Map<string, string>()
    const finalize = () => {
      if (!replacements.size) return
      const escaped = [...replacements.keys()].sort((a, b) => b.length - a.length).map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp(escaped.join('|'), 'g')
      const rewrite = (value: string) => value.replace(pattern, (source) => replacements.get(source)!)
      try {
        const json = JSON.parse(text)
        const walk = (value: unknown): unknown => typeof value === 'string' ? rewrite(value) : Array.isArray(value) ? value.map(walk)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)])) : value
        set(JSON.stringify(walk(json), null, 2))
      } catch { set(rewrite(text)) }
    }
    extractMediaFromText(text).forEach((image, i) => {
      const source = image.dataUrl || image.path
      if (!source) return
      refs.push({ key: JSON.stringify([...key, String(i)]), teamId, scopeId, source, cwd, kind: 'image',
        name: image.alt || (source.startsWith('data:') ? '内嵌图片' : path.basename(source)), aliases: [source],
        replace: (file) => { replacements.set(source, file.replace(/\\/g, '/')) }, finalize })
    })
  }
  for (const team of state.teams) {
    const scopeId = team.parentId || team.id
    const directory = state.teams.find((t) => t.id === scopeId)?.directory || team.directory
    const addAttachment = (file: typeof state.attachmentDrafts[string][number], key: string[], cwd?: string) => {
      refs.push({ key: JSON.stringify(key), teamId: team.id, scopeId, source: file.path, cwd, kind: 'attachment', name: file.name,
        aliases: [file.path], replace: (target, size) => { file.path = target; if (size !== undefined) file.size = size } })
    }
    for (const [i, file] of (state.attachmentDrafts[team.id] || []).entries()) addAttachment(file, [team.id, 'draft-attachment', String(i)], directory)
    if (state.drafts[team.id]) addText(team.id, scopeId, [team.id, 'draft-image'], state.drafts[team.id], directory, (text) => { state.drafts[team.id] = text })
    for (const message of team.messages) {
      for (const [i, file] of (message.attachments || []).entries()) addAttachment(file, [team.id, message.id, 'attachment', String(i)], message.cwd || directory)
      for (const [i, image] of (message.images || []).entries()) {
        const source = image.dataUrl || image.path
        if (!source) continue
        refs.push({ key: JSON.stringify([team.id, message.id, 'image', String(i)]), teamId: team.id, scopeId, source,
          cwd: message.cwd || directory, kind: 'image', name: image.alt || (source.startsWith('data:') ? '内嵌图片' : path.basename(source)),
          aliases: [source, image.sourcePath || ''].filter(Boolean),
          replace: (file) => { image.path = file; delete image.dataUrl; delete image.sourcePath } })
      }
      addText(team.id, scopeId, [team.id, message.id, 'text-image'], message.text, message.cwd || directory, (text) => { message.text = text })
    }
    for (const artifact of team.artifacts) addText(team.id, scopeId, [team.id, artifact.id, 'artifact-image'], artifact.content, directory, (text) => { artifact.content = text })
  }
  if (refs.length > PORTABLE_LIMITS.files) throw new Error('备份引用文件过多，最多支持 10,000 个引用。')
  return refs
}

export function validatePortableManifest(value: unknown, assets: Map<string, { path: string; size: number }>): { manifest: PortableManifest; state: WorkspaceBackupState } {
  if (!record(value) || value.format !== 'independent-workspace-backup' || value.version !== 1 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.assistants) || !Array.isArray(value.resources)) throw new Error('不支持此便携备份格式。')
  const state = parsePortableWorkspace(JSON.stringify(value.workspace))
  const scopes = workspaceScopes(state)
  if (value.assistants.length !== scopes.length) throw new Error('备份的助手资料不完整。')
  const assistants = value.assistants.map((a) => {
    if (!record(a) || typeof a.scopeId !== 'string' || !scopes.includes(a.scopeId)) throw new Error('助手所属工作区无效。')
    return { scopeId: a.scopeId, snapshot: validateAssistantSnapshot(a.snapshot, a.scopeId) }
  })
  if (new Set(assistants.map((a) => a.scopeId)).size !== scopes.length) throw new Error('备份存在重复助手资料。')
  const refs = assetReferences(state)
  if (value.resources.length !== refs.length) throw new Error('备份的文件引用清单不完整。')
  const keys = new Set(refs.map((r) => r.key)), used = new Set<string>()
  const resources: BackupResource[] = value.resources.map((r) => {
    if (!record(r) || typeof r.key !== 'string' || !keys.delete(r.key)) throw new Error('备份有重复或未知文件引用。')
    if (typeof r.missing === 'string' && r.missing.length > 0 && r.missing.length <= 300 && r.hash === undefined)
      return { key: r.key, missing: r.missing }
    if (typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash) || !assets.has(r.hash) ||
      !Number.isSafeInteger(r.size) || r.size !== assets.get(r.hash)!.size || typeof r.extension !== 'string' || !/^(?:bin|png|jpg|gif|webp|bmp|ico|avif|svg)$/.test(r.extension))
      throw new Error('备份文件缺失、大小不一致或类型无效。')
    if (refs.find((ref) => ref.key === r.key)!.kind === 'attachment' && Number(r.size) > 8 * 1024 * 1024) throw new Error('备份附件超过 8 MiB。')
    if (refs.find((ref) => ref.key === r.key)!.kind === 'image' && r.extension === 'bin') throw new Error('备份图片缺少有效类型。')
    used.add(r.hash)
    return { key: r.key, hash: r.hash, size: Number(r.size), extension: r.extension }
  })
  if (used.size !== assets.size) throw new Error('备份包含没有引用的额外文件。')
  return { manifest: { format: 'independent-workspace-backup', version: 1, createdAt: value.createdAt, workspace: value.workspace, assistants, resources }, state }
}

export function backupSummary(state: WorkspaceBackupState, manifest: PortableManifest, assets: Map<string, { size: number }>): { counts: PortableCounts; warnings: PortableWarning[] } {
  const refs = assetReferences(state), byKey = new Map(refs.map((r) => [r.key, r]))
  return { counts: {
    projects: state.teams.filter((t) => t.kind === 'project').length,
    conversations: state.teams.filter((t) => t.kind === 'conversation').length,
    messages: state.teams.reduce((n, t) => n + t.messages.length, 0), drafts: Object.values(state.drafts).filter(Boolean).length,
    assistants: manifest.assistants.length, memories: manifest.assistants.reduce((n, a) => n + a.snapshot.memories.length, 0),
    reminders: manifest.assistants.reduce((n, a) => n + a.snapshot.commitments.length, 0),
    attachments: refs.filter((r) => r.kind === 'attachment').length, images: refs.filter((r) => r.kind === 'image').length,
    files: assets.size, bytes: [...assets.values()].reduce((n, a) => n + a.size, 0)
  }, warnings: manifest.resources.filter((r) => r.missing).map((r) => ({ name: byKey.get(r.key)!.name, reason: r.missing! })) }
}

export function galleryKey(source: string, cwd: string): string {
  if (/^(?:data:|https?:|blob:)/i.test(source)) return source
  let local = source
  try { if (/^file:/i.test(source)) local = fileURLToPath(source) } catch { /* keep an unavailable alias */ }
  const normalized = path.resolve(cwd, local).replace(/\\/g, '/')
  const hash = normalized.match(/\/images\/([a-f\d]{64})\.[a-z\d]+$/i)
  return hash ? `sha256:${hash[1].toLowerCase()}` : /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}
export function remapPortableWorkspace(state: WorkspaceBackupState, manifest: PortableManifest, directoryFor: (scopeId: string) => string) {
  const ids = new Map(state.teams.map((t) => [t.id, randomUUID()]))
  const directories = new Map(workspaceScopes(state).map((oldId) => [oldId, directoryFor(ids.get(oldId)!)]))
  const resources = new Map(manifest.resources.map((r) => [r.key, r]))
  const copies: { hash: string; destination: string; kind: 'attachment' | 'image'; extension: string }[] = []
  const aliases = new Map<string, string>()
  const finalizers = new Set<() => void>()
  for (const ref of assetReferences(state)) {
    const resource = resources.get(ref.key)!
    const dir = directories.get(ref.scopeId)!
    const safeName = ref.name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'file'
    const name = ref.kind === 'attachment' ? `${randomUUID()}-${safeName}` : `${resource.hash || createHash('sha256').update(ref.key).digest('hex')}.${resource.extension || 'png'}`
    const destination = path.join(dir, resource.missing ? 'missing-backup-files' : ref.kind === 'attachment' ? 'attachments' : 'images', name)
    if (resource.hash) copies.push({ hash: resource.hash, destination, kind: ref.kind, extension: resource.extension! })
    const replacement = ref.kind === 'image' && resource.hash ? `sha256:${resource.hash}` : galleryKey(destination, dir)
    for (const alias of ref.aliases) aliases.set(galleryKey(alias, ref.cwd || ref.teamId), replacement)
    ref.replace(destination, resource.size)
    if (ref.finalize) finalizers.add(ref.finalize)
  }
  for (const finalize of finalizers) finalize()
  state.deletedGalleryKeys = state.deletedGalleryKeys.map((key) => aliases.get(key) || key)
  state.drafts = Object.fromEntries(Object.entries(state.drafts).map(([id, text]) => [ids.get(id)!, text]))
  state.attachmentDrafts = Object.fromEntries(Object.entries(state.attachmentDrafts).map(([id, files]) => [ids.get(id)!, files]))
  state.activeTeamId = ids.get(state.activeTeamId)!
  state.teams = state.teams.map((team) => ({ ...team, id: ids.get(team.id)!, parentId: team.parentId ? ids.get(team.parentId)! : null,
    directory: directories.get(team.parentId || team.id)!,
    messages: team.messages.map((message) => ({ ...message, cwd: directories.get(team.parentId || team.id)! })) }))
  return { state, ids, copies, directories }
}
