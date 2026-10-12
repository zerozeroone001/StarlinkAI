import { create } from 'zustand'
import type { RuntimeProvider } from '@shared/runtime'
import type { ProviderId, UsageSnapshot } from '@shared/types'
import { runtimeClient } from '@/lib/runtime-client'
import { PROVIDER_IDS } from '@/lib/collaboration-data'
import type { ProviderInspection } from '@/lib/provider-account'

interface ProviderState {
  diagnostics: RuntimeProvider[]
  checking: boolean
  checked: boolean
  error: string | null
  providerChecks: Partial<Record<ProviderId, ProviderInspection>>
  usage: UsageSnapshot | null
  usageLoading: boolean
  inspect: (ids?: ProviderId[]) => Promise<void>
  loadUsage: () => Promise<void>
}
const pending = new Map<ProviderId, Promise<void>>()
let fullInspection: Promise<void> | undefined
function checkPatch(state: ProviderState, id: ProviderId, status: ProviderInspection): Partial<ProviderState> {
  const providerChecks = { ...state.providerChecks, [id]: status }
  const states = Object.values(providerChecks)
  return { providerChecks, checking: states.some((item) => item.checking),
    checked: PROVIDER_IDS.every((provider) => providerChecks[provider]?.checked),
    usageLoading: !!providerChecks.grok?.checking,
    error: states.find((item) => item.error)?.error || null }
}
export const useProviders = create<ProviderState>((set, get) => ({
  diagnostics: [],
  checking: false,
  checked: false,
  error: null,
  providerChecks: {},
  usage: null,
  usageLoading: false,
  inspect: (ids) => {
    // New consumers may mount as fast accounts arrive. Join the existing batch
    // so those mounts do not repeatedly refresh its already-completed accounts.
    if (!ids && fullInspection) return fullInspection
    const selected = [...new Set(ids || PROVIDER_IDS)]
    if (selected.some((id) => !PROVIDER_IDS.includes(id))) return Promise.reject(new Error('未知模型提供商'))
    const request = Promise.all(selected.map((id) => {
      const existing = pending.get(id)
      if (existing) return existing
      set((state) => checkPatch(state, id, { checking: true, checked: !!state.providerChecks[id]?.checked, error: null }))
      const probe = Promise.resolve().then(() => runtimeClient.providers(true, [id])).then((providers) => {
        const provider = providers.find((provider) => provider.id === id)
        if (!provider) throw new Error('未找到模型提供商，请重试检测。')
        set((state) => ({ ...checkPatch(state, id, { checking: false, checked: true, error: null }),
          diagnostics: PROVIDER_IDS.flatMap((providerId) => {
            const value = providerId === id ? provider : state.diagnostics.find((item) => item.id === providerId)
            return value ? [value] : []
          }), ...(id === 'grok' ? { usage: provider.usage || null } : {}) }))
      }).catch((error) => {
        set((state) => checkPatch(state, id, { checking: false, checked: true,
          error: error instanceof Error ? error.message : '本机模型服务连接失败' }))
      }).finally(() => pending.delete(id))
      pending.set(id, probe)
      return probe
    })).then(() => {})
    if (ids) return request
    fullInspection = request.finally(() => { fullInspection = undefined })
    return fullInspection
  },
  loadUsage: async () => {
    if (!get().providerChecks.grok?.checked) await get().inspect(['grok'])
  }
}))
