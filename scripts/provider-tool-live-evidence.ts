// The acceptance observer independently retains protocol deltas so a failed
// product receipt assertion cannot erase the evidence used to diagnose it.
export function createToolEvidence(sanitize: (value: string) => string) {
  const tools = new Map<string, { state: Record<string, any>; events: number; permissionObserved: boolean; nodeOutputMarker: boolean }>()
  const observe = (value: unknown, permission = false) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const patch = value as Record<string, any>
    if (typeof patch.toolCallId !== 'string' || patch.toolCallId.length > 500) return false
    const item = tools.get(patch.toolCallId) || { state: {}, events: 0, permissionObserved: false, nodeOutputMarker: false }
    if (!tools.has(patch.toolCallId) && tools.size >= 100) return false
    for (const [key, field] of Object.entries(patch)) {
      if (field === undefined || (field === null && ['name', 'rawInput', 'rawOutput'].includes(key))) continue
      item.state[key] = field
    }
    item.events++
    item.permissionObserved ||= permission
    if (!permission && patch.status === 'completed')
      item.nodeOutputMarker ||= JSON.stringify(patch.content || []).includes('LOCAL_NODE_OK')
    tools.set(patch.toolCallId, item)
    return true
  }
  return { observe, snapshot: () => [...tools.values()].map(({ state, events, permissionObserved, nodeOutputMarker }, index) => ({
    tool: index + 1, status: typeof state.status === 'string' ? state.status : 'unknown',
    kind: typeof state.kind === 'string' ? state.kind : 'unknown',
    title: sanitize(typeof state.title === 'string' ? state.title : ''),
    hasRawInput: !!state.rawInput, events, permissionObserved,
    paths: (Array.isArray(state.locations) ? state.locations : [])
      .filter((location: any) => typeof location?.path === 'string').slice(0, 40).map((location: any) => sanitize(location.path)),
    nodeOutputMarker
  })) }
}
