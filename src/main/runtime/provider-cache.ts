import type { ProviderId } from '../../shared/types'
import type { RuntimeProvider } from '../../shared/runtime'

/** Cache each provider independently, so a slow unrelated CLI never blocks a run. */
export function createProviderCatalog(
  inspect: (id: ProviderId) => Promise<RuntimeProvider>,
  ids: ProviderId[],
  now = Date.now
) {
  const cache = new Map<ProviderId, { value: RuntimeProvider; expires: number }>()
  const pending = new Map<ProviderId, Promise<RuntimeProvider>>()
  return async (refresh = false, selected = ids): Promise<RuntimeProvider[]> => {
    const result = await Promise.all([...new Set(selected)].map((id) => {
      if (!ids.includes(id)) throw new Error('未知模型提供商')
      const current = cache.get(id)
      if (!refresh && current && current.expires > now()) return current.value
      const underway = pending.get(id)
      if (underway) return underway
      const request = Promise.resolve().then(() => inspect(id)).then((value) => {
        cache.set(id, { value, expires: now() + (value.error ? 15000 : 300000) })
        return value
      }).finally(() => pending.delete(id))
      pending.set(id, request)
      return request
    }))
    return structuredClone(result)
  }
}
