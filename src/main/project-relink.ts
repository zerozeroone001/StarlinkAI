import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ProjectRelinkApi, ProjectRelinkPreview } from '../shared/project-relink'
import { PORTABLE_LIMITS } from '../shared/portable-backup'
import { runtimeRoot } from './runtime/cli'
import { imageMime } from './runtime/attachments'
import { resolveProjectDirectory } from './project-directory'
import { assertUnlinkedPath, ensureDirectoryWithin, ensureUnlinkedDirectory, isPathWithin, readBoundedFile } from './file-boundary'
import { assetReferences, galleryKey, serializePortableWorkspace } from './portable-manifest'
import { parseWorkspaceSnapshot, type WorkspaceBackupState } from '../renderer/src/lib/workspace-backup'

interface Dependencies {
  busy(): boolean
  chooseDirectory(original?: string): Promise<string | null>
  chooseSourceDirectory(name: string, original: string): Promise<string | null>
  workspacesRoot?: string
}
interface Job {
  token: string; projectId: string; controller: AbortController; state?: WorkspaceBackupState
  preview?: ProjectRelinkPreview; directory?: string; directoryIdentity?: fs.BigIntStats
  folder?: string; folderIdentity?: fs.BigIntStats; parent?: string; parentIdentity?: fs.BigIntStats
  files: { path: string; hash: string; size: number }[]
  roots: Map<string, fs.BigIntStats>
}
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && b.isDirectory()
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/avif': 'avif', 'image/svg+xml': 'svg' }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Prepares only new managed copies. Source trees and assistant scope IDs never change. */
export function createProjectRelinkService(deps: Dependencies): ProjectRelinkApi & { locked(): boolean; reconcileAfterWorkspaceRead(): Promise<void> } {
  const workspaces = deps.workspacesRoot || runtimeRoot
  let job: Job | undefined
  let progress: Awaited<ReturnType<ProjectRelinkApi['status']>> = { phase: 'idle', done: 0, total: 0, cancellable: false }
  const check = (current: Job) => {
    current.controller.signal.throwIfAborted()
    if (job !== current) throw new Error('目录关联预览已失效，请重新选择。')
  }
  const verifyRoot = (current: Job, root: string) => {
    const actual = fs.statSync(assertUnlinkedPath(root), { bigint: true })
    const expected = current.roots.get(root)
    if (expected && !same(expected, actual)) throw new Error('已确认的原文件目录已变化，请重新选择。')
    if (!expected) current.roots.set(root, actual)
  }
  const cleanup = (current: Job) => {
    if (!current.folder || !current.parent || !current.folderIdentity || !current.parentIdentity) return
    const folder = assertUnlinkedPath(current.folder), parent = assertUnlinkedPath(current.parent)
    if (path.dirname(folder) !== parent || !isPathWithin(assertUnlinkedPath(workspaces), parent) ||
      path.basename(folder) !== `relinked-${current.token}` || !same(current.parentIdentity, fs.statSync(parent, { bigint: true })) ||
      !same(current.folderIdentity, fs.statSync(folder, { bigint: true }))) throw new Error('暂存目录已变化，已保留未知文件。')
    fs.rmSync(folder, { recursive: true, force: true })
  }
  const release = () => { job = undefined; progress = { phase: 'idle', done: 0, total: 0, cancellable: false } }
  const api: ProjectRelinkApi & { locked(): boolean; reconcileAfterWorkspaceRead(): Promise<void> } = {
    locked: () => !!job,
    async reconcileAfterWorkspaceRead() {
      if (!job) return
      // A newly hydrated renderer has read the authoritative DB. An old
      // renderer's lost response must not keep the host permanently locked.
      // Published plans retain copies whichever snapshot actually committed.
      if (progress.phase === 'committing') release()
      else await api.cancel()
    },
    status: async () => ({ ...progress }),
    async prepare(text, projectId) {
      if (job || deps.busy()) throw new Error('请等待执行、文件上传、助手保存或备份完成后再关联目录。')
      if (typeof text !== 'string' || typeof projectId !== 'string') throw new Error('项目资料无效。')
      const state = parseWorkspaceSnapshot(text, PORTABLE_LIMITS.manifestBytes, true)
      const project = state.teams.find((team) => team.id === projectId && team.kind === 'project' && !team.parentId)
      if (!project) throw new Error('项目不存在。')
      const current: Job = { token: randomUUID(), projectId, controller: new AbortController(), state, files: [], roots: new Map() }
      job = current; progress = { phase: 'preparing', done: 0, total: 0, cancellable: true }
      try {
        const selected = await deps.chooseDirectory(project.directory)
        check(current)
        if (!selected) { release(); return null }
        const directory = resolveProjectDirectory(selected)
        if (project.directory && path.relative(path.resolve(project.directory), directory) === '') throw new Error('选择的目录与当前目录相同。')
        current.directory = directory; current.directoryIdentity = fs.statSync(directory, { bigint: true })
        const managed = path.resolve(workspaces, projectId)
        const oldDirectory = project.directory || managed
        const refs = assetReferences(state).filter((ref) => ref.scopeId === projectId)
        const warnings: ProjectRelinkPreview['warnings'] = [], finalizers = new Set<() => void>(), aliases = new Map<string, string>()
        const known = new Map<string, { path: string; hash: string; size: number }>()
        let sourceRoot: string | null | undefined, totalBytes = 0
        progress.total = refs.length
        for (const [index, ref] of refs.entries()) {
          check(current)
          try {
            // Online and inline media remain independent of the working directory.
            if (/^(?:https?:|data:|blob:)/i.test(ref.source)) continue
            const source = /^file:/i.test(ref.source) ? fileURLToPath(ref.source) : ref.source
            const requested = path.resolve(ref.cwd || oldDirectory, source)
            const internal = isPathWithin(managed, requested)
            let anchor: string, candidate: string
            if (internal) {
              anchor = assertUnlinkedPath(managed)
              if (!isPathWithin(assertUnlinkedPath(workspaces), anchor)) throw new Error('托管资料目录无效')
              candidate = requested
            } else {
              if (!isPathWithin(path.resolve(oldDirectory), requested)) throw new Error('历史文件位于原项目目录之外')
              if (sourceRoot === undefined) {
                const selectedSource = await deps.chooseSourceDirectory(project.name, oldDirectory)
                check(current)
                sourceRoot = selectedSource ? resolveProjectDirectory(selectedSource) : null
                if (sourceRoot) verifyRoot(current, sourceRoot)
              }
              if (!sourceRoot) throw new Error('未确认原项目的引用文件来源')
              anchor = sourceRoot
              candidate = path.resolve(anchor, path.relative(path.resolve(oldDirectory), requested))
            }
            const canonical = assertUnlinkedPath(candidate)
            verifyRoot(current, anchor)
            if (!isPathWithin(anchor, canonical)) throw new Error('文件位于已确认来源目录之外')
            // Managed copies can be in a previous relink operation's subdirectory.
            if (!internal && ref.kind === 'attachment' && !isPathWithin(path.join(anchor, 'attachments'), canonical))
              throw new Error('附件不在原项目的 attachments 目录中')
            const bytes = readBoundedFile(canonical, ref.kind === 'attachment' ? 8 * 1024 * 1024 : PORTABLE_LIMITS.assetBytes)
            verifyRoot(current, anchor)
            const mime = imageMime(bytes)
            if (ref.kind === 'image' && !mime) throw new Error('引用文件不是支持的图片')
            const hash = createHash('sha256').update(bytes).digest('hex')
            const key = `${ref.kind}:${canonical}`
            let saved = known.get(key)
            if (!saved) {
              if (totalBytes + bytes.length > PORTABLE_LIMITS.totalAssetBytes) throw new Error('引用文件总量超过 512 MiB')
              let target = canonical
              if (!internal) {
                if (!current.folder) {
                  current.parent = ensureUnlinkedDirectory(path.join(workspaces, projectId))
                  current.parentIdentity = fs.statSync(current.parent, { bigint: true })
                  current.folder = path.join(current.parent, `relinked-${current.token}`)
                  fs.mkdirSync(current.folder)
                  current.folderIdentity = fs.statSync(current.folder, { bigint: true })
                }
                const subdirectory = ensureDirectoryWithin(current.folder, ref.kind === 'attachment' ? 'attachments' : 'images')
                assertUnlinkedPath(subdirectory)
                const safeName = ref.name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'file'
                target = path.join(subdirectory, ref.kind === 'image' ? `${hash}.${extensions[mime!]}` : `${randomUUID()}-${safeName}`)
                if (!fs.existsSync(target)) {
                  const fd = fs.openSync(target, 'wx', 0o600)
                  try {
                    const stat = fs.fstatSync(fd, { bigint: true }), actual = fs.statSync(assertUnlinkedPath(target), { bigint: true })
                    if (stat.dev !== actual.dev || stat.ino !== actual.ino ||
                      !same(current.parentIdentity!, fs.statSync(assertUnlinkedPath(current.parent!), { bigint: true })) ||
                      !same(current.folderIdentity!, fs.statSync(assertUnlinkedPath(current.folder), { bigint: true })))
                      throw new Error('准备期间托管目录已变化')
                    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd)
                  } finally { fs.closeSync(fd) }
                }
                if (!readBoundedFile(target, PORTABLE_LIMITS.assetBytes).equals(bytes)) throw new Error('引用文件副本校验失败')
              }
              totalBytes += bytes.length
              saved = { path: target, hash, size: bytes.length }; known.set(key, saved); current.files.push(saved)
            }
            for (const alias of ref.aliases) aliases.set(galleryKey(alias, ref.cwd || oldDirectory), galleryKey(saved.path, managed))
            ref.replace(saved.path, saved.size)
            if (ref.finalize) finalizers.add(ref.finalize)
          } catch (error) {
            check(current)
            warnings.push({ name: ref.name, reason: error instanceof Error ? error.message.slice(0, 300) : '引用文件无法读取' })
            // A missing relative file must never start resolving to an unrelated
            // same-named file in the new source directory.
            if (!/^(?:https?:|data:|blob:)/i.test(ref.source)) {
              const source = /^file:/i.test(ref.source) ? fileURLToPath(ref.source) : ref.source
              ref.replace(path.resolve(ref.cwd || oldDirectory, source))
              if (ref.finalize) finalizers.add(ref.finalize)
            }
          } finally { progress.done = index + 1; await tick() }
        }
        for (const finalize of finalizers) finalize()
        state.deletedGalleryKeys = state.deletedGalleryKeys.map((key) => aliases.get(key) || key)
        for (const team of state.teams.filter((team) => team.id === projectId || team.parentId === projectId)) {
          const historyId = (id?: string) => id ? `restored-history:${id.replace(/^(?:restored-history:)+/, '')}` : undefined
          for (const message of team.messages) {
            message.cwd ||= oldDirectory
            message.sessionId = undefined
            message.runId = historyId(message.runId)
          }
          for (const task of team.tasks) {
            task.managedRunId = undefined; task.managedStatus = undefined
            task.resultRunId = historyId(task.resultRunId); task.acceptedRunId = historyId(task.acceptedRunId)
          }
          team.directory = directory
          team.permissionMode = 'ask'
        }
        check(current)
        current.preview = { token: current.token, projectId, directory, files: known.size, bytes: totalBytes, warnings }
        progress = { ...progress, phase: 'preview', cancellable: true }
        return structuredClone(current.preview)
      } catch (error) {
        try { cleanup(current) } catch { /* Keep unproven paths. */ }
        if (job === current) release()
        throw error
      }
    },
    async commit(token, allowIncomplete) {
      const current = job
      if (!current?.preview || current.token !== token || progress.phase !== 'preview') throw new Error('目录关联预览已失效，请重新选择。')
      if (typeof allowIncomplete !== 'boolean' || (current.preview.warnings.length && !allowIncomplete)) throw new Error('请确认无法保留的引用文件，或取消并修复来源。')
      check(current)
      for (const root of current.roots.keys()) verifyRoot(current, root)
      const directory = resolveProjectDirectory(current.directory!)
      if (path.relative(directory, current.directory!) !== '' || !same(current.directoryIdentity!, fs.statSync(directory, { bigint: true })))
        throw new Error('选定的源码目录已变化，请重新选择。')
      for (const file of current.files) {
        if (createHash('sha256').update(readBoundedFile(file.path, PORTABLE_LIMITS.assetBytes)).digest('hex') !== file.hash)
          throw new Error('准备期间引用文件已变化，请重新关联。')
      }
      // After publishing this plan, the renderer may have durably committed it.
      // Cancellation or lost IPC must never delete any of its file copies.
      const workspaceText = serializePortableWorkspace(current.state!)
      progress = { ...progress, phase: 'committing', cancellable: false }
      return { workspaceText }
    },
    async finish(token) {
      if (!job) return
      if (job.token !== token || progress.phase !== 'committing') throw new Error('目录关联操作无效。')
      release()
    },
    async cancel(token) {
      if (!job) return
      if (token !== undefined && token !== job.token) throw new Error('目录关联预览已失效。')
      if (progress.phase === 'committing') throw new Error('目录正在保存，请等待完成。')
      job.controller.abort(new Error('已取消目录关联。'))
      if (progress.phase === 'preparing') return
      const current = job
      try { cleanup(current) } finally { release() }
    }
  }
  return api
}
