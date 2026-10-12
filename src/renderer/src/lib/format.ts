import { formatDistanceToNowStrict } from 'date-fns'
import { enUS, zhCN } from 'date-fns/locale'
import type { Locale } from '@shared/types'

export function relativeTime(iso?: string, locale: Locale = 'en'): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    if (locale === 'zh-CN') {
      return formatDistanceToNowStrict(d, { addSuffix: false, locale: zhCN })
    }
    return formatDistanceToNowStrict(d, { addSuffix: false, locale: enUS })
      .replace(' seconds', 's')
      .replace(' second', 's')
      .replace(' minutes', 'm')
      .replace(' minute', 'm')
      .replace(' hours', 'h')
      .replace(' hour', 'h')
      .replace(' days', 'd')
      .replace(' day', 'd')
      .replace(' months', 'mo')
      .replace(' month', 'mo')
      .replace(' years', 'y')
      .replace(' year', 'y')
  } catch {
    return ''
  }
}

export function initials(name?: string | null, email?: string | null): string {
  const src = (name || email || 'G').trim()
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] || 'G') + (parts[1]?.[0] || '')).toUpperCase()
}

export function shortPath(p: string): string {
  return p.replace(/\\/g, '/').split('/').slice(-2).join('/')
}

export function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}
