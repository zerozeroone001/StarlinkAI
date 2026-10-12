import { memo, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Markdown } from './Markdown'

// Keep animation state inside the reply: frames never update/persist the workspace.
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text, streaming, ...props
}: ComponentProps<typeof Markdown> & { streaming: boolean }) {
  const [visible, setVisible] = useState(streaming ? '' : text)
  const displayed = useRef(visible)
  useEffect(() => {
    const show = (value: string) => { displayed.current = value; setVisible(value) }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!streaming || !text.startsWith(displayed.current) || reducedMotion.matches || document.hidden) {
      show(text)
      return
    }
    const start = displayed.current.length
    if (start === text.length) return
    let frame = 0
    let lastPaint = 0
    const started = performance.now()
    const paint = (now: number) => {
      // At most 30 Markdown renders/second, catching up within one polling interval.
      if (now - lastPaint >= 32 || now - started >= 120) {
        let end = Math.min(text.length, start + Math.ceil((text.length - start) * (now - started) / 120))
        // Never split a surrogate pair (emoji and supplementary characters).
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++
        show(text.slice(0, end))
        lastPaint = now
      }
      if (displayed.current.length < text.length) frame = requestAnimationFrame(paint)
    }
    const flush = () => { cancelAnimationFrame(frame); show(text) }
    document.addEventListener('visibilitychange', flush)
    reducedMotion.addEventListener('change', flush)
    frame = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', flush)
      reducedMotion.removeEventListener('change', flush)
    }
  }, [text, streaming])
  // Completion, cancellation and replacement expose the authoritative reply immediately.
  const body = !streaming || !text.startsWith(visible) ? text : visible
  return <Markdown {...props} text={body || (streaming && !props.images?.length ? '正在思考…' : '')} />
})
