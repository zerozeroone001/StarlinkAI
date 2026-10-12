import { useEffect, useState } from 'react'
import {
  Check,
  Info,
  KeyRound,
  LogIn,
  Plus,
  ChevronRight,
  Mail,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Terminal
} from 'lucide-react'
import type { AuthInfo, UsageSnapshot } from '@shared/types'
import { PROVIDERS, PROVIDER_IDS, type Provider } from '@/lib/collaboration-data'
import { useCollaboration } from '@/stores/collaboration'
import { useProviders } from '@/stores/providers'
import { useApp } from '@/stores/app'
import { ProviderMark } from './ProviderMark'
import { WorkspaceDialog } from './WorkspaceDialogs'
import { ModelPicker } from './ModelPicker'
import type { RuntimeProvider } from '@shared/runtime'
import { ProviderLogin } from './ProviderLogin'
import { inspectionForProvider, isAccountAuthorized } from '@/lib/provider-account'

function stamp(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未读取'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function ProviderSettings() {
  const inspection = useProviders()
  const { diagnostics, checking, checked, error, providerChecks, usage, usageLoading, inspect, loadUsage } = inspection
  const appAuth = useApp((s) => s.auth)
  const connected = useApp((s) => s.connected)
  const [loginProvider, setLoginProvider] = useState<Provider | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const accounts = PROVIDER_IDS.map((id) => {
    const diagnostic = diagnostics.find((d) => d.id === id)
    const auth = diagnostic ? diagnostic.auth : id === 'grok' && window.grok ? appAuth : null
    return { id, diagnostic, auth, inspection: inspectionForProvider(inspection, id) }
  })
  const authorizedAccounts = accounts.filter(({ auth, diagnostic }) =>
    isAccountAuthorized(auth, diagnostic?.usage)
  )
  const availableAccounts = accounts.filter(({ auth, diagnostic }) =>
    !isAccountAuthorized(auth, diagnostic?.usage)
  )
  const initialLoading = !checked && checking

  useEffect(() => {
    if (!checked) void inspect()
  }, [checked, inspect])
  useEffect(() => {
    if (!usage) void loadUsage()
  }, [usage, loadUsage])
  const refresh = async () => {
    await inspect()
  }

  return (
    <div className="provider-settings">
      <div className="account-page-head">
        <div>
          <h2>
            模型与账号 <span className="account-count">{authorizedAccounts.length}</span>
          </h2>
          <p>管理已授权账号，为新对话选择默认模型与推理等级。</p>
        </div>
        <div className="account-page-actions">
        {availableAccounts.length > 0 && (
          <button className="ws-button account-add-button" onClick={() => setAddingAccount(true)}>
            <Plus size={15} />添加账号
          </button>
        )}
        <button
          className="ws-button"
          disabled={checking || usageLoading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={checking || usageLoading ? 'spinning' : ''} />
          {checking || usageLoading ? '刷新中…' : '全部刷新'}
        </button>
        </div>
      </div>
      <div className="account-policy">
        <ShieldCheck size={14} />
        <span>仅显示已授权账号</span>
        <span className="account-policy-divider" />
        <span>沿用本机授权 · 支持 Gemini API Key</span>
      </div>
      {error && !Object.keys(providerChecks).length && (
        <p className="account-environment-note" role="status">
          <Info size={13} />
          {error}
        </p>
      )}
      {accounts.filter((account) => !authorizedAccounts.includes(account) && (account.inspection.checking || account.inspection.error || account.diagnostic?.error)).map((account) => (
        <div className="account-environment-note" role="status" key={account.id} aria-label={`${PROVIDERS[account.id].name} 检测状态`}>
          <ProviderMark id={account.id} />
          <span>{PROVIDERS[account.id].name} · {account.inspection.checking ? '正在检测本机账号和模型…' : account.inspection.error || account.diagnostic?.error}</span>
          {!account.inspection.checking && (account.inspection.error || account.diagnostic?.error) && <button type="button" className="ws-button"
            aria-label={`重新检测 ${PROVIDERS[account.id].name}`} onClick={() => void inspect([account.id])}>重新检测</button>}
        </div>
      ))}
      {!authorizedAccounts.length && (
        <div className="account-empty-state" role="status">
          <span className="account-empty-icon"><ShieldCheck size={28} /></span>
          <h3>{initialLoading ? '正在检查本机授权…' : error ? '暂时无法读取账号' : '还没有已授权的账号'}</h3>
          <p>{initialLoading ? '检测完成后，已授权账号会显示在这里。' : error ? '请稍后刷新，或通过添加账号查看授权方式。' : '添加一个模型账号，完成授权后即可选择模型并开始对话。'}</p>
          {!initialLoading && <button className="ws-button account-add-button" onClick={() => setAddingAccount(true)}><Plus size={15} />添加账号</button>}
        </div>
      )}
      <div className="provider-account-grid" aria-label="已授权模型账号" aria-busy={checking}>
        {authorizedAccounts.map(({ id, diagnostic, auth, inspection: status }) => {
          return (
            <ProviderAccountCard
              key={id}
              id={id}
              diagnostic={diagnostic}
              auth={auth}
              usage={diagnostic?.usage || null}
              checking={!!status.checking}
              inspectionError={status.error}
              usageLoading={id === 'grok' && usageLoading}
              connected={id === 'grok' && connected}
              onLogin={() => setLoginProvider(id)}
              onRefresh={() => void inspect([id])}
            />
          )
        })}
      </div>
      {addingAccount && (
        <WorkspaceDialog title="添加模型账号" subtitle="选择模型服务，完成授权后将在账号页面显示。" close={() => setAddingAccount(false)}>
          <div className="account-connect-list">
            {availableAccounts.map(({ id }) => (
              <button key={id} onClick={() => { setAddingAccount(false); setLoginProvider(id) }}>
                <ProviderMark id={id} />
                <span><strong>{PROVIDERS[id].name}</strong><small>{id === 'gemini' ? 'Google 账号或 API Key' : '使用本机客户端授权'}</small></span>
                <ChevronRight size={16} />
              </button>
            ))}
            {!availableAccounts.length && <p>所有支持的模型均已授权。</p>}
          </div>
        </WorkspaceDialog>
      )}
      {loginProvider && (
        <ProviderLogin provider={loginProvider} close={() => setLoginProvider(null)} />
      )}
    </div>
  )
}

function ProviderAccountCard({
  id,
  diagnostic,
  auth,
  usage,
  checking,
  inspectionError,
  usageLoading,
  connected,
  onLogin,
  onRefresh
}: {
  id: Provider
  diagnostic?: RuntimeProvider
  auth: AuthInfo | null
  usage: UsageSnapshot | null
  checking: boolean
  inspectionError?: string | null
  usageLoading: boolean
  connected: boolean
  onLogin: () => void
  onRefresh: () => void
}) {
  const defaultProvider = useCollaboration((s) => s.defaultProvider)
  const setDefaultProvider = useCollaboration((s) => s.setDefaultProvider)
  const isDefault = defaultProvider === id
  const modelDefaults = useCollaboration((s) => s.modelDefaults)
  const setModelDefault = useCollaboration((s) => s.setModelDefault)
  const provider = PROVIDERS[id]
  const apiKey = diagnostic?.authSource?.includes('API Key') || false
  const expired = usage?.error === 'auth' || usage?.error === 'signed_out'
  const signedIn = isAccountAuthorized(auth, usage)
  const status = checking ? '检测中…' : inspectionError ? '检测失败' : expired
    ? '需要登录'
    : signedIn
      ? apiKey ? 'API Key 已授权' : '本地已登录'
      : auth
        ? '未授权'
        : id === 'grok'
          ? '待检测授权'
          : '待检测授权'
  const cli = diagnostic?.cli
  const version = !cli
    ? checking
      ? '检测中…'
      : '待检测'
    : cli.state === 'installed'
      ? cli.version
        ? `v${cli.version}`
        : '已安装 · 版本未知'
      : cli.state === 'not_found'
        ? '未找到客户端'
        : '检测失败'
  const busy = checking || usageLoading

  return (
    <section
      className={`provider-account-card ${provider.tone}${isDefault ? ' is-default' : ''}`}
      aria-label={`${provider.name} 账号卡片`}
    >
      <header className="provider-account-header">
        <ProviderMark id={id} />
        <div>
          <h3>{provider.name}</h3>
          <p>{provider.description}</p>
        </div>
        <span className={`account-status${signedIn ? ' ok' : ''}`}>
          <i />
          {status}
        </span>
      </header>
      <div className={`provider-account-identity${auth?.email ? ' has-email' : ''}`}>
        <span className="provider-identity-icon" aria-hidden="true">
          {apiKey ? <KeyRound size={18} /> : <Mail size={18} />}
        </span>
        <div>
          <span>{apiKey ? '授权方式' : '账号邮箱'}</span>
          <strong>{auth?.email || (apiKey ? 'Google AI Studio API Key' : signedIn ? '客户端未提供邮箱' : '尚未登录')}</strong>
        </div>
      </div>
      <button
        className={`provider-default-choice${isDefault ? ' selected' : ''}`}
        aria-pressed={isDefault}
        aria-label={`${provider.name} ${isDefault ? '默认模型' : '设为默认'}`}
        onClick={() => setDefaultProvider(id)}
      >
        <span className="default-radio">{isDefault && <Check size={11} />}</span>
        <span>{isDefault ? '默认模型' : '设为默认'}</span>
        <small>{isDefault ? '新对话将优先使用' : '用于新对话与项目'}</small>
      </button>
      <ModelPicker
        provider={id}
        showError={false}
        value={modelDefaults[id] || {}}
        onChange={(choice) => setModelDefault(id, choice)}
      />
      <dl className="provider-account-facts">
        <div>
          <dt>{apiKey ? '计费方式' : '订阅套餐'}</dt>
          <dd>{apiKey ? 'API 用量计费 / 免费配额' : usage?.plan || '未知'}</dd>
        </div>
        <div>
          <dt>授权来源</dt>
          <dd>{diagnostic?.authSource || '尚未读取'}</dd>
        </div>
      </dl>
      <details className="provider-client-details">
        <summary><Terminal size={12} />客户端 · {version}</summary>
        {cli?.path && <div className="provider-account-path">{cli.path}</div>}
      </details>
      {(inspectionError || diagnostic?.error) && (
        <p className="provider-diagnostic-error" role="status">
          {inspectionError || diagnostic?.error}
        </p>
      )}
      <div className="provider-account-usage" aria-label={`${provider.name} ${apiKey ? 'API 用量' : '订阅用量'}`}>
        <div className="provider-usage-heading">
          <h4><Gauge size={14} />{apiKey ? 'API 用量' : '订阅用量'}</h4>
          <span>{usageLoading ? '正在读取…' : usage ? stamp(usage.fetchedAt) : '尚未读取'}</span>
        </div>
        {usage && !usage.error && usage.windows.length ? (
          <div className="provider-quota-list" tabIndex={0} aria-label={`${usage.windows.length} 个额度窗口，可滚动查看`}>
            {usage.windows.map((win) => {
              const percent =
                win.usedPercent !== null && Number.isFinite(win.usedPercent)
                  ? Math.max(0, Math.min(100, win.usedPercent))
                  : null
              return (
                <div className="provider-quota" key={win.id}>
                  <div>
                    <strong>{win.label}</strong>
                    <span>{percent === null ? '比例未知' : `已用 ${Math.round(percent)}%`}</span>
                  </div>
                  {percent === null ? (
                    <div className="quota-unknown-bar" />
                  ) : (
                    <progress
                      max={100}
                      value={percent}
                      className={percent >= 90 ? 'high' : ''}
                      aria-label={`${provider.name} ${win.label}已用比例`}
                    />
                  )}
                  <p>
                    <span>
                      {win.used !== null && win.limit !== null
                        ? `${win.used} / ${win.limit} ${win.unit || ''}`
                        : '总量未知'}
                    </span>
                    <span>
                      {win.remaining !== null
                        ? `剩余 ${win.remaining} ${win.unit || ''}`
                        : percent !== null
                          ? `剩余 ${Math.round(100 - percent)}%`
                          : '剩余额度未知'}
                    </span>
                  </p>
                  <small>{win.resetsAt ? `${stamp(win.resetsAt)} 重置` : '重置时间未知'}</small>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="provider-quota-empty">
            <span aria-hidden="true"><Gauge size={19} /></span>
            <p>
              {apiKey
                ? '在 Google AI Studio 查看用量与配额'
                : usageLoading
                ? '正在读取订阅额度…'
                : expired
                  ? '登录后刷新订阅用量'
                  : usage?.error
                    ? '用量暂不可用，请稍后刷新'
                    : signedIn
                      ? '当前客户端未提供订阅用量'
                      : '授权后读取客户端支持的用量信息'}
              <small>
                {apiKey ? <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">打开 Google AI Studio ↗</a> : usage?.error === 'network' ? '请检查网络连接' : '未读取到额度 · 重置时间未知'}
              </small>
            </p>
          </div>
        )}
      </div>
      <footer className="provider-account-footer">
        <span>
          {signedIn
            ? connected
              ? '单聊服务已连接'
              : '检测到本地凭据'
            : id === 'grok'
              ? '通过 Grok CLI 登录'
              : `通过 ${provider.cli} 登录`}
        </span>
        {signedIn ? (
          <button className="ws-button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={13} className={busy ? 'spinning' : ''} />
            刷新状态
          </button>
        ) : (
          <button
            className="ws-button provider-login-button"
            aria-label={`${provider.name} 授权登录`}
            onClick={onLogin}
          >
            <LogIn size={14} />
            授权登录
          </button>
        )}
      </footer>
    </section>
  )
}

