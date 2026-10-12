import { parseDiff } from '@/lib/diff'
import { useT } from '@/lib/i18n'

export function DiffView({ raw }: { raw?: string }) {
  const t = useT()
  const hunks = parseDiff(raw)
  if (!hunks.length) {
    return <div style={{ color: 'var(--text-3)', padding: 16, fontSize: 13 }}>{t('pane.noDiff')}</div>
  }
  return (
    <div className="diff">
      {hunks.map((hunk, i) => (
        <div key={i}>
          {hunk.header ? <div className="hunk">{hunk.header}</div> : null}
          {hunk.lines.map((line, j) => (
            <div key={j} className={`line ${line.type}`}>
              {(line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ') + line.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
