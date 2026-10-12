import type { ProviderId } from '../../shared/types'
import type { WorkReceipt } from '../../shared/runtime'

type ToolUpdate = Record<string, any>
export function mergeAcpToolUpdate(previous: ToolUpdate | undefined, update: ToolUpdate): ToolUpdate {
  // ACP updates are partial. Null rawInput/rawOutput/name means no update.
  return { ...previous, ...Object.fromEntries(Object.entries(update).filter(([key, value]) =>
    value !== undefined && !(value === null && ['rawInput', 'rawOutput', 'name'].includes(key)))) }
}

function acpReceipt(output: ToolUpdate, provider: ProviderId): WorkReceipt | undefined {
  const args = output.rawInput && typeof output.rawInput === 'object' && !Array.isArray(output.rawInput) ? output.rawInput : {}
  const name = [output.name, args.name, output.title].find((value) => typeof value === 'string') || ''
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  const command = [args.command, args.cmd, args.CommandLine].find(text) ||
    // The bundled Gemini CLI's ShellToolInvocation.getDisplayTitle returns the
    // exact command, including on permissions that omit rawInput entirely.
    (provider === 'gemini' && output.kind === 'execute' && text(output.title) ? output.title : undefined)
  if (command) {
    const rawCode = output.rawOutput?.exitCode ?? output.rawOutput?.exit_code
    return { commands: [{ command: command.slice(0, 300),
      ...(Number.isInteger(rawCode) ? { exitCode: rawCode } : {}) }] }
  }
  const files = [...new Set([
    args.file_path, args.path, args.targetFile, args.file, args.filename,
    ...(Array.isArray(output.locations) ? output.locations.map((location: any) => location?.path) : []),
    ...(Array.isArray(output.content) ? output.content.filter((entry: any) => entry?.type === 'diff').map((entry: any) => entry.path) : [])
  ].filter((value): value is string => text(value) && value.length <= 32768))].slice(0, 40)
  if (!files.length) return undefined
  if (['edit', 'delete', 'move'].includes(output.kind) || /write|edit|replace|create|patch|save|delete|remove/i.test(name))
    return { filesModified: files }
  if (output.kind === 'read' || /read|view|cat|open|inspect/i.test(name)) return { filesRead: files }
  return undefined
}

export function createAcpToolTrace(provider: ProviderId,
  report: ((receipt: WorkReceipt) => void) | undefined,
  media: ((value: unknown) => void) | undefined
) {
  const pending = new Map<string, ToolUpdate>()
  const settled = new Set<string>()
  const update = (value: unknown, permissionOnly = false) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const patch = value as ToolUpdate
    const id = patch.toolCallId
    if (typeof id !== 'string' || !id || id.length > 500 || settled.has(id)) return
    const output = mergeAcpToolUpdate(pending.get(id), patch)
    if (!permissionOnly && (output.status === 'completed' || output.status === 'failed')) {
      pending.delete(id)
      if (settled.size >= 1000) settled.delete(settled.values().next().value!)
      settled.add(id)
      if (output.status === 'completed') {
        const receipt = acpReceipt(output, provider)
        if (receipt) report?.(receipt)
        media?.(output.content)
        media?.(output.rawOutput)
      } else {
        const commands = acpReceipt(output, provider)?.commands?.filter((entry) => Number.isInteger(entry.exitCode))
        if (commands?.length) report?.({ commands })
      }
    } else {
      if (!pending.has(id) && pending.size >= 100) pending.delete(pending.keys().next().value!)
      pending.set(id, output)
    }
  }
  return { update: (value: unknown) => update(value), permission: (value: unknown) => update(value, true) }
}
