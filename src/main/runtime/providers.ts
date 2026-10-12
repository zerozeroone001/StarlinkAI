import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PermissionMode, ProviderId, UsageSnapshot } from '../../shared/types'
import type { RuntimeProvider, RuntimeModel } from '../../shared/runtime'
import { readSubscriptionAuth } from '../auth'
import { fetchUsage } from '../usage'
import { StdioRpc } from './rpc'
import { createProviderCatalog } from './provider-cache'
import { providerLoginCommand } from './login-command'
import {
  commandFor,
  cliOutput,
  geminiAccount,
  safeError,
  subscriptionEnv,
  workspaceDir,
  claudeEntry,
  geminiEntry
} from './cli'

export const providerIds: ProviderId[] = ['claude', 'codex', 'grok', 'gemini']
export function providerRuntimeArgs(
  id: ProviderId,
  extra: string[] = [],
  conversationOnly = false,
  permissionMode: PermissionMode = 'ask'
): string[] {
  const mode = conversationOnly ? 'ask' : permissionMode
  if (id === 'codex') return ['app-server', '-c', 'model_provider="openai"', ...extra]
  if (id === 'grok') return [
    '--permission-mode', mode === 'auto' ? 'bypassPermissions' : mode === 'review' ? 'auto' : 'default',
    ...(mode === 'auto' ? ['--sandbox', 'off'] : []),
    ...extra, 'agent', '--no-leader', 'stdio'
  ]
  // Gemini auto_edit only approves file edits; it is not an automatic reviewer.
  return ['--acp', '--approval-mode', mode === 'auto' ? 'yolo' : 'default',
    ...(mode === 'auto' ? ['--sandbox=false'] : []), ...extra]
}
export async function rpcFor(
  id: ProviderId,
  cwd: string,
  extra: string[] = [],
  signal?: AbortSignal,
  conversationOnly = false,
  permissionMode: PermissionMode = 'ask'
) {
  const args = providerRuntimeArgs(id, extra, conversationOnly, permissionMode)
  signal?.throwIfAborted()
  const command = await commandFor(id, args)
  if (!conversationOnly && id === 'gemini' && permissionMode === 'auto') {
    // GEMINI_SANDBOX takes precedence over --sandbox, so override it for this child only.
    command.env = { ...command.env, GEMINI_SANDBOX: 'false' }
  }
  signal?.throwIfAborted()
  let settingsDirectory: string | undefined
  if (conversationOnly && id === 'gemini') {
    settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-chat-settings-'))
    const settingsFile = path.join(settingsDirectory, 'settings.json')
    try { await fs.writeFile(settingsFile, JSON.stringify({
      tools: { core: [], discoveryCommand: '', callCommand: '' },
      hooksConfig: { enabled: false },
      admin: { extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
      skills: { enabled: false }
    }), { mode: 0o600 }) }
    catch (error) { await fs.rm(settingsDirectory, { recursive: true, force: true }); throw error }
    command.env = { ...command.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile }
  }
  const cleanup = () => {
    if (settingsDirectory) void fs.rm(settingsDirectory, { recursive: true, force: true }).catch(() => {})
  }
  if (signal?.aborted) { cleanup(); signal.throwIfAborted() }
  let rpc: StdioRpc
  try { rpc = new StdioRpc(command, cwd) }
  catch (error) { cleanup(); throw error }
  rpc.once('closed', cleanup)
  const abort = () => rpc.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const init = await rpc.request(
      'initialize',
      id === 'codex'
        ? {
            clientInfo: { name: 'starlinkai', title: 'StarlinkAI', version: '0.1.5' },
            capabilities: { experimentalApi: true }
          }
        : {
            protocolVersion: 1,
            clientInfo: { name: 'starlinkai', version: '0.1.5' },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false
            }
          }
    )
    if (id === 'codex') rpc.notify('initialized')
    signal?.throwIfAborted()
    return { rpc, init }
  } catch (error) {
    rpc.close()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
export function acpModels(models: any): RuntimeModel[] {
  return (models?.availableModels || [])
    .map((m: any) => ({
      id: m.modelId,
      name: m.name || m.modelId,
      description: m.description,
      efforts: (m._meta?.reasoningEfforts || []).map((e: any) => e.value || e.id),
      defaultEffort: m._meta?.reasoningEfforts?.find((e: any) => e.default)?.value,
      isDefault: m.modelId === models.currentModelId
    }))
    .filter((m: RuntimeModel) => typeof m.id === 'string')
}
async function inspect(id: ProviderId): Promise<RuntimeProvider> {
  const value: RuntimeProvider = {
    id,
    cli: { state: 'error', version: null, path: null },
    auth: { signedIn: false, email: null, name: null, userId: null },
    checkedAt: new Date().toISOString(),
    models: [],
    usage: null,
    loginCommand: id
  }
  let rpc: StdioRpc | undefined
  try {
    const cmd = await commandFor(id)
    value.cli = {
      state: 'installed',
      path: id === 'gemini' ? geminiEntry() : cmd.file,
      version: null
    }
    value.loginCommand = providerLoginCommand(id, cmd.file, id === 'gemini' ? cmd.args :
      id === 'claude' ? ['auth', 'login', '--claudeai'] : id === 'codex' ? ['login'] : [])
    if (id === 'claude') {
      value.cli.version =
        (await cliOutput(id, ['--version'])).match(/[\d]+\.[\d]+\.[\d]+/)?.[0] || null
      const auth = JSON.parse(await cliOutput(id, ['auth', 'status', '--json']).catch(() => '{}'))
      value.auth = {
        signedIn: !!auth.loggedIn && auth.authMethod === 'claude.ai',
        email: auth.email || null,
        name: null,
        userId: null
      }
      value.authSource = auth.authMethod || 'Claude 订阅登录'
      value.usage = { plan: auth.subscriptionType || null, windows: [], fetchedAt: value.checkedAt }
      let release!: () => void
      const waiting = new Promise<void>((r) => {
        release = r
      })
      async function* input(): AsyncGenerator<any> {
        await waiting
      }
      const q = query({
        prompt: input(),
        options: {
          cwd: workspaceDir(),
          pathToClaudeCodeExecutable: claudeEntry(),
          env: subscriptionEnv(),
          settingSources: [],
          tools: [],
          persistSession: false
        }
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const init = await Promise.race([
          q.initializationResult(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Claude 模型目录读取超时')), 25000)
          })
        ])
        value.models = init.models.map((m) => ({
          id: m.value,
          name: m.displayName,
          description: m.description,
          resolvedModel: m.resolvedModel,
          efforts: m.supportedEffortLevels || [],
          isDefault: m.value === 'default'
        }))
      } finally {
        clearTimeout(timer)
        q.close()
        release()
      }
    } else {
      const result = await rpcFor(id, workspaceDir())
      rpc = result.rpc
      value.cli.version = result.init._meta?.agentVersion || result.init.agentInfo?.version || null
      if (id === 'codex') {
        value.cli.version = (await cliOutput(id, ['--version']).catch(() => '')).match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || null
        // Read identity before the model catalog: catalog/network failures must not sign users out.
        const { account } = await rpc.request('account/read', { refreshToken: false })
        value.auth = {
          signedIn: account?.type === 'chatgpt',
          email: account?.email || null,
          name: null,
          userId: null
        }
        value.authSource = account?.type === 'chatgpt' ? 'ChatGPT · Codex 本地登录' : account?.type || 'ChatGPT 订阅登录'
        value.usage = { plan: account?.planType || null, fetchedAt: value.checkedAt, windows: [] }
        const models: RuntimeModel[] = []
        let cursor: string | undefined
        do {
          const page = await rpc.request('model/list', {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {})
          })
          models.push(
            ...page.data.map((m: any) => ({
              id: m.id,
              name: m.displayName,
              description: m.description,
              efforts: m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort),
              defaultEffort: m.defaultReasoningEffort,
              isDefault: m.isDefault
            }))
          )
          cursor = page.nextCursor || undefined
        } while (cursor && models.length < 500)
        value.models = models
        if (value.auth.signedIn) {
          try {
            const limits = await rpc.request('account/rateLimits/read', {})
            const buckets = limits.rateLimitsByLimitId
              ? Object.values(limits.rateLimitsByLimitId)
              : [limits.rateLimits]
            for (const b of buckets as any[])
              for (const key of ['primary', 'secondary']) {
                const w = b?.[key]
                if (!w) continue
                value.usage.windows.push({
                  id: `${b.limitId || 'codex'}-${key}`,
                  label: `${b.limitName || b.limitId || 'Codex'} · ${w.windowDurationMins >= 1440 ? `${w.windowDurationMins / 1440} 天` : `${w.windowDurationMins / 60} 小时`}`,
                  kind: 'unknown',
                  usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null,
                  used: null,
                  limit: null,
                  remaining: null,
                  resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null
                })
              }
          } catch {
            value.usage.error = 'network'
          }
        }
      } else if (id === 'grok') {
        value.models = acpModels(result.init._meta?.modelState)
        value.auth = readSubscriptionAuth()
        value.authSource = 'Grok CLI 订阅登录'
        if (value.auth.signedIn) {
          await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
          value.usage = await fetchUsage()
          if (value.usage.error === 'signed_out' || value.usage.error === 'auth')
            value.auth.signedIn = false
        }
      } else {
        const account = geminiAccount()
        value.auth = { signedIn: false, email: account.email, name: null, userId: null }
        value.authSource = account.authSource
        if (account.canAuthenticate) {
          await rpc.request('authenticate', { methodId: account.methodId })
          value.auth.signedIn = true
          const session = await rpc.request('session/new', { cwd: workspaceDir(), mcpServers: [] })
          value.models = acpModels(session.models)
        } else value.error = '请在 Gemini CLI 中登录 Google 账号或配置 Google AI Studio API Key，然后刷新。'
      }
    }
  } catch (error) {
    value.error = safeError(error)
    if (!value.cli.path) value.cli.state = 'not_found'
  } finally {
    rpc?.close()
  }
  return value
}
export const providers = createProviderCatalog(inspect, providerIds)
