import { FileText, X } from 'lucide-react'
import type { WorkspaceAttachment } from '@shared/attachments'
import { ResolvedImage } from './Markdown'

export function AttachmentList({ files, workspaceId, remove }: {
  files: WorkspaceAttachment[]; workspaceId: string; remove?: (id: string) => void
}) {
  if (!files.length) return null
  return <div className="workspace-attachments" aria-label={remove ? '待发送附件' : '消息附件'}>
    {files.map((file) => <div className={`workspace-attachment${file.mime.startsWith('image/') ? ' is-image' : ''}`} key={file.id}>
      {file.mime.startsWith('image/')
        ? <ResolvedImage src={file.path} alt={file.name} workspaceId={workspaceId} className="attachment-thumbnail" showActions={false} />
        : <FileText size={24} aria-hidden="true" />}
      <span title={file.name}><strong>{file.name}</strong><small>{file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></span>
      {remove && <button type="button" className="attachment-remove icon-btn" aria-label={`移除附件 ${file.name}`} onClick={() => remove(file.id)}><X size={13} /></button>}
    </div>)}
  </div>
}
