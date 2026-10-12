import { extractMediaFromText } from '@shared/media'
import type { ChatImage } from '@shared/types'
import type { RunSnapshot } from '@shared/runtime'
import type { Provider, Team } from './collaboration-data'
import { runtimeClient } from './runtime-client'

export interface GalleryImage {
  id: string
  keys: string[]
  image: ChatImage
  workspaceId: string
  assetScopeId?: string
  workspaceName: string
  isGallery?: boolean
  prompt: string
  provider: Provider
  cwd?: string
  sessionId?: string
  createdAt: string
}

export interface GalleryGroup {
  id: string
  workspaceId: string
  prompt: string
  createdAt: string
  images: GalleryImage[]
}

// Keep a conversation's results together without merging identical prompts from other conversations.
export function groupGalleryImages(images: GalleryImage[]): GalleryGroup[] {
  const groups = new Map<string, GalleryGroup>()
  for (const image of images) {
    const id = JSON.stringify([image.workspaceId, image.prompt])
    let group = groups.get(id)
    if (!group) {
      group = { id, workspaceId: image.workspaceId, prompt: image.prompt, createdAt: image.createdAt, images: [] }
      groups.set(id, group)
    }
    group.images.push(image)
  }
  return [...groups.values()]
}

function imageKeys(image: ChatImage, workspaceId: string, cwd?: string): string[] {
  return [image.dataUrl, image.path, image.sourcePath].filter((value): value is string => !!value).map((value) => {
    if (/^(?:https?:|data:|blob:)/i.test(value)) return value
    let normalized = value.replace(/^file:\/\//i, '').replace(/\\/g, '/')
    if (!/^(?:[a-z]:\/|\/)/i.test(normalized)) normalized = `${cwd || workspaceId}/${normalized}`
    const parts: string[] = []
    for (const part of normalized.split('/')) {
      if (part === '.') continue
      if (part === '..' && parts.length > 1) parts.pop()
      else parts.push(part)
    }
    normalized = parts.join('/')
    // Runtime copies use a SHA-256 filename, so the same bytes in two workspaces
    // still represent one gallery image.
    const hashFile = normalized.match(/\/images\/([a-f\d]{64})\.[a-z\d]+$/i)
    if (hashFile) return `sha256:${hashFile[1].toLowerCase()}`
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
  })
}

export async function galleryImageData(item: GalleryImage): Promise<string> {
  const source = item.image.dataUrl || item.image.path
  if (!source) throw new Error('图片来源不存在。')
  if (source.startsWith('data:')) return source
  if (/^(https?:|blob:)/i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error('无法读取原图，请检查图片链接。')
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('原图读取失败。'))
      reader.readAsDataURL(blob)
    })
  }
  const preview = await runtimeClient.media(item.assetScopeId || item.workspaceId, source, item.cwd)
  if (!preview.dataUrl) throw new Error('原图无法读取，可能已被移动或删除。')
  return preview.dataUrl
}

export function collectGalleryImages(teams: Team[], runs: Record<string, RunSnapshot> = {}, deletedKeys: string[] = []): GalleryImage[] {
  const result: GalleryImage[] = []
  // Saved images and their original paths can reappear in later replies or retries.
  const aliases = new Map<string, string>()
  const resolve = (key: string): string => {
    const trail: string[] = []
    let root = key
    while (aliases.has(root) && aliases.get(root) !== root) {
      trail.push(root)
      root = aliases.get(root)!
    }
    for (const alias of trail) aliases.set(alias, root)
    return root
  }
  for (const team of teams) {
    if (team.sample) continue
    for (const message of team.messages) {
      if (message.sample || message.author === 'you' || message.author === 'system') continue
      for (const image of message.images || []) {
        const keys = imageKeys(image, team.id, message.cwd)
        const canonical = keys[0] && resolve(keys[0])
        if (canonical) for (const key of keys) aliases.set(resolve(key), canonical)
      }
    }
  }
  const seen = new Set<string>()
  const deleted = new Set(deletedKeys.map(resolve))
  const aliasGroups = new Map<string, string[]>()
  for (const alias of aliases.keys()) {
    const key = resolve(alias)
    const group = aliasGroups.get(key) || []
    group.push(alias); aliasGroups.set(key, group)
  }
  for (const team of [...teams].reverse()) {
    if (team.sample) continue
    for (const message of [...team.messages].reverse()) {
      if (message.sample || message.author === 'you' || message.author === 'system') continue
      const source = team.messages.find((m) => m.author === 'you' &&
        (message.sourceMessageId ? m.id === message.sourceMessageId : !!message.runId && m.runId === message.runId))
      const images = message.images || []
      const extracted = extractMediaFromText(message.text).filter((image) => !images.some((saved) =>
        (!!image.path && (saved.sourcePath === image.path || saved.path === image.path)) ||
        (!!image.dataUrl && saved.dataUrl === image.dataUrl) ||
        (!!image.path && !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(image.path) &&
          saved.sourcePath?.replace(/\\/g, '/').endsWith('/' + image.path.replace(/\\/g, '/')))))
      for (const [index, image] of [...images, ...extracted].entries()) {
        const keys = imageKeys(image, team.id, message.cwd)
        const key = keys[0] && resolve(keys[0])
        if (!key || seen.has(key) || deleted.has(key)) continue
        seen.add(key)
        result.push({
          id: `${team.id}:${message.id}:${index}`, image,
          keys: [...new Set([key, ...keys, ...(aliasGroups.get(key) || [])])],
          workspaceId: team.id, assetScopeId: team.parentId || team.id, workspaceName: team.name, isGallery: !!team.gallery,
          prompt: team.gallery?.prompt || source?.text || image.alt || team.name,
          provider: message.provider || team.members.find((m) => m.id === message.author)?.provider || team.defaultProvider,
          cwd: message.cwd, sessionId: message.sessionId,
          createdAt: (message.runId ? runs[message.runId]?.createdAt : '') || team.gallery?.createdAt || ''
        })
      }
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
