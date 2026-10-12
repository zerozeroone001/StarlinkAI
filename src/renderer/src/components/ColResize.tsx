import { useRef } from 'react'

export function ColResize({
  value,
  onChange,
  invert,
  disabled
}: {
  value: number
  onChange: (width: number) => void
  invert?: boolean
  disabled?: boolean
}) {
  const dragging = useRef(false)
  const origin = useRef({ x: 0, w: 0 })

  if (disabled) return null

  return (
    <div
      className={'col-resize' + (invert ? ' west' : ' east')}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        origin.current = { x: e.clientX, w: value }
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.classList.add('on')
        document.body.classList.add('col-resizing')
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const dx = e.clientX - origin.current.x
        onChange(origin.current.w + (invert ? -dx : dx))
      }}
      onPointerUp={(e) => {
        dragging.current = false
        e.currentTarget.classList.remove('on')
        document.body.classList.remove('col-resizing')
      }}
      onPointerCancel={(e) => {
        dragging.current = false
        e.currentTarget.classList.remove('on')
        document.body.classList.remove('col-resizing')
      }}
    />
  )
}
