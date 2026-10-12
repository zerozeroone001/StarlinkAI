import type { ChatImage } from './types'

const MEDIA_LINK_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#].*)?$/i
const ABS_PATH =
  /(?<![A-Za-z0-9_.-])(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\/|\\\\)[^\r\n"'<>|?*]*?\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?=$|[\s.,;:)"'\]])/gi
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^)\n]+)\)/g

function markdownTarget(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('<')) {
    const end = value.indexOf('>')
    if (end > 0) return value.slice(1, end).trim()
  }
  const titled = value.match(/^(.*?)(?:\s+["'][^"']*["'])$/)
  return (titled?.[1] || value).trim()
}

export function isMediaSource(value?: string | null): boolean {
  if (!value) return false
  const src = markdownTarget(value)
  return /^data:image\//i.test(src) || MEDIA_LINK_EXT.test(src)
}

function mediaItem(src: string, alt?: string, explicitImage = false): ChatImage | null {
  const clean = markdownTarget(src)
  if (!isMediaSource(clean) && !(explicitImage && /^(https?:\/\/|blob:|file:)/i.test(clean))) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(clean) && !/^(https?:|data:image\/|blob:|file:|[a-z]:[\\/])/i.test(clean)) return null
  if (/^data:image\//i.test(clean)) return { dataUrl: clean, alt }
  return { path: clean.replace(/^\\\\\?\\/, ''), alt }
}

export function isMediaTool(name?: string, title?: string, kind?: string): boolean {
  const s = `${name || ''} ${title || ''} ${kind || ''}`
  return /image_gen|image_edit|imagine|video_gen|image_to_video|reference_to_video/i.test(s)
}

export function unwrapText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(unwrapText).filter(Boolean).join('\n')
  const rec = value as Record<string, unknown>
  if (typeof rec.text === 'string') return rec.text
  if (rec.content) return unwrapText(rec.content)
  return ''
}

function pushUnique(out: ChatImage[], next: ChatImage): void {
  const key = next.dataUrl || next.path || ''
  if (!key) return
  if (out.some((item) => (item.dataUrl || item.path) === key)) return
  out.push(next)
}

export function extractMediaFromText(text: string): ChatImage[] {
  if (!text) return []
  const out: ChatImage[] = []
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const images = extractMediaFromContent(parsed)
      if (images.length) return images
    }
  } catch {
    /* not json */
  }
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const item = mediaItem(m[3], m[2], !!m[1])
    if (item) pushUnique(out, item)
  }
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const item = mediaItem(m[1], undefined, true)
    if (item) pushUnique(out, item)
  }
  const plain = text.replace(MARKDOWN_LINK, '').replace(/<img[^>]*>/gi, '')
  for (const m of plain.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    const item = mediaItem(m[0])
    if (item) pushUnique(out, item)
  }
  const paths = plain.replace(/https?:\/\/[^\s<>"')]+/gi, '')
  for (const m of paths.matchAll(ABS_PATH)) {
    pushUnique(out, { path: m[0].replace(/^\\\\\?\\/, '') })
  }
  for (const m of text.matchAll(/(?:^|[\s("'=])((?:\.\.?\/)?(?:images|videos|assets)\/[^\s)"']+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#][^\s)"']*)?)/gi)) {
    pushUnique(out, { path: m[1] })
  }
  return out
}

export function stripDisplayedMedia(text: string): string {
  if (!text) return ''
  return text
    .replace(MARKDOWN_LINK, (whole, bang: string, alt: string, target: string) =>
      mediaItem(target, alt, !!bang) ? '' : whole
    )
    .replace(/<img[^>]+src=["'][^"']+["'][^>]*>/gi, '')
    .replace(/^\s*\{[^{}]*"path"\s*:\s*"[^"]+"[^{}]*\}\s*$/gm, '')
    .replace(/^\s*Image (?:generated|edited) and saved to .+$/gim, '')
    .replace(/(?:^|\n)\s*(?:\.\.?\/)?(?:images|videos|assets)\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#][^\s)]*)?\s*(?=\n|$)/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractMediaFromContent(content: unknown): ChatImage[] {
  const out: ChatImage[] = []
  const walk = (value: unknown) => {
    if (!value) return
    if (typeof value === 'string') {
      for (const img of extractMediaFromText(value)) pushUnique(out, img)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object') return
    const rec = value as Record<string, unknown>
    // Only inspect output containers, never tool arguments or unrelated metadata.
    if (['tool_use', 'userMessage', 'reasoning', 'imageView'].includes(String(rec.type)) || rec.is_error === true || rec.success === false || ['failed', 'in_progress'].includes(String(rec.status))) return
    const mime = typeof rec.mimeType === 'string' ? rec.mimeType
      : typeof rec.mime_type === 'string' ? rec.mime_type
      : typeof rec.media_type === 'string' ? rec.media_type : ''
    const encoded = typeof rec.b64_json === 'string' ? rec.b64_json
      : /^image\//.test(mime) && typeof rec.blob === 'string' ? rec.blob
      : /^image\//.test(mime) && typeof rec.data === 'string' ? rec.data : ''
    if (encoded) pushUnique(out, { dataUrl: `data:${mime || 'image/png'};base64,${encoded}` })
    if ((rec.type === 'imageGeneration' || rec.type === 'image_generation_call') && typeof rec.result === 'string') {
      const result = rec.result
      if (/^(data:|https?:|file:)/i.test(result) || isMediaSource(result)) {
        const item = mediaItem(result, undefined, true)
        if (item) pushUnique(out, item)
      } else if (/^[A-Za-z0-9+/=\r\n]+$/.test(result)) {
        pushUnique(out, { dataUrl: `data:image/png;base64,${result}` })
      }
    }
    if (rec.type === 'image' && typeof rec.data === 'string') {
      const mime = typeof rec.mimeType === 'string' ? rec.mimeType : 'image/png'
      pushUnique(out, { dataUrl: `data:${mime};base64,${rec.data}` })
      return
    }
    if (rec.type === 'image' && typeof rec.url === 'string') {
      const item = mediaItem(rec.url, undefined, true)
      if (item) pushUnique(out, item)
      return
    }
    for (const key of ['content', 'contentItems', 'source', 'resource', 'inlineData', 'inline_data', 'fileData', 'file_data', 'parts', 'candidates', 'data', 'images', 'output', 'result', 'rawOutput', 'structuredContent']) {
      if (rec[key] && typeof rec[key] === 'object') walk(rec[key])
    }
    if (typeof rec.text === 'string') walk(rec.text)
    if (typeof rec.aggregatedOutput === 'string') walk(rec.aggregatedOutput)
    if (typeof rec.output === 'string') walk(rec.output)
    const src = [rec.savedPath, rec.path, rec.url, rec.uri, rec.fileUri, rec.file_uri, rec.image_url, rec.imageUrl, rec.dataUrl].find((s) => typeof s === 'string') as string || ''
    const item = mediaItem(src, typeof rec.filename === 'string' ? rec.filename : undefined, /^image\//.test(mime) || !!rec.image_url || !!rec.imageUrl || !!rec.b64_json || ['image_url', 'url'].includes(String(rec.type)))
    if (item) pushUnique(out, item)
    if (rec.image_url && typeof rec.image_url === 'object') {
      const url = (rec.image_url as { url?: string }).url
      if (url) { const image = mediaItem(url, undefined, true); if (image) pushUnique(out, image) }
    }
  }
  walk(content)
  return out
}
