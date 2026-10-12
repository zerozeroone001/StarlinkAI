import { MAX_ATTACHMENT_BYTES, isAvatar } from '@shared/attachments'

export function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'))
    reader.onabort = () => reject(new Error('文件读取已取消。'))
    reader.readAsDataURL(file)
  })
}
export async function avatarFromFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('头像请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('头像图片不能超过 8 MB。')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 192
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理头像图片，请重试。')
    const size = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 192, 192)
    const result = canvas.toDataURL('image/webp', 0.85)
    if (!isAvatar(result)) throw new Error('头像图片处理失败，请选择其他图片。')
    return result
  } finally { URL.revokeObjectURL(url) }
}
