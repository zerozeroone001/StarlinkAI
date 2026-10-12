import fs from 'node:fs'
import path from 'node:path'
import type { UsageSnapshot, UsageWindow, UsageWindowKind } from '../shared/types'
import { readFreshAccessToken } from './auth'
import { envProxy, httpJson } from './http'
import { grokHome } from './paths'

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if ('val' in rec) return num(rec.val)
    if ('value' in rec) return num(rec.value)
  }
  return null
}

function iso(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
    const n = Number(v)
    if (Number.isFinite(n)) return iso(n)
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v > 1e10 ? v : v * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if (typeof rec.seconds === 'number') return iso(rec.seconds * 1000)
    if (rec.end) return iso(rec.end)
    if (rec.endsAt) return iso(rec.endsAt)
  }
  return null
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

function windowKind(resetsAt: string | null, type?: string | null): UsageWindowKind {
  if (type && /week/i.test(type)) return 'weekly'
  if (type && /month/i.test(type)) return 'monthly'
  if (!resetsAt) return 'unknown'
  const days = (new Date(resetsAt).getTime() - Date.now()) / 86400000
  if (days >= 0 && days <= 12) return 'weekly'
  if (days > 12 && days <= 45) return 'monthly'
  return 'unknown'
}

function productLabel(name: string): string {
  if (name === 'GrokBuild') return 'Grok Build'
  if (name === 'GrokChat') return 'Grok Chat'
  if (name === 'GrokImagine') return 'Imagine'
  if (name === 'GrokVoice') return 'Voice'
  if (name === 'Api') return 'API'
  return name.replace(/^Grok/, 'Grok ')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function parseCredits(raw: unknown): { plan: string | null; windows: UsageWindow[] } {
  const rec = asRecord(raw)
  const config = asRecord(rec.config && typeof rec.config === 'object' ? rec.config : rec)
  const period = asRecord(config.currentPeriod)
  const periodType = str(period.type)
  const resetsAt = iso(period.end) || iso(config.billingPeriodEnd) || iso(config.currentPeriod)
  const kind = windowKind(resetsAt, periodType)
  let percent = num(config.creditUsagePercent)
  if (percent != null && percent <= 1 && percent > 0 && num(config.monthlyLimit) == null) {
    percent = percent * 100
  }

  const windows: UsageWindow[] = []
  windows.push({
    id: 'credits',
    label: kind === 'monthly' ? 'Monthly credits' : 'Weekly credits',
    kind,
    usedPercent: percent != null ? Math.min(100, Math.max(0, percent)) : periodType ? 0 : null,
    used: null,
    limit: null,
    remaining: null,
    resetsAt,
    unit: 'percent'
  })

  const products = Array.isArray(config.productUsage) ? config.productUsage : []
  for (const item of products) {
    const row = asRecord(item)
    const product = str(row.product)
    const usage = num(row.usagePercent)
    if (!product || usage == null) continue
    windows.push({
      id: `product_${product}`,
      label: productLabel(product),
      kind,
      usedPercent: Math.min(100, Math.max(0, usage)),
      used: null,
      limit: null,
      remaining: null,
      resetsAt,
      unit: 'percent'
    })
  }

  const cap = num(config.onDemandCap)
  const usedOn = num(config.onDemandUsed)
  if (cap != null && cap > 0) {
    const pct = usedOn != null ? Math.min(100, Math.max(0, (usedOn / cap) * 100)) : null
    windows.push({
      id: 'on_demand',
      label: 'On-demand',
      kind: 'unknown',
      usedPercent: pct,
      used: usedOn,
      limit: cap,
      remaining: usedOn != null ? Math.max(0, cap - usedOn) : null,
      resetsAt,
      unit: 'credits'
    })
  }

  const plan =
    str(config.subscriptionTierDisplay) ||
    str(config.subscription_tier_display) ||
    str(config.plan) ||
    str(config.planName) ||
    (config.isUnifiedBillingUser ? 'SuperGrok' : null)

  return { plan, windows }
}

function mergeMonthly(snap: { plan: string | null; windows: UsageWindow[] }, raw: unknown): void {
  const rec = asRecord(raw)
  const config = asRecord(rec.config && typeof rec.config === 'object' ? rec.config : rec)
  const used = num(config.used) ?? num(asRecord(rec.usage).totalUsed)
  const limit = num(config.monthlyLimit)
  if (used == null || limit == null || limit <= 0) return
  const resetsAt = iso(config.billingPeriodEnd)
  snap.windows.push({
    id: 'monthly',
    label: 'Monthly credits',
    kind: 'monthly',
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt,
    unit: 'credits'
  })
}

function clientVersion(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(grokHome(), 'version.json'), 'utf8')) as {
      version?: string
    }
    return raw.version || '1.0.5'
  } catch {
    return '1.0.5'
  }
}

async function requestJson(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; json: unknown }> {
  if (envProxy()) {
    const res = await httpJson(url, { headers, timeoutMs: 15000 })
    return { status: res.status, json: res.json }
  }
  try {
    const electron = await import('electron')
    if (electron.net?.fetch) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 15000)
      try {
        const res = await electron.net.fetch(url, { headers, signal: ac.signal })
        const text = await res.text()
        let json: unknown = null
        try {
          json = JSON.parse(text) as unknown
        } catch {
          /* ignore */
        }
        return { status: res.status, json }
      } finally {
        clearTimeout(timer)
      }
    }
  } catch {
    /* fall through */
  }
  const res = await httpJson(url, { headers, timeoutMs: 15000 })
  return { status: res.status, json: res.json }
}

function usable(snap: UsageSnapshot): boolean {
  return Boolean(
    snap.plan ||
      snap.windows.some(
        (w) => w.usedPercent != null || w.resetsAt || w.used != null || w.limit != null
      )
  )
}

export async function fetchUsage(): Promise<UsageSnapshot> {
  const creds = await readFreshAccessToken()
  if (!creds?.token) {
    return {
      plan: null,
      fetchedAt: new Date().toISOString(),
      windows: [],
      error: 'signed_out'
    }
  }

  const ver = clientVersion()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.token}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': ver,
    'x-grok-client-mode': 'interactive',
    'User-Agent': `xai-grok-cli/${ver}`
  }
  if (creds.userId) headers['x-userid'] = creds.userId

  const hosts = ['https://cli-chat-proxy.grok.com/v1', 'https://cli-chat-proxy.x.ai/v1']
  let last = 'unavailable'

  for (const host of hosts) {
    try {
      const credits = await requestJson(`${host}/billing?format=credits`, headers)
      if (credits.status === 401 || credits.status === 403) {
        return {
          plan: null,
          fetchedAt: new Date().toISOString(),
          windows: [],
          error: 'auth'
        }
      }
      if (credits.status >= 400 || credits.json == null) {
        last = `http_${credits.status}`
        continue
      }

      const parsed = parseCredits(credits.json)
      const snap: UsageSnapshot = {
        plan: parsed.plan,
        fetchedAt: new Date().toISOString(),
        windows: parsed.windows
      }

      const extra = await Promise.allSettled([
        requestJson(`${host}/billing`, headers),
        requestJson(`${host}/settings`, headers)
      ])
      if (extra[0].status === 'fulfilled' && extra[0].value.status < 400) {
        mergeMonthly(snap, extra[0].value.json)
      }
      if (extra[1].status === 'fulfilled' && extra[1].value.status < 400) {
        const settings = asRecord(extra[1].value.json)
        snap.plan =
          str(settings.subscription_tier_display) ||
          str(settings.subscriptionTierDisplay) ||
          snap.plan
      }

      if (usable(snap)) return snap
      last = 'empty'
    } catch (err) {
      const status = (err as { status?: number }).status
      last = status ? `http_${status}` : 'network'
    }
  }

  return {
    plan: null,
    fetchedAt: new Date().toISOString(),
    windows: [],
    error: last === 'empty' ? 'empty' : last.startsWith('http_') ? 'unavailable' : last
  }
}
