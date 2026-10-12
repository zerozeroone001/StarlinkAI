import type { ContextRecord, ContextReport, RunRequest } from './runtime'

// This is a host budget, not a claim about any provider's tokenizer/window size.
export const INPUT_CHARACTER_BUDGET = 96000
export const INPUT_TOKEN_ESTIMATE_BUDGET = 40000
export function estimateTokens(text: string): number {
  let ascii = 0, unicode = 0
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii++
    else unicode++
  }
  return Math.ceil(ascii / 3) + unicode * 2
}

const important = /约束|必须|禁止|不要|不能|验收|决定|决策|失败|错误|测试|风险|接口|文件|路径|require|must|never|decision|acceptance|fail|error|test|contract|constraint|\.\w{1,5}\b/i

// Extract verbatim spans; never manufacture a semantic summary or cut off only the tail.
export function excerptText(text: string, limit: number): string {
  if (text.length <= limit) return text
  if (limit < 100) return text.slice(0, Math.max(0, limit - 1)) + '…'
  const head = Math.floor((limit - 80) * 0.3)
  const tail = Math.floor((limit - 80) * 0.3)
  const middleBudget = limit - head - tail - 80
  const middle = text.slice(head, text.length - tail)
  const selected: string[] = []
  let remaining = middleBudget
  for (const line of middle.split(/\r?\n/)) {
    if (!important.test(line) || !line.trim() || remaining < 20) continue
    const part = line.length <= remaining ? line : line.slice(0, Math.min(remaining, 400)) + '…'
    selected.push(part)
    remaining -= part.length + 1
  }
  return [text.slice(0, head), '…[中间原文已压缩；以下为原文摘录]…', ...selected,
    '…[后文摘录]…', text.slice(-tail)].join('\n').slice(0, limit)
}

function fitRecord<T extends { text: string }>(record: T, budget: number): T | null {
  if (JSON.stringify(record).length <= budget) return record
  if (JSON.stringify({ ...record, text: '', compressed: true }).length + 80 > budget) return null
  let low = 0, high = Math.min(record.text.length, budget), best: T | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const value = { ...record, text: excerptText(record.text, mid), compressed: true }
    if (JSON.stringify(value).length <= budget) { best = value; low = mid + 1 }
    else high = mid - 1
  }
  return best
}

export function compactContext(records: ContextRecord[], sources: RunRequest['artifacts'], budget = 60000) {
  budget = Math.max(512, Math.floor(budget))
  const original = { history: records, artifacts: sources }
  if (JSON.stringify(original).length <= budget) return {
    ...original,
    report: { messages: records.length, included: records.length, compressed: records.filter((r) => r.compressed).length,
      omitted: 0, artifactsOmitted: 0 } satisfies ContextReport
  }
  let remaining = budget - JSON.stringify({ history: [], artifacts: [] }).length - 32
  const artifacts: RunRequest['artifacts'] = []
  const selected = new Map<number, ContextRecord>()
  // Task/acceptance metadata comes first in sources and cannot be starved by a long reply.
  let artifactBudget = Math.min(16000, Math.floor(remaining * (records.length ? 0.25 : 0.9)))
  let artifactsOmitted = 0
  let artifactsCompressed = 0
  for (const artifact of sources) {
    const value = fitRecord({ name: artifact.name, text: artifact.content }, Math.min(artifactBudget, 9000))
    if (!value) { artifactsOmitted++; continue }
    const { text, ...meta } = value
    const item = { ...meta, content: text }
    const size = JSON.stringify(item).length + 1
    if (size > artifactBudget) { artifactsOmitted++; continue }
    if (text !== artifact.content) artifactsCompressed++
    artifacts.push(item)
    artifactBudget -= size
    remaining -= size
  }
  const add = (index: number, allowance: number) => {
    const value = fitRecord(records[index], Math.min(allowance, remaining - 1))
    if (!value) return false
    selected.set(index, value)
    remaining -= JSON.stringify(value).length + 1
    return true
  }
  // Reserve room for earlier constraints; a single huge recent message must not erase history.
  const recentBudget = Math.floor(remaining * 0.65)
  let recentUsed = 0
  for (let index = records.length - 1; index >= Math.max(0, records.length - 12); index--) {
    const before = remaining
    if (!add(index, Math.min(12000, recentBudget - recentUsed))) break
    recentUsed += before - remaining
  }
  const older = records.map((_, index) => index).filter((index) => !selected.has(index))
  older.sort((a, b) => {
    const rank = (record: ContextRecord) => record.kind === 'decision' ? 3
      : record.authorId === 'you' || record.author === '用户' ? 2 : important.test(record.text) ? 1 : 0
    return rank(records[b]) - rank(records[a]) || b - a
  })
  for (const index of older) {
    if (!add(index, Math.min(1200, remaining))) break
  }
  const history = [...selected.entries()].sort(([a], [b]) => a - b).map(([, record]) => record)
  const report: ContextReport = {
    messages: records.length, included: history.length,
    compressed: history.filter((record) => record.compressed).length,
    omitted: records.length - history.length, artifactsOmitted: artifactsOmitted + artifactsCompressed
  }
  return { history, artifacts, report }
}
