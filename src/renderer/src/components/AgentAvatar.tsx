import { useState } from 'react'
import type { Member, Provider } from '@/lib/collaboration-data'
import { ProviderMark } from './ProviderMark'

export function AgentAvatar({ member, provider, active = false, small = false }: {
  member?: Member; provider?: Provider; active?: boolean; small?: boolean
}) {
  const [failed, setFailed] = useState<string>()
  const avatar = member?.avatar
  return <span className={`agent-avatar${active ? ' is-responding' : ''}${small ? ' small' : ''}`}>
    {avatar && failed !== avatar
      ? <img src={avatar} alt={`${member?.name || 'Agent'}的头像`} onError={() => setFailed(avatar)} />
      : <ProviderMark id={provider || member?.provider || 'grok'} small={small} />}
  </span>
}
