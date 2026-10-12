import { useEffect } from 'react'
import { EFFORT_LABELS, type ModelChoice } from '@shared/runtime'
import type { Provider } from '@/lib/collaboration-data'
import { useProviders } from '@/stores/providers'
import { inspectionForProvider } from '@/lib/provider-account'

export function ModelPicker({
  provider,
  value,
  onChange,
  showError = true
}: {
  provider: Provider
  value: ModelChoice
  onChange: (choice: ModelChoice) => void
  showError?: boolean
}) {
  const inspection = useProviders()
  const { diagnostics, checked, inspect } = inspection
  const { checking } = inspectionForProvider(inspection, provider)
  useEffect(() => {
    if (!checked) void inspect()
  }, [checked, inspect])
  const p = diagnostics.find((p) => p.id === provider)
  const model = value.model
    ? p?.models.find((m) => m.id === value.model)
    : p?.models.find((m) => m.isDefault) || p?.models[0]
  const unavailable = !!value.model && !model
  return (
    <div className="model-picker">
      <div className="ws-form-pair">
        <label>
          具体型号
          <select
            aria-label="具体型号"
            value={value.model || ''}
            disabled={checking}
            onChange={(e) => onChange({ model: e.target.value || undefined, effort: undefined })}
          >
            <option value="">{checking ? '读取目录中…' : '厂商默认型号'}</option>
            {unavailable && <option value={value.model}>{value.model} · 当前不可用</option>}
            {p?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.resolvedModel || m.name}
                {m.id === 'default' ? ' · 默认别名' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          推理等级
          <select
            aria-label="推理等级"
            value={value.effort || ''}
            disabled={checking || !model?.efforts.length}
            onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
          >
            <option value="">
              {model?.efforts.length
                ? `厂商默认${model.defaultEffort ? ` · ${EFFORT_LABELS[model.defaultEffort] || model.defaultEffort}` : ''}`
                : '客户端自动'}
            </option>
            {value.effort && !model?.efforts.includes(value.effort) && (
              <option value={value.effort}>{value.effort} · 当前不可用</option>
            )}
            {model?.efforts.map((e) => (
              <option value={e} key={e}>
                {EFFORT_LABELS[e] || e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="employee-hint">
        {unavailable
          ? '所选型号已不在当前目录中，执行前请重新选择。'
          : model
            ? `${model.resolvedModel || model.id}${model.efforts.length ? ' · 推理档位来自客户端' : ' · 当前客户端未提供推理档位'}`
            : (showError && p?.error) || '授权后读取可用型号与推理档位。'}
      </p>
    </div>
  )
}
