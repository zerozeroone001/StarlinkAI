import { useState } from 'react'
import { Check, ChevronRight, RefreshCw } from 'lucide-react'
import type { ModelChoice } from '@shared/runtime'
import { PROVIDERS, PROVIDER_IDS, type Provider } from '@/lib/collaboration-data'
import { getProviderReadiness, inspectionForProvider } from '@/lib/provider-account'
import { providerErrorSummary } from '@/lib/provider-error-summary'
import { availableOnboardingChoice, currentConversationBlockReason, onboardingContextError, onboardingMember } from '@/lib/provider-onboarding'
import { useProviders } from '@/stores/providers'
import { currentWorkspaceGeneration, useCollaboration } from '@/stores/collaboration'
import { ModelPicker } from './ModelPicker'
import { ProviderLogin } from './ProviderLogin'
import { ProviderMark } from './ProviderMark'
import { WorkspaceDialog } from './WorkspaceDialogs'
import './provider-onboarding.css'

export function ProviderConnectionDialog({ teamId, close, applied }: {
  teamId: string; close: () => void; applied: (message: string) => void
}) {
  const inspection = useProviders()
  const workspace = useCollaboration()
  const [generation] = useState(currentWorkspaceGeneration)
  const [loginProvider, setLoginProvider] = useState<Provider | null>(null)
  const [selected, setSelected] = useState<Provider | null>(null)
  const [choice, setChoice] = useState<ModelChoice>({})
  const [scope, setScope] = useState<'current' | 'default' | null>(null)
  const [error, setError] = useState('')
  const team = workspace.teams.find((team) => team.id === teamId)
  const currentBlocked = currentConversationBlockReason(team, workspace.runs)
  const contextError = onboardingContextError(teamId, generation, workspace, currentWorkspaceGeneration())
  const readiness = (id: Provider) => getProviderReadiness(inspection.diagnostics.find((provider) => provider.id === id), inspectionForProvider(inspection, id))
  const choose = (id: Provider) => {
    const invalidContext = onboardingContextError(teamId, generation, useCollaboration.getState(), currentWorkspaceGeneration())
    if (invalidContext) { setLoginProvider(null); setSelected(null); setError(invalidContext); return }
    const current = useProviders.getState()
    const provider = current.diagnostics.find((provider) => provider.id === id)
    if (!provider || !getProviderReadiness(provider, inspectionForProvider(current, id)).canRun) { setLoginProvider(id); return }
    setChoice(availableOnboardingChoice(provider, useCollaboration.getState().modelDefaults[id]))
    setScope(null); setError(''); setLoginProvider(null); setSelected(id)
  }
  const confirm = () => {
    try {
      const invalidContext = onboardingContextError(teamId, generation, useCollaboration.getState(), currentWorkspaceGeneration())
      if (invalidContext) throw new Error(invalidContext)
      if (!selected || !scope) return
      const current = useProviders.getState(), state = useCollaboration.getState()
      const provider = current.diagnostics.find((provider) => provider.id === selected)
      if (!provider || !getProviderReadiness(provider, inspectionForProvider(current, selected)).canRun)
        throw new Error('所选账号暂不可用，请重新检测后再应用。')
      const model = choice.model ? provider.models.find((model) => model.id === choice.model)
        : provider.models.find((model) => model.isDefault) || provider.models[0]
      if (!model || (choice.effort && !model.efforts.includes(choice.effort))) throw new Error('所选型号或推理等级已不可用，请重新选择。')
      if (scope === 'current') {
        state.saveEmployee(teamId, onboardingMember(state.teams.find((team) => team.id === teamId), state.runs, provider, choice))
      } else {
        state.setModelDefault(selected, choice)
        state.setDefaultProvider(selected)
      }
      if (state.teams.some((team) => team.id === teamId)) state.navigate('team', teamId)
      applied(scope === 'current' ? `已将 ${PROVIDERS[selected].name} 用于当前空会话；草稿已保留，可继续编辑后发送。`
        : `已将 ${PROVIDERS[selected].name} 设为新会话与项目默认，仅影响之后新建的独立会话和项目；现有项目内的新子会话仍继承该项目员工，当前会话配置与草稿保持不变。`)
    } catch (error) { setError(error instanceof Error ? error.message : '无法应用账号，请重新选择。') }
  }

  if (contextError) return <WorkspaceDialog title="连接模型账号" close={close}>
    <div className="provider-login-guide"><p role="alert">{contextError}</p><p>账号检测结果可以保留；会话配置和新会话与项目默认均未更改。</p></div>
    <footer><button className="ws-button" onClick={close}>返回工作区</button></footer>
  </WorkspaceDialog>
  if (loginProvider) return <ProviderLogin provider={loginProvider} close={close} onConnected={choose} />
  if (selected) return <WorkspaceDialog title="使用模型账号" subtitle="选择应用范围后返回工作区，不会自动发送消息。" close={close}>
    <div className="provider-login-guide">
      <div className="provider-login-identity"><ProviderMark id={selected} /><strong>{PROVIDERS[selected].name} · {readiness(selected).canRun ? '可用' : '暂不可用'}</strong></div>
      <ModelPicker provider={selected} value={choice} onChange={setChoice} showError={false} />
      <fieldset className="provider-application-scope"><legend>应用范围</legend>
        <label><input type="radio" name="provider-application" aria-label="仅用于当前空会话" checked={scope === 'current'} disabled={!!currentBlocked}
          onChange={() => setScope('current')} />仅用于当前空会话</label>
        <p>只替换“{team?.name || '原会话'}”的主助手模型，保留草稿和附件；不改变新会话与项目默认。</p>
        {currentBlocked && <p role="note">{currentBlocked}</p>}
        <label><input type="radio" name="provider-application" aria-label="设为新会话与项目默认" checked={scope === 'default'} onChange={() => setScope('default')} />设为新会话与项目默认</label>
        <p>仅影响之后新建的独立会话和项目；现有项目内的新子会话仍继承该项目员工。当前会话、现有项目和其他员工配置不变。</p>
      </fieldset>
      {error && <p role="alert" className="ws-error">{error}</p>}
    </div>
    <footer><button className="ws-button" onClick={() => { setSelected(null); setScope(null); setError('') }}>重新选择服务</button>
      <button className="ws-button accent" disabled={!scope || (scope === 'current' && !!currentBlocked) || !readiness(selected).canRun}
        onClick={confirm}><Check size={14} />确认并返回工作区</button></footer>
  </WorkspaceDialog>

  return <WorkspaceDialog title="连接模型账号" subtitle="选择模型服务。已就绪的账号可直接使用，其他服务的检测不会阻塞选择。" close={close}>
    <div className="account-connect-list">
      {[...PROVIDER_IDS].sort((left, right) => Number(readiness(right).canRun) - Number(readiness(left).canRun)).map((id) => {
        const status = readiness(id)
        const label = status.canRun ? '可直接使用' : status.state === 'checking' || status.state === 'unknown' ? '正在检测本机账号'
          : status.state === 'unauthorized' ? '连接官方账号' : status.label
        return <button key={id} onClick={() => choose(id)}><ProviderMark id={id} /><span><strong>{PROVIDERS[id].name}</strong>
          <small>{label}</small></span><ChevronRight size={16} /></button>
      })}
    </div>
    <footer><button className="ws-button" onClick={close}>返回工作区</button><button className="ws-button" disabled={inspection.checking} onClick={() => void inspection.inspect()}>
      <RefreshCw size={14} />重新检测</button></footer>
    {inspection.error && <p className="provider-login-feedback" role="status">{providerErrorSummary(inspection.error)}</p>}
    {error && <p className="provider-login-feedback" role="alert">{error}</p>}
  </WorkspaceDialog>
}
