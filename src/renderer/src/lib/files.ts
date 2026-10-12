const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  const i = base.lastIndexOf('.')
  if (i <= 0) return base.replace(/^\./, '').toLowerCase()
  return base.slice(i + 1).toLowerCase()
}

export function isImagePath(name: string): boolean {
  return IMAGE_EXT.has(extOf(name))
}

export function isImageAttachment(value: {
  name?: string
  path?: string
  mime?: string
  dataUrl?: string
}): boolean {
  return (
    /^image\//i.test(value.mime || '') ||
    /^data:image\//i.test(value.dataUrl || '') ||
    isImagePath(value.name || value.path || '')
  )
}

export function joinPath(cwd: string, rel: string): string {
  if (!rel) return cwd
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/') || rel.startsWith('\\\\')) return rel
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]/g, sep)
}

export function isAddress(value?: string | null): boolean {
  if (!value) return false
  const s = value.trim()
  return (
    /^(https?:|data:|file:|blob:)/i.test(s) ||
    /^[a-zA-Z]:[\\/]/.test(s) ||
    s.startsWith('\\\\') ||
    s.startsWith('/') ||
    s.includes('\\')
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
