import { PROVIDERS, type Provider } from '@/lib/collaboration-data'

export function ProviderMark({ id, small = false }: { id: Provider; small?: boolean }) {
  const provider = PROVIDERS[id]
  return (
    <span aria-hidden="true" className={`provider-mark ${provider.tone}${small ? ' small' : ''}`}>
      {provider.letter}
    </span>
  )
}
