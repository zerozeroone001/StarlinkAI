import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { PortableBackupApi, PortablePreview, PortableProgress } from '../shared/portable-backup'
import { PORTABLE_LIMITS } from '../shared/portable-backup'
import { grokHome } from './paths'
import { runtimeRoot } from './runtime/cli'
import { atomicJson } from './runtime/run-journal'
import { imageMime } from './runtime/attachments'
import { assertUnlinkedPath, ensureDirectoryWithin, isPathWithin, readBoundedFile } from './file-boundary'
import { discardImportedAssistantSnapshot, exportAssistantSnapshot, importAssistantSnapshot, setAssistantRemindersPaused } from './runtime/assistant-store'
import type { AssistantSnapshot } from '../shared/assistant'
import { readPortableArchive, writePortableArchive } from './portable-archive'
import { assetReferences, backupSummary, parsePortableWorkspace, remapPortableWorkspace, serializePortableWorkspace,
  validatePortableManifest, workspaceScopes, type PortableManifest } from './portable-manifest'

interface Dependencies {
  busy(): boolean
  chooseSourceDirectory(name: string, original: string): Promise<string | null>
  chooseArchive(): Promise<string | null>
  chooseDestination(): Promise<string | null>
  root?: string
  workspacesRoot?: string
}
type Assets = Map<string, { path: string; size: number }>
interface Job { token: string; kind: 'export' | 'import'; directory: string; identity: fs.BigIntStats; manifest?: PortableManifest; assets: Assets; preview?: PortablePreview; controller: AbortController }
interface Journal { version: 1; operationId: string; scopes: string[]; kind: 'restore' | 'rollback' }
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/avif': 'avif', 'image/svg+xml': 'svg' }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Owns selected archive paths, resource authorization, staging, and the durable half of a two-store restore. */
export function createPortableBackupService(deps: Dependencies): PortableBackupApi & { locked(): boolean; activeScopes(): string[] } {
  const root = deps.root || path.join(grokHome(), 'desktop', 'portable-backups')
  const workspaces = deps.workspacesRoot || runtimeRoot
  const journalFile = path.join(root, 'pending-restore.json')
  let job: Job | undefined, operationRunning = false, commitPending = false, active: string[] = []
  let reconcileQueue = Promise.resolve(), reconciling = 0
  let progress: PortableProgress = { phase: 'idle', done: 0, total: 0, cancellable: false }
  const update = (phase: PortableProgress['phase'], done = 0, total = 0, cancellable = false) => { progress = { phase, done, total, cancellable } }
  const initialize = () => { fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(workspaces, { recursive: true }) }
  const readJournal = (): Journal | null => {
    if (!fs.existsSync(journalFile)) return null
    let value: Journal
    try { value = JSON.parse(readBoundedFile(journalFile, 128 * 1024).toString('utf8')) } catch { throw new Error('恢复日志无法读取；已保留原数据，请修复磁盘访问后重试。') }
    if (value?.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.operationId) || !['restore', 'rollback'].includes(value.kind) ||
      !Array.isArray(value.scopes) || value.scopes.length > 500 || value.scopes.some((s) => !/^[a-f0-9-]{36}$/.test(s))) throw new Error('恢复日志损坏；已停止切换工作区。')
    return value
  }
  const check = (current: Job) => { current.controller.signal.throwIfAborted(); if (job !== current) throw new Error('此备份预览已失效，请重新选择。') }
  const cleanJob = (current: Job) => {
    // Only directories allocated by this service may be recursively removed.
    const resolved = path.resolve(current.directory), parent = path.resolve(root)
    const identity = fs.statSync(assertUnlinkedPath(resolved), { bigint: true })
    if (identity.dev === current.identity.dev && identity.ino === current.identity.ino &&
      isPathWithin(parent, resolved) && path.dirname(resolved) === parent && path.basename(resolved).startsWith('job-'))
      fs.rmSync(resolved, { recursive: true, force: true })
    else throw new Error('备份暂存目录已变化，已保留未知文件。')
    if (job === current) job = undefined
  }
  const begin = (kind: Job['kind']) => {
    initialize()
    if (job || operationRunning || commitPending || reconciling || readJournal()) throw new Error('已有备份或恢复操作，请先完成或取消。')
    if (deps.busy()) throw new Error('请等待所有执行、附件上传和助手保存完成，再进行便携备份。')
    const directory = fs.mkdtempSync(path.join(root, 'job-'))
    job = { token: randomUUID(), kind, directory, identity: fs.statSync(directory, { bigint: true }), assets: new Map(), controller: new AbortController() }
    return job
  }
  const requireJob = (token: string, kind: Job['kind']) => {
    if (!job || typeof token !== 'string' || token !== job.token || job.kind !== kind || !job.manifest || !job.preview || operationRunning)
      throw new Error('此备份预览已失效，请重新选择。')
    check(job); return job
  }
  const acknowledgeMissing = (current: Job, allow: boolean) => {
    if (typeof allow !== 'boolean' || (current.preview!.warnings.length && !allow)) throw new Error('请先确认未能包含的文件，或取消并修复来源后重新备份。')
  }
  const fail = (current: Job, error: unknown): never => {
    update('failed'); try { cleanJob(current) } catch { /* Preserve staging on an IO failure. */ }
    throw error
  }
  const completePreview = (current: Job, name: string): PortablePreview => {
    const state = parsePortableWorkspace(JSON.stringify(current.manifest!.workspace))
    current.preview = { token: current.token, kind: current.kind, name, createdAt: current.manifest!.createdAt,
      ...backupSummary(state, current.manifest!, current.assets) }
    update('preview', current.assets.size, current.assets.size, true)
    return current.preview
  }
  const api: PortableBackupApi & { locked(): boolean; activeScopes(): string[] } = {
    locked: () => !!job || operationRunning || commitPending || reconciling > 0,
    activeScopes: () => [...active],
    status: async () => ({ ...progress }),
    async beginExport(text) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > PORTABLE_LIMITS.manifestBytes) throw new Error('工作区数据超过备份容量限制。')
      const current = begin('export'); operationRunning = true; update('collecting', 0, 0, true)
      try {
        const state = parsePortableWorkspace(text), refs = assetReferences(state), scopes = workspaceScopes(state)
        const manifest: PortableManifest = { format: 'independent-workspace-backup', version: 1, createdAt: new Date().toISOString(),
          workspace: JSON.parse(serializePortableWorkspace(state)), assistants: [], resources: [] }
        for (const scopeId of scopes) { check(current); manifest.assistants.push({ scopeId, snapshot: await exportAssistantSnapshot(scopeId) }) }
        const roots = new Map<string, string | null>()
        let total = 0
        for (const [index, ref] of refs.entries()) {
          check(current); update('collecting', index, refs.length, true)
          try {
            let bytes: Buffer
            if (/^data:/i.test(ref.source)) {
              const match = /^data:image\/[^;]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(ref.source)
              if (!match || match[1].length > Math.ceil(PORTABLE_LIMITS.assetBytes / 3) * 4) throw new Error('内嵌图片编码或大小无效')
              bytes = Buffer.from(match[1], 'base64')
              if (bytes.toString('base64') !== match[1]) throw new Error('内嵌图片编码无效')
            } else {
              if (/^(?:https?:|blob:)/i.test(ref.source)) throw new Error('在线图片没有下载，备份只保留不可用占位')
              const scope = state.teams.find((t) => t.id === ref.scopeId)!
              const internal = path.resolve(workspaces, scope.id)
              let source = ref.source
              if (/^file:/i.test(source)) source = fileURLToPath(source)
              const original = path.resolve(ref.cwd || scope.directory || internal, source)
              const managed = isPathWithin(internal, original)
              if (!managed && !roots.has(ref.scopeId)) {
                // Renderer-provided external directories require a native user selection.
                const external = scope.directory && path.resolve(scope.directory).toLowerCase() !== path.resolve(internal).toLowerCase()
                const selected = external ? await deps.chooseSourceDirectory(scope.name, scope.directory!) : internal
                check(current)
                const canonical = selected ? (external ? fs.realpathSync(selected) : assertUnlinkedPath(selected)) : null
                if (!external && canonical && !isPathWithin(assertUnlinkedPath(workspaces), canonical)) throw new Error('托管工作区目录链接无效')
                roots.set(ref.scopeId, canonical)
              }
              const anchor = managed ? assertUnlinkedPath(internal) : roots.get(ref.scopeId)
              if (!anchor) throw new Error('未确认此项目的文件来源目录')
              if (managed && !isPathWithin(assertUnlinkedPath(workspaces), anchor)) throw new Error('托管工作区目录链接无效')
              const cwd = ref.cwd && isPathWithin(anchor, path.resolve(ref.cwd)) ? ref.cwd : anchor
              const requested = managed ? original : path.resolve(cwd, source)
              if (!isPathWithin(anchor, requested)) throw new Error('文件位于已确认目录之外')
              const canonical = assertUnlinkedPath(requested)
              if (!isPathWithin(anchor, canonical)) throw new Error('文件链接指向已确认目录之外')
              if (ref.kind === 'attachment' && !isPathWithin(path.join(anchor, 'attachments'), canonical) &&
                !(managed && /^relinked-[a-f0-9-]{36}[\\/]attachments[\\/]/.test(path.relative(anchor, canonical))))
                throw new Error('附件不在项目的 attachments 目录中')
              bytes = readBoundedFile(canonical, ref.kind === 'attachment' ? 8 * 1024 * 1024 : PORTABLE_LIMITS.assetBytes)
              if (fs.realpathSync(requested) !== canonical || !isPathWithin(fs.realpathSync(anchor), canonical)) throw new Error('文件路径在读取时发生变化')
            }
            const mime = imageMime(bytes), extension = mime ? extensions[mime] : 'bin'
            if (ref.kind === 'image' && (!mime || !extension)) throw new Error('文件内容不是支持的图片')
            const hash = createHash('sha256').update(bytes).digest('hex')
            if (!current.assets.has(hash)) {
              total += bytes.length
              if (total > PORTABLE_LIMITS.totalAssetBytes) throw new Error('引用文件总大小超过 512 MiB')
              const file = path.join(current.directory, hash)
              fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
              current.assets.set(hash, { path: file, size: bytes.length })
            }
            manifest.resources.push({ key: ref.key, hash, size: bytes.length, extension })
          } catch (error) {
            check(current)
            manifest.resources.push({ key: ref.key, missing: error instanceof Error ? error.message.slice(0, 300) : '文件无法读取' })
          }
          await tick()
        }
        current.manifest = manifest
        if (Buffer.byteLength(JSON.stringify(manifest)) > PORTABLE_LIMITS.manifestBytes) throw new Error('备份清单超过 64 MiB，请减少内嵌图片后重试。')
        return completePreview(current, '当前工作区')
      } catch (error) { return fail(current, error) } finally { operationRunning = false }
    },
    async inspectImport() {
      const current = begin('import'); operationRunning = true; update('validating', 0, 0, true)
      try {
        const source = await deps.chooseArchive(); check(current)
        if (!source) { cleanJob(current); update('idle'); return null }
        const unpacked = await readPortableArchive(source, current.directory, { signal: current.controller.signal, onProgress: (done, total) => update('validating', done, total, true) })
        check(current)
        const { manifest } = validatePortableManifest(unpacked.manifest, unpacked.assets)
        current.manifest = manifest; current.assets = unpacked.assets
        // Verify content type independently of the supplied extension.
        const verifiedTypes = new Map<string, string | undefined>()
        for (const resource of manifest.resources) if (resource.hash && resource.extension !== 'bin') {
          if (!verifiedTypes.has(resource.hash)) {
            check(current)
            const mime = imageMime(readBoundedFile(current.assets.get(resource.hash)!.path, PORTABLE_LIMITS.assetBytes))
            verifiedTypes.set(resource.hash, mime ? extensions[mime] : undefined)
            await tick()
          }
          if (verifiedTypes.get(resource.hash) !== resource.extension) throw new Error('备份图片内容与声明的类型不一致。')
        }
        return completePreview(current, path.basename(source))
      } catch (error) { return fail(current, error) } finally { operationRunning = false }
    },
    async writeExport(token, allowIncomplete) {
      const current = requireJob(token, 'export'); acknowledgeMissing(current, allowIncomplete); operationRunning = true
      try {
        const destination = await deps.chooseDestination(); check(current)
        if (!destination) { cleanJob(current); update('idle'); return null }
        update('writing', 0, current.assets.size, true)
        await writePortableArchive(destination, current.manifest!, [...current.assets].map(([hash, asset]) => ({ hash, ...asset })),
          { signal: current.controller.signal, onProgress: (done, total) => update('writing', done, total, true) })
        check(current); cleanJob(current); update('complete'); return { name: path.basename(destination) }
      } catch (error) { return fail(current, error) } finally { operationRunning = false }
    },
    async prepareRestore(token, allowIncomplete) {
      const current = requireJob(token, 'import'); acknowledgeMissing(current, allowIncomplete)
      if (deps.busy()) throw new Error('请等待所有执行和保存完成，再恢复备份。')
      operationRunning = true; update('preparing', 0, current.assets.size, true)
      const createdDirectories = new Map<string, fs.BigIntStats>()
      const importedAssistants: { scopeId: string; source: AssistantSnapshot }[] = []
      try {
        const state = parsePortableWorkspace(JSON.stringify(current.manifest!.workspace))
        const mapped = remapPortableWorkspace(state, current.manifest!, (id) => path.join(workspaces, id))
        const targetBytes = new Map(mapped.copies.map((copy) => [copy.destination, current.assets.get(copy.hash)!.size]))
        if ([...targetBytes.values()].reduce((sum, size) => sum + size, 0) > PORTABLE_LIMITS.totalAssetBytes)
          throw new Error('恢复后的文件总大小超过 512 MiB，未替换当前工作区。')
        const workspaceParent = assertUnlinkedPath(workspaces), parentIdentity = fs.statSync(workspaceParent, { bigint: true })
        const verifyParent = () => {
          const canonical = assertUnlinkedPath(workspaces), identity = fs.statSync(canonical, { bigint: true })
          if (path.relative(canonical, workspaceParent) !== '' || !identity.isDirectory() ||
            identity.dev !== parentIdentity.dev || identity.ino !== parentIdentity.ino) throw new Error('恢复目录的父目录已变化。')
        }
        const verifyBase = (directory: string) => {
          verifyParent()
          const canonical = assertUnlinkedPath(directory), identity = fs.statSync(canonical, { bigint: true }), expected = createdDirectories.get(directory)
          if (!expected || !identity.isDirectory() || path.relative(workspaceParent, path.dirname(canonical)) !== '' ||
            path.relative(canonical, directory) !== '' || identity.dev !== expected.dev || identity.ino !== expected.ino)
            throw new Error('恢复目录已被替换，已停止写入。')
        }
        for (const directory of mapped.directories.values()) {
          check(current)
          verifyParent()
          if (fs.existsSync(directory) || path.relative(workspaceParent, path.dirname(path.resolve(directory))) !== '') throw new Error('恢复目录冲突，原数据保持不变。')
          fs.mkdirSync(directory, { mode: 0o700 })
          createdDirectories.set(directory, fs.statSync(directory, { bigint: true }))
          verifyBase(directory)
        }
        let completed = 0
        const written = new Map<string, { verify: () => void }>()
        for (const copy of mapped.copies) {
          check(current)
          if (written.has(copy.destination)) continue
          const base = [...mapped.directories.values()].find((dir) => isPathWithin(dir, copy.destination))!
          verifyBase(base)
          const folder = ensureDirectoryWithin(base, path.relative(base, path.dirname(copy.destination)))
          const target = path.join(folder, path.basename(copy.destination))
          const folderIdentity = fs.statSync(assertUnlinkedPath(path.dirname(copy.destination)), { bigint: true })
          const verifyFolder = () => {
            verifyBase(base)
            const canonical = assertUnlinkedPath(path.dirname(copy.destination)), identity = fs.statSync(canonical, { bigint: true })
            if (path.relative(folder, canonical) !== '' || !identity.isDirectory() ||
              identity.dev !== folderIdentity.dev || identity.ino !== folderIdentity.ino) throw new Error('恢复文件夹已被替换，已停止写入。')
          }
          const bytes = readBoundedFile(current.assets.get(copy.hash)!.path, PORTABLE_LIMITS.assetBytes)
          if (createHash('sha256').update(bytes).digest('hex') !== copy.hash) throw new Error('暂存文件已改变，恢复已停止。')
          verifyFolder()
          const fd = fs.openSync(target, 'wx', 0o600)
          let completedIdentity: fs.BigIntStats
          const verifyTarget = (expected: fs.BigIntStats) => {
            verifyFolder()
            const canonical = assertUnlinkedPath(target), actual = fs.statSync(canonical, { bigint: true })
            if (path.relative(canonical, copy.destination) !== '' || !actual.isFile() || actual.nlink !== 1n ||
              actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size ||
              actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) throw new Error('恢复文件已变化，已停止写入。')
          }
          try {
            const opened = fs.fstatSync(fd, { bigint: true })
            // Check the opened handle against the original destination before
            // writing content: wx alone does not prevent a parent junction swap.
            if (!opened.isFile() || opened.size !== 0n) throw new Error('恢复文件已变化，已停止写入。')
            verifyTarget(opened)
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd)
            completedIdentity = fs.fstatSync(fd, { bigint: true })
            if (completedIdentity.size !== BigInt(bytes.length)) throw new Error('恢复文件写入不完整。')
            verifyTarget(completedIdentity)
          } finally { fs.closeSync(fd) }
          written.set(copy.destination, { verify: () => verifyTarget(completedIdentity) })
          update('preparing', ++completed, mapped.copies.length, true); await tick()
        }
        for (const assistant of current.manifest!.assistants) {
          check(current)
          const scopeId = mapped.ids.get(assistant.scopeId)!
          importedAssistants.push({ scopeId, source: assistant.snapshot })
          await importAssistantSnapshot(scopeId, assistant.snapshot)
        }
        check(current)
        for (const directory of createdDirectories.keys()) verifyBase(directory)
        for (const item of written.values()) item.verify()
        const operationId = randomUUID(), workspaceText = serializePortableWorkspace(mapped.state)
        const journal: Journal = { version: 1, operationId, scopes: [...mapped.directories.keys()].map((id) => mapped.ids.get(id)!), kind: 'restore' }
        // After this durable journal is published, cancellation cannot race the IDB commit.
        commitPending = true; update('committing')
        await atomicJson(journalFile, journal, false)
        cleanJob(current)
        return { operationId, workspaceText }
      } catch (error) {
        // Cleanup requires positive evidence that no durable prepare record was
        // published. Unknown disk state keeps both sides for startup recovery.
        let noJournal = false
        try { commitPending = !!readJournal(); noJournal = !commitPending } catch { commitPending = true }
        if (noJournal) {
          for (const assistant of importedAssistants) await discardImportedAssistantSnapshot(assistant.scopeId, assistant.source).catch(() => {})
          for (const [directory, identity] of createdDirectories) {
            try {
              const actual = assertUnlinkedPath(directory), stat = fs.statSync(actual, { bigint: true })
              if (stat.dev === identity.dev && stat.ino === identity.ino && path.dirname(actual) === assertUnlinkedPath(workspaces))
                fs.rmSync(actual, { recursive: true, force: true })
            } catch { /* Never delete replaced or unreadable directories. */ }
          }
        }
        return fail(current, error)
      } finally { operationRunning = false }
    },
    async prepareRollback() {
      initialize()
      if (api.locked() || readJournal() || deps.busy()) throw new Error('请等待当前操作完成，再回退工作区。')
      commitPending = true; update('committing')
      const operationId = randomUUID()
      try { await atomicJson(journalFile, { version: 1, operationId, scopes: [], kind: 'rollback' } satisfies Journal, false); return operationId }
      catch (error) { commitPending = !!readJournal(); throw error }
    },
    async reconcile(marker, scopes) {
      if ((marker !== null && (typeof marker !== 'string' || !/^[a-f0-9-]{36}$/.test(marker))) ||
        !Array.isArray(scopes) || scopes.length > 500 || scopes.some((id) => typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))) throw new Error('工作区提交确认无效。')
      if (operationRunning) throw new Error('备份操作仍在进行，请稍后重试。')
      reconciling++
      const operation = reconcileQueue.then(async () => {
        const journal = readJournal()
        if (journal) {
        // This is called only after an authoritative readable IDB head. A lost
        // renderer/ACK is not evidence of failure. Unreferenced new data is kept
        // as an inactive recovery copy, never scheduled or deleted on a timeout.
        const record = { ...journal, outcome: marker === journal.operationId ? 'committed' : 'not-committed', reconciledAt: new Date().toISOString() }
        await atomicJson(path.join(root, `restore-${journal.operationId}.json`), record, false)
        await fs.promises.unlink(journalFile)
        }
        active = [...new Set(scopes)]; commitPending = false
        if (journal) update('complete')
      })
      reconcileQueue = operation.catch(() => {})
      try { await operation } finally { reconciling-- }
    },
    async cancel(token) {
      if (commitPending || progress.phase === 'committing') throw new Error('工作区正在提交，完成后才能关闭。')
      if (!job) return
      if (token !== undefined && token !== job.token) throw new Error('此备份预览已失效。')
      job.controller.abort(new Error('已取消备份操作，工作区未被替换。'))
      if (!operationRunning) { cleanJob(job); update('idle') }
    },
    async setRemindersPaused(scopeId, paused, revision) {
      if (api.locked() || !active.includes(scopeId)) throw new Error('工作区正在恢复或此助手已不在当前工作区。')
      return setAssistantRemindersPaused(scopeId, paused, revision)
    }
  }
  return api
}
