import type { AuthInfo, UsageSnapshot } from './types'

export function isAccountAuthorized(
  auth: AuthInfo | null | undefined,
  usage: UsageSnapshot | null | undefined
): boolean {
  return !!auth?.signedIn && usage?.error !== 'auth' && usage?.error !== 'signed_out'
}
