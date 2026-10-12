import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Download, Upload } from 'lucide-react'
import { flushWorkspaceStorage, hasPortableRestorePoint, isActive, useCollaboration } from '@/stores/collaboration'
import { useAssistant } from '@/stores/assistant'
import { portableErrorMessage, type PortableAction } from '@/lib/portable-backup-display'
import { PortableBackupDialog } from './PortableBackupDialog'
import { workspaceStorageStatus } from '@/lib/workspace-storage-status'
import { createWorkspaceBackup, downloadWorkspaceBackup, MAX_WORKSPACE_BACKUP_BYTES, parseWorkspaceBackup, type WorkspaceBackupState } from '@/lib/workspace-backup'

export function WorkspaceExportButton({ className = 'secondary' }: { className?: string }) {
  const [error, setError] = useState('')
  return <>
    <button type="button" className={className} onClick={() => {
      try { downloadWorkspaceBackup(createWorkspaceBackup(useCollaboration.getState())); setError('') }
      catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败，请重试。') }
    }}>导出工作区备份</button>
    {error && <span role="alert">{error}</span>}
  </>
}

export function WorkspaceDataSettings() {
  const storage = useSyncExternalStore(workspaceStorageStatus.subscribe, workspaceStorageStatus.getSnapshot)
  const input = useRef<HTMLInputElement>(null)
  const [candidate, setCandidate] = useState<{ text: string; state: WorkspaceBackupState; name: string } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reading, setReading] = useState(false)
  const [portable, setPortable] = useState<PortableAction | null>(null)
  const [restorePoint, setRestorePoint] = useState(false)
  const [checkingRestorePoint, setCheckingRestorePoint] = useState(true)
  const assistantSaving = useAssistant((state) => Object.values(state.saving).some((value) => value > 0))
  const portableAvailable = !!window.grok?.backup
  useEffect(() => {
    if (!portableAvailable) { setCheckingRestorePoint(false); return }
    let active = true
    setCheckingRestorePoint(true)
    void hasPortableRestorePoint().then((available) => { if (active) setRestorePoint(available) })
      .catch((cause) => { if (active) setError(portableErrorMessage(cause)) })
      .finally(() => { if (active) setCheckingRestorePoint(false) })
    return () => { active = false }
  }, [portableAvailable, portable])
  const { runs, teams, taskSchedules, storageError, previousWorkspaceBackup, restoreWorkspaceBackup } = useCollaboration()
  const running = Object.values(runs).some((run) => isActive(run.status)) ||
    Object.values(taskSchedules).some((schedule) => schedule.status === 'running') ||
    teams.some((team) => team.messages.some((message) => message.status && isActive(message.status)))
  const choose = async (file?: File) => {
    setCandidate(null); setConfirmed(false); setNotice(''); setError('')
    if (!file) return
    setReading(true)
    try {
      if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MiB。')
      const text = await file.text()
      setCandidate({ text, state: parseWorkspaceBackup(text), name: file.name })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取备份文件。') }
    finally { setReading(false) }
  }
  return <section className="settings-section" aria-label="工作区数据">
    <div className="settings-section-title"><Download size={17} />工作区数据</div>
    <div className="settings-card workspace-data-settings">
      <p className="settings-field-hint" role="status">{storageError ? '存在尚未保存的修改' : storage.pending ? '正在保存修改…' : '工作区已保存到本机'}</p>
      <p className="portable-data-description">便携 ZIP 备份包含工作区、助手身份、记忆、提醒，以及可读取的引用附件和图片。
        导出前可预览内容与缺失文件；不会自动打包项目源码或账号凭据。消息可能含敏感信息，请妥善保管。</p>
      <div className="workspace-data-actions">
        <button type="button" className="primary" disabled={!portableAvailable || !!portable || running || reading || assistantSaving} onClick={() => { setNotice(''); setError(''); setPortable('export') }}><Download size={14} />导出便携 ZIP</button>
        <button type="button" className="secondary" disabled={!portableAvailable || !!portable || running || reading || assistantSaving} onClick={() => { setNotice(''); setError(''); setPortable('import') }}><Upload size={14} />选择便携备份并预览</button>
        {restorePoint && <button type="button" className="secondary" disabled={!!portable || checkingRestorePoint || running || reading || assistantSaving} onClick={() => { setNotice(''); setError(''); setPortable('rollback') }}>回退到替换前的工作区</button>}
      </div>
      {!portableAvailable && <p className="settings-field-hint">便携备份需使用桌面应用；当前可使用下方紧急 JSON 备份。</p>}
      {assistantSaving && <p className="settings-field-hint" role="status">正在保存助手资料，请等待完成后操作便携备份。</p>}
      {running && <p className="settings-field-hint" role="status">执行结束或停止后才能操作便携备份；下方紧急 JSON 仍可导出当前工作区。</p>}
      {restorePoint && <p className="settings-field-hint">本机保留最近一次替换前的完整回退点，重启后仍可使用；普通编辑不会覆盖它。</p>}
      <div className="portable-data-emergency"><h4>兼容与紧急 JSON 备份</h4>
      <p className="settings-field-hint">备份包含当前内存中的项目、会话、任务、文本成果和草稿，保存失败时也可导出。
        不含服务商登录凭据、附件与图片原文件、主助手的独立记忆存储；消息中粘贴的内容会保留。附件路径换机后可能不可用。支持不超过 20 MiB 的 JSON 备份。</p>
      <div className="workspace-data-actions">
        <WorkspaceExportButton />
        <button type="button" className="secondary" disabled={running || reading} onClick={() => input.current?.click()}>
          <Upload size={14} />{reading ? '读取备份…' : '选择备份文件'}</button>
        <input ref={input} type="file" accept="application/json,.json" aria-label="导入工作区备份文件" hidden
          onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
      </div>
      {running && <p className="settings-field-hint" role="status">执行结束或停止后才能恢复备份。导出仍然可用。</p>}
      {candidate && <div className="workspace-data-confirm">
        <strong>{candidate.name}</strong>
        <p>{candidate.state.teams.filter((team) => team.kind === 'project').length} 个项目 · {candidate.state.teams.filter((team) => team.kind === 'conversation').length} 个会话 · {candidate.state.teams.reduce((count, team) => count + team.messages.length, 0)} 条消息</p>
        <p>恢复会替换本地工作区。所有执行保持停止，任务计划清空，工具权限恢复为逐次询问，不会自动发送请求。
          替换前的工作区将保留在本次打开期间，可下载备份。</p>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认用此备份替换本地工作区</label>
        <div className="workspace-data-actions">
          <button type="button" className="secondary" onClick={() => { setCandidate(null); setConfirmed(false) }}>取消导入</button>
          <button type="button" className="primary" disabled={!confirmed || running || reading} onClick={async () => {
            setReading(true)
            try {
              restoreWorkspaceBackup(candidate.text); setCandidate(null); setConfirmed(false); setError('')
              setNotice('工作区已恢复到当前窗口，正在保存。请下载替换前的备份以便回退。')
              await flushWorkspaceStorage()
              setNotice('工作区已恢复并保存。请下载替换前的备份以便回退。')
            } catch (cause) { setNotice(''); setError(cause instanceof Error ? cause.message : '恢复失败。') }
            finally { setReading(false) }
          }}>确认替换并恢复</button>
        </div>
      </div>}
      {previousWorkspaceBackup && <div className="workspace-data-actions">
        <button type="button" className="secondary" onClick={() => {
          try { downloadWorkspaceBackup(previousWorkspaceBackup, 'workspace-before-restore') }
          catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败。') }
        }}>下载替换前的备份</button><span className="settings-field-hint">关闭应用前请保存；下次恢复会替换此回退快照。</span>
      </div>}
      </div>
      {notice && <p role="status">{notice}</p>}
      {storageError && <p className="settings-error" role="alert">本机保存失败，当前工作区仅保留在内存中。请先导出备份。<button type="button" className="text-button" onClick={() => useCollaboration.getState().retryStorage()}>重试保存</button></p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
    {portable && <PortableBackupDialog mode={portable} close={() => setPortable(null)} completed={(message) => { setNotice(message); setPortable(null) }} />}
  </section>
}
