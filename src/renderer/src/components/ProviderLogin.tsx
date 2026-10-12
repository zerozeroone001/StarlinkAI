import { useEffect, useRef, useState } from 'react'
import { Copy, Info, LogIn, RefreshCw, Terminal } from 'lucide-react'
import type { LoginSnapshot } from '@shared/runtime'
import { PROVIDERS, type Provider } from '@/lib/collaboration-data'
import { runtimeClient } from '@/lib/runtime-client'
import { getProviderReadiness, inspectionForProvider } from '@/lib/provider-account'
import { providerErrorSummary } from '@/lib/provider-error-summary'
import { useProviders } from '@/stores/providers'
import { WorkspaceDialog } from './WorkspaceDialogs'
import { ProviderMark } from './ProviderMark'

export function ProviderLogin({ provider: id, close, onConnected }: { provider: Provider; close: () => void; onConnected?: (provider: Provider) => void }) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const provider = PROVIDERS[id]
  const inspection = useProviders()
  const { diagnostics, inspect } = inspection
  const { checking } = inspectionForProvider(inspection, id)
  const command = diagnostics.find((p) => p.id === id)?.loginCommand || provider.cli
  const [login, setLogin] = useState<LoginSnapshot | null>(null)
  const [message, setMessage] = useState('')
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    let active = true
    const update = async () => {
      try {
        const state = await runtimeClient.loginStatus(id)
        if (active && state) setLogin(state)
      } catch {
        /* preserve command fallback */
      }
    }
    void update()
    const timer = setInterval(() => void update(), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [id])
  return (
    <WorkspaceDialog
      title={'授权登录 ' + provider.name}
      subtitle="沿用官方客户端保存的账号或授权。"
      close={close}
    >
      <div className="provider-login-guide">
        <div className="provider-login-identity">
          <ProviderMark id={id} />
          <div>
            <strong>{provider.name}</strong>
            <span>{provider.description}</span>
          </div>
        </div>
        <p className="provider-login-preview">
          <Info size={15} />
          登录凭据由官方客户端保存。{id === 'gemini' ? '支持 Google 账号和 Google AI Studio API Key；配置后刷新即可。' : '完成授权后刷新账号状态。'}
        </p>
        <button
          className="ws-button accent"
          disabled={starting || login?.status === 'pending'}
          onClick={async () => {
            setStarting(true)
            setMessage('')
            try {
              setLogin(await runtimeClient.login(id))
            } catch (e) {
              setMessage(e instanceof Error ? e.message : '启动登录失败')
            } finally {
              setStarting(false)
            }
          }}
        >
          <LogIn size={14} />
          {starting ? '启动中…' : login?.status === 'pending' ? '等待官方登录…' : '启动授权登录'}
        </button>
        {login && <p role="status">{login.message}</p>}
        {login?.url && (
          <a className="ws-button" href={login.url} target="_blank" rel="noreferrer">
            打开官方授权页面 ↗
          </a>
        )}
        <p>也可以在本机 PowerShell 中运行以下命令，按客户端提示登录：</p>
        <div className="provider-login-command">
          <Terminal size={15} />
          <code>{command}</code>
          <button
            className="ws-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command)
                setMessage('登录命令已复制')
              } catch {
                setMessage('复制失败，请手动复制上方命令')
              }
            }}
          >
            <Copy size={13} />
            复制
          </button>
        </div>
        {message && (
          <p className="provider-login-feedback" role="status">
            {message}
          </p>
        )}
      </div>
      <footer>
        <button className="ws-button" onClick={close}>
          关闭
        </button>
        <button
          className="ws-button accent"
          disabled={checking}
          onClick={async () => {
            await inspect([id])
            if (!mounted.current) return
            const state = useProviders.getState()
            const p = state.diagnostics.find((p) => p.id === id)
            if (onConnected) {
              const status = inspectionForProvider(state, id)
              const readiness = getProviderReadiness(p, status)
              if (readiness.canRun) onConnected(id)
              else setMessage(status.error ? providerErrorSummary(status.error) : readiness.detail)
              return
            }
            setMessage(
              useProviders.getState().providerChecks[id]?.error || (p?.auth?.signedIn
                ? '已检测到授权，账号卡片已刷新。'
                : p?.error || '尚未检测到授权，请完成官方客户端授权后重试。')
            )
          }}
        >
          <RefreshCw size={13} className={checking ? 'spinning' : ''} />
          {checking ? '检测中…' : '已完成登录，刷新状态'}
        </button>
      </footer>
    </WorkspaceDialog>
  )
}
