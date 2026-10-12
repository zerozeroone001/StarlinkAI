import type { KeyboardEvent } from 'react'

// Ctrl+Enter does not insert a newline natively in Chromium textareas.
export function handleComposerEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  update: (value: string) => void,
  submit: () => void
): boolean {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart, end = input.selectionEnd
    const next = input.value.slice(0, start) + '\n' + input.value.slice(end)
    if (input.maxLength >= 0 && next.length > input.maxLength) return true
    update(next)
    requestAnimationFrame(() => {
      if (input.isConnected) input.setSelectionRange(start + 1, start + 1)
    })
    return true
  }
  // Keep native Shift+Enter/Alt+Enter behavior for existing multiline users.
  if (event.shiftKey || event.altKey) return false
  event.preventDefault()
  if (!event.repeat) submit()
  return true
}
