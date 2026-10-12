import { query, type EffortLevel, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import type { WorkspaceAttachment } from '../../shared/attachments'
import type { RuntimeEmployee, RunPermission } from '../../shared/runtime'
import { rpcFor } from './providers'
import { subscriptionEnv, cliOutput, geminiAccount, claudeEntry } from './cli'
import { readSubscriptionAuth } from '../auth'
import type { PermissionMode, SkillInfo } from '../../shared/types'
import { isAutomaticSkillUse, isRequestedImageTool } from './skill-policy'
import { createAcpToolTrace } from './acp-tool-trace'

export interface Execution {
  conversationOnly?: boolean
  permissionMode?: PermissionMode
  attachments?: WorkspaceAttachment[]
  employee: RuntimeEmployee
  cwd: string
  prompt: string
  instructions: string
  signal: AbortSignal
  skills?: SkillInfo[]
  userPrompt?: string
  hasImageContext?: boolean
  session?(sessionId: string): void
  media?(content: unknown): void
  receipt?(patch: Partial<import('../../shared/runtime').WorkReceipt>): void
  text(delta: string): void
  permission(title: string, detail: string, options: RunPermission['options']): Promise<string>
}
interface AdapterDependencies {
  query: typeof query
  rpcFor: typeof rpcFor
  cliOutput: typeof cliOutput
  claudeEntry: typeof claudeEntry
  readSubscriptionAuth: typeof readSubscriptionAuth
  geminiAccount: typeof geminiAccount
}
function recordToolTrace(
  report: Execution['receipt'],
  toolName: string,
  rawArgs: unknown,
  exitCode?: number
) {
  if (!report) return
  const lower = (toolName || '').toLowerCase()
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
  const fileCandidate = [args.file_path, args.path, args.targetFile, args.file, args.filename].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  )
  const cmdCandidate = [args.command, args.cmd, args.CommandLine].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  )
  if (cmdCandidate || /bash|shell|exec|command|terminal/i.test(lower)) {
    if (cmdCandidate) report({ commands: [{ command: cmdCandidate.slice(0, 300), exitCode }] })
    return
  }
  if (fileCandidate) {
    if (/write|edit|replace|create|patch|save|delete|remove/i.test(lower)) {
      report({ filesModified: [fileCandidate] })
    } else if (/read|view|cat|open|inspect/i.test(lower)) {
      report({ filesRead: [fileCandidate] })
    }
  }
}
export async function execute(input: Execution, dependencies: AdapterDependencies = {
  query, rpcFor, cliOutput, claudeEntry, readSubscriptionAuth, geminiAccount
}) {
  const { employee, cwd, prompt, instructions, signal } = input
  // Legacy "auto" means full access; "review" delegates to the provider's reviewer.
  const permissionMode = input.conversationOnly ? 'ask' : input.permissionMode || 'ask'
  const images = (input.attachments || []).filter((a) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime))
  signal.throwIfAborted()
  if (employee.provider === 'claude') {
    const auth = JSON.parse(await dependencies.cliOutput('claude', ['auth', 'status', '--json']))
    signal.throwIfAborted()
    if (!auth.loggedIn || auth.authMethod !== 'claude.ai')
      throw new Error('请先使用 Claude 订阅账号登录')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const q = dependencies.query({
      prompt: images.length ? (async function* (): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [
          { type: 'text', text: prompt },
          ...images.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const,
            media_type: a.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: fs.readFileSync(a.path).toString('base64') } }))
        ] } }
      })() : prompt,
      options: {
        cwd,
        pathToClaudeCodeExecutable: dependencies.claudeEntry(),
        model: employee.model,
        effort: employee.effort as EffortLevel | undefined,
        env: subscriptionEnv(),
        settingSources: [],
        ...(input.conversationOnly ? { tools: [], mcpServers: {}, plugins: [] } : { skills: input.skills?.map((s) => s.name) }),
        persistSession: false,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
        permissionMode: permissionMode === 'auto' ? 'bypassPermissions' : permissionMode === 'review' ? 'auto' : 'default',
        ...(permissionMode === 'auto' ? { allowDangerouslySkipPermissions: true, sandbox: { enabled: false } } : {}),
        abortController: controller,
        maxTurns: 30,
        canUseTool: async (toolName, args) => {
          if (input.conversationOnly) return { behavior: 'deny', message: '当前是纯聊天模式，不能执行工具操作。' }
          // A question still requires human input; full access cannot invent its answer.
          if (permissionMode === 'auto' && toolName !== 'AskUserQuestion')
            return { behavior: 'allow', updatedInput: args }
          if (isAutomaticSkillUse(toolName, args, input.skills || []) || isRequestedImageTool(toolName, args, input.userPrompt || '', input.hasImageContext))
            return { behavior: 'allow', updatedInput: args }
          const decision = await input.permission(
            `Claude · ${toolName}`,
            JSON.stringify(args, null, 2).slice(0, 12000),
            [
              { id: 'allow', label: '允许本次' },
              { id: 'deny', label: '拒绝' }
            ]
          )
          return decision === 'allow'
            ? { behavior: 'allow', updatedInput: args }
            : { behavior: 'deny', message: '用户拒绝了本次操作' }
        }
      }
    })
    let partial = false
    let completed = false
    const pendingTools = new Map<string, { name: string; input: unknown }>()
    const settledTools = new Set<string>()
    const streamingTools = new Map<number, { id: string; name: string; input: unknown; json?: string }>()
    const rememberTool = (id: string, name: string, args: unknown) => {
      if (!input.conversationOnly && !settledTools.has(id)) pendingTools.set(id, { name, input: args })
    }
    try {
      for await (const message of q) {
        signal.throwIfAborted()
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) continue
        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            partial = true
            input.text(event.delta.text)
          } else if (event.type === 'message_start') {
            streamingTools.clear()
          } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const tool = event.content_block
            streamingTools.set(event.index, { id: tool.id, name: tool.name, input: tool.input })
          } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const tool = streamingTools.get(event.index)
            if (tool) tool.json = (tool.json || '') + event.delta.partial_json
          } else if (event.type === 'content_block_stop') {
            const tool = streamingTools.get(event.index)
            if (tool) {
              // Some SDK streams omit the final assistant frame. Only cache complete inputs.
              try { rememberTool(tool.id, tool.name, tool.json === undefined ? tool.input : JSON.parse(tool.json)) }
              catch { /* A later complete assistant frame can supply the input. */ }
              streamingTools.delete(event.index)
            }
          }
        } else if (message.type === 'assistant') {
          if (message.session_id) input.session?.(message.session_id)
          input.media?.(message.message.content)
          for (const part of message.message.content) {
            if (part.type === 'tool_use') rememberTool(part.id, part.name, part.input)
          }
          if (!partial)
            for (const part of message.message.content)
              if (part.type === 'text') input.text(part.text)
          partial = false
        } else if (message.type === 'user') {
          input.media?.(message.message.content)
          if (Array.isArray(message.message.content)) for (const part of message.message.content) {
            if (part.type !== 'tool_result' || settledTools.has(part.tool_use_id)) continue
            const tool = pendingTools.get(part.tool_use_id)
            pendingTools.delete(part.tool_use_id)
            settledTools.add(part.tool_use_id)
            // A request, permission decision, or failed result does not prove execution succeeded.
            if (tool && !part.is_error) recordToolTrace(input.receipt, tool.name, tool.input)
          }
        } else if (message.type === 'result') {
          if (message.is_error) throw new Error('errors' in message ? message.errors.join('\n') : 'Claude 执行失败')
          completed = true
          if (message.session_id) input.session?.(message.session_id)
        }
      }
      if (!completed) throw new Error('Claude 未返回执行完成确认，已有结果已保留。')
    } finally {
      q.close()
      signal.removeEventListener('abort', abort)
    }
    return
  }
  const extra = input.conversationOnly && employee.provider === 'grok'
    ? ['--tools', '', '--deny', '*', '--no-subagents', '--disable-web-search'] : []
  const { rpc } = await dependencies.rpcFor(employee.provider, cwd, extra, signal, input.conversationOnly, permissionMode)
  const abort = () => rpc.close()
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const items = new Map<string, unknown>()
    const acpTools = createAcpToolTrace(employee.provider, input.receipt, input.media)
    let acpSessionId: string | undefined
    rpc.on('notification', (m: any) => {
      if (m.method === 'item/started' && m.params?.item?.id) {
        if (items.size > 100) items.clear()
        items.set(m.params.item.id, m.params.item)
      }
    })
    rpc.on('request', async (message: any) => {
      try {
        if (input.conversationOnly) {
          if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method))
            rpc.respond(message.id, { decision: 'decline' })
          else if (message.method === 'session/request_permission')
            rpc.respond(message.id, { outcome: { outcome: 'cancelled' } })
          else rpc.reject(message.id, '纯聊天不提供工具、文件操作或权限升级。')
          return
        }
        if (
          employee.provider === 'codex' &&
          ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
            message.method
          )
        ) {
          const p = message.params
          if (permissionMode === 'auto') {
            rpc.respond(message.id, { decision: 'accept' })
            return
          }
          const option = await input.permission(
            'GPT · 操作确认',
            JSON.stringify(
              {
                command: p.command,
                cwd: p.cwd,
                reason: p.reason,
                grantRoot: p.grantRoot,
                operation: items.get(p.itemId)
              },
              null,
              2
            ),
            [
              { id: 'accept', label: '允许本次' },
              { id: 'decline', label: '拒绝' }
            ]
          )
          rpc.respond(message.id, { decision: option })
        } else if (message.method === 'session/request_permission') {
          const p = message.params
          if (p.sessionId === acpSessionId && !input.conversationOnly) acpTools.permission(p.toolCall)
          const allow = p.options?.find((o: any) => o.kind === 'allow_once')
          const tool = p.toolCall?.rawInput?.name || p.toolCall?.title || ''
          const args = p.toolCall?.rawInput || {}
          if (allow && (permissionMode === 'auto' || isAutomaticSkillUse(tool, args, input.skills || []) || isRequestedImageTool(tool, args, input.userPrompt || '', input.hasImageContext))) {
            rpc.respond(message.id, { outcome: { outcome: 'selected', optionId: allow.optionId } })
            return
          }
          // Persistent approvals are deliberately not offered by this workspace.
          const options = p.options
            .filter((o: any) => ['allow_once', 'reject_once'].includes(o.kind))
            .map((o: any) => ({ id: o.optionId, label: o.name }))
          if (!options.length) {
            rpc.respond(message.id, { outcome: { outcome: 'cancelled' } })
            return
          }
          const optionId = await input.permission(
            p.toolCall?.title || '工具操作确认',
            JSON.stringify(p.toolCall?.rawInput || p.toolCall || {}, null, 2).slice(0, 12000),
            options
          )
          rpc.respond(message.id, { outcome: { outcome: 'selected', optionId } })
        } else rpc.reject(message.id, '工作空间未提供此客户端能力，请将所需信息作为消息返回。')
      } catch {
        rpc.reject(message.id, '操作已取消')
      }
    })
    if (employee.provider === 'codex') {
      const { account } = await rpc.request('account/read', { refreshToken: false })
      if (account?.type !== 'chatgpt') throw new Error('请先使用 ChatGPT 订阅登录 Codex')
      let conversationConfig: Record<string, unknown> | undefined
      if (input.conversationOnly) {
        const configured = await rpc.request('config/read', { includeLayers: false })
        const features: Record<string, boolean> = {}
        for (const feature of ['apps', 'multi_agent', 'shell_tool', 'unified_exec', 'plugins', 'hooks', 'browser_use', 'computer_use', 'image_generation'])
          features[feature] = false
        conversationConfig = {
          web_search: 'disabled', features,
          apps: { _default: { enabled: false } },
          // Overrides merge with the original TOML. config/read includes null defaults
          // (e.g. tool_timeout_sec) that cannot be round-tripped as TOML values.
          mcp_servers: Object.fromEntries(Object.keys(configured?.config?.mcp_servers || {}).map((name) => [
            name, { enabled: false }
          ]))
        }
      }
      const thread = await rpc.request('thread/start', {
        model: employee.model,
        modelProvider: 'openai',
        allowProviderModelFallback: false,
        cwd,
        approvalPolicy: input.conversationOnly || permissionMode === 'auto' ? 'never' : 'on-request',
        approvalsReviewer: permissionMode === 'review' ? 'auto_review' : 'user',
        sandbox: input.conversationOnly ? 'read-only' : permissionMode === 'auto' ? 'danger-full-access' : 'workspace-write',
        ...(conversationConfig ? { config: conversationConfig, dynamicTools: [], environments: [] } : {}),
        developerInstructions: instructions,
        ephemeral: true
      })
      input.session?.(thread.thread.id)
      let resolve!: () => void
      let reject!: (e: Error) => void
      const finished = new Promise<void>((a, b) => {
        resolve = a
        reject = b
      })
      // Attach a rejection handler before turn/start can fail or the process can close.
      void finished.catch(() => {})
      rpc.on('closed', reject)
      const streamed = new Set<string>()
      rpc.on('notification', (m: any) => {
        if (m.params?.threadId !== thread.thread.id) return
        if (m.method === 'item/completed') {
          input.media?.(m.params.item)
          const item = m.params.item
          if ((item?.type === 'commandExecution' || item?.command) && item.status !== 'declined') {
            recordToolTrace(input.receipt, 'commandExecution', { command: item.command }, item.exitCode)
          } else if (item?.type === 'fileChange' && item.status === 'completed' && Array.isArray(item.changes)) {
            for (const change of item.changes) {
              if (change?.path) recordToolTrace(input.receipt, 'fileChange_write', { path: change.path })
            }
          }
        }
        if (m.method === 'item/agentMessage/delta') {
          streamed.add(m.params.itemId)
          input.text(m.params.delta)
        }
        if (
          m.method === 'item/completed' &&
          m.params.item?.type === 'agentMessage' &&
          !streamed.has(m.params.item.id)
        )
          input.text(m.params.item.text)
        if (m.method === 'turn/completed') {
          const t = m.params.turn
          if (t.status === 'completed') resolve()
          else
            reject(
              new Error(
                t.error?.message || (t.status === 'interrupted' ? '执行已停止' : 'GPT 执行失败')
              )
            )
        }
      })
      await rpc.request('turn/start', {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: prompt, text_elements: [] }, ...images.map((a) => ({ type: 'localImage', path: a.path }))],
        ...(employee.effort ? { effort: employee.effort } : {})
      })
      await finished
    } else {
      if (employee.provider === 'grok' && !dependencies.readSubscriptionAuth().signedIn)
        throw new Error('Grok 订阅登录已失效，请重新授权')
      const gemini = employee.provider === 'gemini' ? dependencies.geminiAccount() : null
      if (gemini && !gemini.canAuthenticate)
        throw new Error('请在 Gemini CLI 中登录 Google 账号或配置 Google AI Studio API Key')
      await rpc.request(
        'authenticate',
        employee.provider === 'grok'
          ? { methodId: 'cached_token', _meta: { headless: true } }
          : { methodId: gemini!.methodId }
      )
      const session = await rpc.request('session/new', { cwd, mcpServers: [] })
      const sessionId = session.sessionId
      acpSessionId = sessionId
      input.session?.(sessionId)
      if (employee.model)
        await rpc.request('session/set_model', { sessionId, modelId: employee.model })
      if (employee.effort)
        await rpc.request('session/set_config_option', {
          sessionId,
          configId: 'reasoning_effort',
          value: employee.effort
        })
      rpc.on('notification', (m: any) => {
        if (m.method === 'session/update' && m.params?.sessionId === sessionId) {
          const update = m.params.update
          if (update?.sessionUpdate === 'agent_message_chunk') input.media?.(update.content)
          if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
            acpTools.update(update)
          }
        }
        if (
          m.method === 'session/update' &&
          m.params?.sessionId === sessionId &&
          m.params.update?.sessionUpdate === 'agent_message_chunk'
        ) {
          const c = m.params.update.content
          if (c?.type === 'text') input.text(c.text)
        }
      })
      const result = await rpc.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: `${instructions}\n\n${prompt}` }, ...images.map((a) => ({ type: 'image', mimeType: a.mime, data: fs.readFileSync(a.path).toString('base64') }))] },
        0 // Runtime owns a per-employee deadline that pauses while waiting for permission.
      )
      if (result?.stopReason !== 'end_turn') {
        const reasons: Record<string, string> = {
          cancelled: '客户端已停止执行',
          max_tokens: '已达到客户端输出长度上限，当前回复已保留',
          max_turn_requests: '已达到客户端轮次上限，当前回复已保留',
          refusal: '客户端拒绝了本次请求'
        }
        throw new Error(reasons[result?.stopReason] || `客户端未正常完成本轮：${result?.stopReason || '缺少完成确认'}`)
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await rpc.stop()
  }
}
