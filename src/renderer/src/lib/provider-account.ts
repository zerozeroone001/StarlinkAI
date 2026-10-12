import type { RuntimeProvider } from '@shared/runtime'
import { isAccountAuthorized } from '@shared/provider-account'
import type { ProviderId } from '@shared/types'

export { isAccountAuthorized }

export interface ProviderReadiness {
  state: 'checking' | 'unknown' | 'unauthorized' | 'unavailable' | 'ready' | 'error'
  label: string
  detail: string
  canRun: boolean
}
export interface ProviderInspection { checking?: boolean; checked?: boolean; error?: string | null }
export interface ProviderInspections extends ProviderInspection { providerChecks?: Partial<Record<ProviderId, ProviderInspection>> }
export function inspectionForProvider(inspection: ProviderInspections, id: ProviderId): ProviderInspection {
  return inspection.providerChecks?.[id] || inspection
}

export function getProviderReadiness(
  provider: RuntimeProvider | undefined,
  inspection: ProviderInspections = {}
): ProviderReadiness {
  if (provider) inspection = inspectionForProvider(inspection, provider.id)
  if (inspection.checking) return { state: 'checking', label: '检测中', detail: '正在检测本机账号和模型，请稍候。', canRun: false }
  if (inspection.error) return { state: 'error', label: '检测失败', detail: '无法确认本机模型状态，请在“模型与账号”中重新检测。', canRun: false }
  if (!provider) return inspection.checked
    ? { state: 'unavailable', label: '不可用', detail: '未找到模型提供商，请在“模型与账号”中重新检测。', canRun: false }
    : { state: 'unknown', label: '未检测', detail: '尚未确认本机账号，请在“模型与账号”中检测。', canRun: false }
  if (provider.cli?.state !== 'installed') return { state: 'unavailable', label: '客户端不可用', detail: '模型客户端尚未就绪，请在“模型与账号”中检查。', canRun: false }
  if (!isAccountAuthorized(provider.auth, provider.usage)) return { state: 'unauthorized', label: '未授权', detail: '请先在“模型与账号”中登录该模型账号。', canRun: false }
  if (!provider.models.length) return { state: 'unavailable', label: '模型不可用', detail: '尚未获取可用模型，请在“模型与账号”中刷新模型目录。', canRun: false }
  return { state: 'ready', label: '已授权', detail: '本机账号已授权。', canRun: true }
}
