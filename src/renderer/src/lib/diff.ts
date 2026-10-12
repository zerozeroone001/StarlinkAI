import type { DiffHunk } from '@shared/types'

export function parseDiff(raw?: string): DiffHunk[] {
  if (!raw) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) {
      if (line.startsWith('diff ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
        continue
      }
      current = { header: '', lines: [] }
      hunks.push(current)
    }
    if (line.startsWith('+')) current.lines.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ type: 'del', text: line.slice(1) })
    else current.lines.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  return hunks.filter((h) => h.lines.length)
}
