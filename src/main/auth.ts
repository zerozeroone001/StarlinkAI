import fs from 'node:fs'
import path from 'node:path'
import type { AuthInfo } from '../shared/types'
import { grokHome, writeJson } from './paths'
import { httpJson } from './http'

interface AuthEntry {
  email?: string
  first_name?: string
  last_name?: string
  user_id?: string
  principal_id?: string
  key?: string
  access_token?: string
  refresh_token?: string
  expires_at?: string
  oidc_issuer?: string
  oidc_client_id?: string
  auth_mode?: string
  [key: string]: unknown
}

const SKEW_MS = 5 * 60 * 1000
const OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

function authPath(): string {
  return path.join(grokHome(), 'auth.json')
}

function readAuthFile(): Record<string, AuthEntry> | null {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf8')) as Record<string, AuthEntry>
  } catch {
    return null
  }
}

function pickEntry(raw: Record<string, AuthEntry> | null): { scope: string; entry: AuthEntry } | null {
  if (!raw) return null
  const preferred = Object.entries(raw).find(([scope, entry]) => {
    if (!entry || typeof entry !== 'object') return false
    if (scope === 'xai::api_key' || entry.auth_mode === 'api_key') return false
    return Boolean(entry.key || entry.access_token)
  })
  if (preferred) return { scope: preferred[0], entry: preferred[1] }
  const first = Object.entries(raw)[0]
  return first ? { scope: first[0], entry: first[1] } : null
}

export function readAuth(): AuthInfo {
  const picked = pickEntry(readAuthFile())
  if (!picked) return { email: null, name: null, userId: null, signedIn: false }
  const { entry } = picked
  const name = [entry.first_name, entry.last_name].filter(Boolean).join(' ') || null
  return {
    email: entry.email ?? null,
    name,
    userId: entry.user_id || entry.principal_id || null,
    signedIn: Boolean(entry.key || entry.access_token)
  }
}

/** Workspace execution only accepts a subscription login, never an API-key fallback. */
export function readSubscriptionAuth(): AuthInfo {
  const picked = pickEntry(readAuthFile())
  const auth = readAuth()
  if (!picked || picked.scope === 'xai::api_key' || picked.entry.auth_mode === 'api_key') return { ...auth, signedIn: false }
  return auth
}

export function readAccessToken(): string | null {
  const picked = pickEntry(readAuthFile())
  const token = picked?.entry.key?.trim() || picked?.entry.access_token?.trim()
  return token || null
}

export function readAuthMeta(): { token: string | null; userId: string | null; clientId: string | null } {
  const picked = pickEntry(readAuthFile())
  return {
    token: picked?.entry.key?.trim() || picked?.entry.access_token?.trim() || null,
    userId: picked?.entry.user_id || picked?.entry.principal_id || null,
    clientId: picked?.entry.oidc_client_id || OAUTH_CLIENT_ID
  }
}

function tokenStale(entry: AuthEntry): boolean {
  if (!entry.expires_at) return false
  const at = new Date(entry.expires_at).getTime()
  if (!Number.isFinite(at)) return false
  return at - SKEW_MS <= Date.now()
}

async function refreshEntry(scope: string, entry: AuthEntry, raw: Record<string, AuthEntry>): Promise<string | null> {
  const refresh = entry.refresh_token?.trim()
  if (!refresh) return entry.key?.trim() || entry.access_token?.trim() || null
  const clientId = entry.oidc_client_id || OAUTH_CLIENT_ID
  const issuer = (entry.oidc_issuer || 'https://auth.x.ai').replace(/\/$/, '')
  try {
    const res = await httpJson(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refresh
      }).toString(),
      timeoutMs: 12000
    })
    const body = res.json && typeof res.json === 'object' ? (res.json as Record<string, unknown>) : {}
    const access = typeof body.access_token === 'string' ? body.access_token : null
    if (!access || res.status >= 400) return entry.key?.trim() || entry.access_token?.trim() || null
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 21600
    const nextRefresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refresh
    const next: AuthEntry = {
      ...entry,
      key: access,
      refresh_token: nextRefresh,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
    }
    writeJson(authPath(), { ...raw, [scope]: next })
    return access
  } catch {
    return entry.key?.trim() || entry.access_token?.trim() || null
  }
}

export async function readFreshAccessToken(): Promise<{ token: string; userId: string | null } | null> {
  const raw = readAuthFile()
  const picked = pickEntry(raw)
  if (!picked) return null
  let token = picked.entry.key?.trim() || picked.entry.access_token?.trim() || null
  if (!token) return null
  if (tokenStale(picked.entry) && raw) {
    token = (await refreshEntry(picked.scope, picked.entry, raw)) || token
  }
  return {
    token,
    userId: picked.entry.user_id || picked.entry.principal_id || null
  }
}
