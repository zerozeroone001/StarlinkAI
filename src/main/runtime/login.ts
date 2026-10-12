import { spawn } from 'node:child_process'
import type { ProviderId } from '../../shared/types'
import type { LoginSnapshot } from '../../shared/runtime'
import { commandFor, workspaceDir, safeError, geminiAccount } from './cli'
import { rpcFor, providerIds } from './providers'

const logins = new Map<
  ProviderId,
  { snapshot: LoginSnapshot; close: () => void; timer?: ReturnType<typeof setTimeout> }
>()
export async function login(provider: ProviderId): Promise<LoginSnapshot> {
  if (!providerIds.includes(provider)) throw new Error('未知的模型厂商')
  const existing = logins.get(provider)
  if (existing?.snapshot.status === 'pending') return existing.snapshot
  const snapshot: LoginSnapshot = {
    provider,
    status: 'pending',
    message: '等待官方客户端完成登录。若浏览器未自动打开，请使用下方登录地址或终端命令。'
  }
  const entry: {
    snapshot: LoginSnapshot
    close: () => void
    timer?: ReturnType<typeof setTimeout>
  } = { snapshot, close: () => {} }
  logins.set(provider, entry)
  const timer = setTimeout(() => {
    if (snapshot.status === 'pending') {
      snapshot.status = 'failed'
      snapshot.message = '登录等待超时，请重新发起授权'
      entry.close()
    }
  }, 600000)
  entry.timer = timer
  const finish = (error?: unknown) => {
    if (snapshot.status !== 'pending') return
    clearTimeout(timer)
    snapshot.status = error ? 'failed' : 'completed'
    snapshot.message = error ? safeError(error) : '官方客户端已完成登录，请刷新账号状态。'
    entry.close()
  }
  void (async () => {
    if (provider === 'claude') {
      const command = await commandFor(provider, ['auth', 'login', '--claudeai'])
      const child = spawn(command.file, command.args, {
        env: command.env,
        windowsHide: true,
        stdio: 'pipe'
      })
      entry.close = () => {
        child.stdin.end()
        child.kill()
      }
      const output = (data: Buffer) => {
        const url = data
          .toString()
          .match(/https:\/\/(?:claude\.ai|platform\.claude\.com)\/[^\s\x1b]+/)
        if (url) snapshot.url = url[0]
      }
      child.stdout.on('data', output)
      child.stderr.on('data', output)
      child.on('error', finish)
      child.on('exit', (code) => {
        if (snapshot.status === 'pending')
          finish(code === 0 ? undefined : new Error('Claude 登录未完成，请使用终端命令登录'))
      })
    } else {
      const { rpc } = await rpcFor(provider, workspaceDir())
      entry.close = () => rpc.close()
      if (snapshot.status !== 'pending') {
        rpc.close()
        return
      }
      rpc.on('closed', (error) => {
        if (snapshot.status === 'pending') finish(error)
      })
      if (provider === 'codex') {
        rpc.on('notification', (message) => {
          if (message?.method !== 'account/login/completed') return
          const params = message.params
          if (!params || typeof params !== 'object' || Array.isArray(params) ||
              typeof params.success !== 'boolean') {
            finish(new Error('官方客户端返回了无效的登录结果，请更新客户端后重试'))
            return
          }
          finish(params.success ? undefined : new Error(
            typeof params.error === 'string' && params.error ? params.error : '登录未完成'
          ))
        })
        const result = await rpc.request('account/login/start', { type: 'chatgpt' })
        if (typeof result.authUrl !== 'string' || new URL(result.authUrl).protocol !== 'https:')
          throw new Error('官方客户端未返回有效的 HTTPS 授权地址')
        snapshot.url = result.authUrl
      } else {
        await rpc.request(
          'authenticate',
          { methodId: provider === 'grok' ? 'grok.com' : geminiAccount().methodId },
          600000
        )
        finish()
      }
    }
  })().catch(finish)
  return snapshot
}
export async function loginStatus(provider: ProviderId) {
  return logins.get(provider)?.snapshot || null
}
export function closeLogins() {
  for (const e of logins.values()) {
    clearTimeout(e.timer)
    e.snapshot.status = 'failed'
    e.close()
  }
  logins.clear()
}
