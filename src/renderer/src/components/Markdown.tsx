import { memo, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { extractMediaFromText, isMediaSource, stripDisplayedMedia } from '@shared/media'
import { imageReplyBody } from '@shared/reply-display'
import type { ChatImage } from '@shared/types'
import { isAddress } from '@/lib/files'
import { useT } from '@/lib/i18n'
import { ImageZoom } from './ImageZoom'
import { runtimeClient } from '@/lib/runtime-client'
import { useCollaboration } from '@/stores/collaboration'
import { teamDirectory } from '@/lib/collaboration-data'

const schema = {
  ...defaultSchema,
  protocols: {
    ...((defaultSchema as { protocols?: Record<string, string[]> }).protocols || {}),
    src: ['http', 'https', 'data', 'blob', 'file'],
    href: ['http', 'https', 'mailto']
  }
}

function mergeImages(...lists: Array<ChatImage[] | undefined>): ChatImage[] {
  const out: ChatImage[] = []
  for (const list of lists) {
    if (!list) continue
    for (const img of list) {
      const key = img.dataUrl || img.path || ''
      if (!key) continue
      const relative = !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(key)
      if (out.some((item) => (item.dataUrl || item.path) === key || item.sourcePath === key ||
        (relative && item.sourcePath?.replace(/\\/g, '/').endsWith('/' + key.replace(/\\/g, '/'))))) continue
      out.push(img)
    }
  }
  return out
}

export function ResolvedImage({
  src,
  alt,
  cwd,
  sessionId,
  workspaceId,
  className,
  showActions,
  userSelected = false
}: {
  src?: string
  alt?: string
  cwd?: string
  sessionId?: string
  workspaceId?: string
  className?: string
  showActions?: boolean
  userSelected?: boolean
}) {
  const t = useT()
  const directory = useCollaboration(s => teamDirectory(s.teams, workspaceId || ''))
  const assetScopeId = useCollaboration(s => s.teams.find(team => team.id === workspaceId)?.parentId || workspaceId)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!src) {
      setUrl(null)
      setFailed(false)
      return
    }
    setUrl(null)
    if (/^(data:|blob:|https?:)/i.test(src)) {
      setUrl(src)
      setFailed(false)
      return
    }
    if (!workspaceId && typeof window.grok?.previewFile !== 'function') {
      setFailed(true)
      return
    }
    let alive = true
    setFailed(false)
    // Workspace media uses the backend's directory resolver even when an
    // independent conversation has no visible folder. Model output never gets
    // the unrestricted preview intended for a file chosen by the user.
    const preview = workspaceId
      ? runtimeClient.media(assetScopeId || workspaceId, src, cwd || directory)
      : window.grok.previewFile(src, userSelected ? undefined : { cwd, sessionId })
    void preview
      .then((p) => {
        if (!alive) return
        if (p.dataUrl) setUrl(p.dataUrl)
        else setFailed(true)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [src, cwd, sessionId, workspaceId, assetScopeId, directory, userSelected])
  if (url) {
    return (
      <ImageZoom
        src={url}
        className={className}
        title={alt || t('image.zoomHint')}
        fileName={alt || src?.split(/[\\/]/).pop()}
        sourcePath={/^(data:|blob:|https?:)/i.test(src || '') ? undefined : src}
        cwd={cwd}
        sessionId={sessionId}
        showActions={showActions}
      />
    )
  }
  if (failed) return <div className="img-missing">{t('image.missing')}</div>
  return <div className="img-loading">{t('image.loading')}</div>
}

export function ChatImages({
  images,
  cwd,
  sessionId,
  workspaceId
}: {
  images?: ChatImage[]
  cwd?: string
  sessionId?: string
  workspaceId?: string
}) {
  if (!images?.length) return null
  return (
    <div className="chat-images">
      {images.map((img, i) => (
        <figure className="md-image" key={img.dataUrl || img.path || i}>
          {img.dataUrl ? (
            <ImageZoom
              src={img.dataUrl}
              title={img.alt || ''}
              fileName={img.alt || img.path?.split(/[\\/]/).pop()}
              sourcePath={img.path}
              cwd={cwd}
              sessionId={sessionId}
            />
          ) : (
            <ResolvedImage src={img.path} alt={img.alt} cwd={cwd} sessionId={sessionId} workspaceId={workspaceId} />
          )}
          {img.alt && !isAddress(img.alt) ? <figcaption className="md-image-cap">{img.alt}</figcaption> : null}
        </figure>
      ))}
    </div>
  )
}

export const Markdown = memo(function Markdown({
  text,
  images,
  cwd,
  sessionId,
  workspaceId
}: {
  text: string
  images?: ChatImage[]
  cwd?: string
  sessionId?: string
  workspaceId?: string
}) {
  const extracted = extractMediaFromText(text || '')
  const allImages = mergeImages(images, extracted)
  const body = imageReplyBody(stripDisplayedMedia(text || ''), allImages.length > 0)
  // Stable component types keep existing links and image previews mounted while text grows.
  const components = useMemo<Components>(() => ({
    img: ({ src, alt }) => (
      <ResolvedImage src={src} alt={alt} cwd={cwd} sessionId={sessionId} workspaceId={workspaceId} />
    ),
    a: ({ href, children }) => {
      if (href && isMediaSource(href)) {
        return <ResolvedImage src={href} alt={String(children || '')} cwd={cwd} sessionId={sessionId} workspaceId={workspaceId} />
      }
      if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>
      if (/^mailto:/i.test(href)) return <a href={href}>{children}</a>
      return (
        <a href={href} onClick={(event) => {
          event.preventDefault()
          if (/^https?:/i.test(href)) (window.grok?.openExternal ? void window.grok.openExternal(href) : window.open(href, '_blank', 'noopener,noreferrer'))
        }}>{children}</a>
      )
    }
  }), [cwd, sessionId, workspaceId])
  return (
    <div className="prose">
      {body ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, schema]]}
          components={components}
        >
          {body}
        </ReactMarkdown>
      ) : null}
      <ChatImages images={allImages} cwd={cwd} sessionId={sessionId} workspaceId={workspaceId} />
    </div>
  )
})
