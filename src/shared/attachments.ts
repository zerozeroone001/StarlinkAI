export interface WorkspaceAttachment {
  id: string
  name: string
  path: string
  size: number
  mime: string
}
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENTS = 5
export function isWorkspaceAttachment(value: unknown): value is WorkspaceAttachment {
  const a = value as WorkspaceAttachment | null
  return !!a && typeof a.id === 'string' && /^[\w-]{1,100}$/.test(a.id) &&
    typeof a.name === 'string' && a.name.length > 0 && a.name.length <= 200 &&
    typeof a.path === 'string' && a.path.length <= 4096 &&
    Number.isInteger(a.size) && a.size >= 0 && a.size <= MAX_ATTACHMENT_BYTES &&
    typeof a.mime === 'string' && a.mime.length <= 100
}
export function isAvatar(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200000 &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}
