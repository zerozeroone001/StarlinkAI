import { useState } from 'react'
import {
  Copy,
  ExternalLink,
  FileQuestion,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  X
} from 'lucide-react'
import type { FilePreview as Preview } from '@shared/types'
import { formatBytes } from '@/lib/files'
import { useT } from '@/lib/i18n'
import { ImageZoom } from './ImageZoom'
import { Markdown } from './Markdown'

function CopyBtn({ value }: { value: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      className="icon-btn"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setOk(true)
        setTimeout(() => setOk(false), 1200)
      }}
    >
      {ok ? <span style={{ fontSize: 10, color: 'var(--ok)' }}>OK</span> : <Copy size={13} />}
    </button>
  )
}

function CodeLines({ text }: { text: string }) {
  const lines = text.split(/\n/).slice(0, 800)
  const clipped = text.split(/\n/).length > 800
  return (
    <div className="preview-code">
      <div className="preview-gutter" aria-hidden>
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="preview-source">
        {lines.join('\n')}
        {clipped ? '\n…' : ''}
      </pre>
    </div>
  )
}

export function FilePreview({
  preview,
  onClose
}: {
  preview: Preview | null
  onClose?: () => void
}) {
  const t = useT()
  if (!preview) {
    return (
      <div className="preview-stage">
        <div className="preview-empty">
          <ImageIcon size={22} />
          <div>{t('files.select')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview-stage">
      <div className="preview-bar">
        <div className="preview-bar-icon">
          {preview.kind === 'image' ? (
            <ImageIcon size={14} />
          ) : preview.kind === 'video' ? (
            <Film size={14} />
          ) : preview.kind === 'audio' ? (
            <Music size={14} />
          ) : preview.kind === 'binary' || preview.kind === 'pdf' ? (
            <FileQuestion size={14} />
          ) : (
            <FileText size={14} />
          )}
        </div>
        <div className="preview-bar-meta">
          <div className="preview-name" title={preview.name}>
            {preview.name}
          </div>
          <div className="preview-sub">
            {preview.language || preview.ext.toUpperCase() || 'FILE'}
            <span>·</span>
            {formatBytes(preview.size)}
            {preview.truncated ? <span>· {t('files.truncated')}</span> : null}
          </div>
        </div>
        <CopyBtn value={preview.name} />
        <button className="icon-btn" title={t('files.open')} onClick={() => void window.grok.openPath(preview.path)}>
          <ExternalLink size={13} />
        </button>
        {onClose ? (
          <button className="icon-btn" title={t('files.close')} onClick={onClose}>
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="preview-body">
        {preview.error ? <div className="preview-fallback">{preview.error}</div> : null}

        {!preview.error && preview.kind === 'image' && preview.dataUrl ? (
          <ImageZoom src={preview.dataUrl} className="preview-media" />
        ) : null}

        {!preview.error && preview.kind === 'video' && preview.dataUrl ? (
          <div className="preview-media">
            <video src={preview.dataUrl} controls playsInline />
          </div>
        ) : null}

        {!preview.error && preview.kind === 'audio' && preview.dataUrl ? (
          <div className="preview-media audio">
            <audio src={preview.dataUrl} controls />
          </div>
        ) : null}

        {!preview.error && preview.kind === 'markdown' && preview.text ? (
          <div className="preview-md">
            <Markdown text={preview.text} />
          </div>
        ) : null}

        {!preview.error && (preview.kind === 'text' || preview.kind === 'json') && preview.text ? (
          <CodeLines text={preview.text} />
        ) : null}

        {!preview.error && (preview.kind === 'binary' || preview.kind === 'pdf') ? (
          <div className="preview-fallback">
            <FileQuestion size={28} />
            <div>{preview.kind === 'pdf' ? t('files.pdf') : t('files.binary')}</div>
            <div className="preview-sub">{formatBytes(preview.size)}</div>
            <button className="secondary" onClick={() => void window.grok.openPath(preview.path)}>
              {t('files.openSystem')}
            </button>
          </div>
        ) : null}
      </div>

    </div>
  )
}
