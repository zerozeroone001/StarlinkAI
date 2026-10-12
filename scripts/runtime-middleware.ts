import type { Plugin } from 'vite'
import { runtime, closeRuntime } from '../src/main/runtime/service'
import { safeError } from '../src/main/runtime/cli'

export function isLocalWorkspaceRequest(headers: import('node:http').IncomingHttpHeaders, port: number) {
  const host = headers.host || ''
  return (host === `127.0.0.1:${port}` || host === `localhost:${port}`) &&
    (!headers.origin || headers.origin === `http://${host}`) &&
    !['cross-site', 'same-site'].includes(headers['sec-fetch-site'] as string)
}

export function runtimeMiddleware(): Plugin {
  return {
    name: 'local-subscription-runtime',
    configureServer(server) {
      server.httpServer?.once('close', () => { void closeRuntime().catch(() => {}) })
      server.middlewares.use('/api/workspace', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        const reply = (status: number, value: unknown) => {
          res.statusCode = status
          res.end(JSON.stringify(value))
        }
        // Local preview executes account-authenticated CLIs. Reject cross-origin/browser-form calls and DNS rebinding.
        const address = server.httpServer?.address()
        if (!address || typeof address === 'string' || !isLocalWorkspaceRequest(req.headers, address.port)) {
          reply(403, { error: '仅允许当前本机页面调用' })
          return
        }
        if (
          req.method !== 'POST' ||
          !req.headers['content-type']?.startsWith('application/json') ||
          req.headers['x-workspace-client'] !== '1'
        ) {
          reply(403, { error: '不支持的请求' })
          return
        }
        try {
          const method = req.url?.split('?')[0].replace(/^\//, '')
          const maxBytes = (method === 'start' ? 16 : method === 'upload' ? 12 : 2) * 1024 * 1024
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > maxBytes) {
              reply(413, { error: '请求内容超过大小限制' })
              return
            }
            chunks.push(chunk)
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          let result: unknown
          switch (method) {
            case 'assistant':
              result = await runtime.assistant(body.scopeId)
              break
            case 'clearAssistant':
              result = await runtime.clearAssistant(body.scopeId)
              break
            case 'updateAssistant':
              result = await runtime.updateAssistant(body.scopeId, body.patch)
              break
            case 'saveMemory':
              result = await runtime.saveMemory(body.scopeId, body.input)
              break
            case 'forgetMemory':
              result = await runtime.forgetMemory(body.scopeId, body.id)
              break
            case 'saveCommitment':
              result = await runtime.saveCommitment(body.scopeId, body.input)
              break
            case 'deleteCommitment':
              result = await runtime.deleteCommitment(body.scopeId, body.id)
              break
            case 'prepareDirectory':
              result = await runtime.prepareDirectory(body.input)
              break
            case 'upload':
              result = await runtime.upload(body.workspaceId, body.input, body.directory)
              break
            case 'media':
              result = await runtime.media(body.workspaceId, body.source, body.directory)
              break
            case 'skills':
              result = await runtime.skills(body.workspaceId, body.directory)
              break
            case 'readSkill':
              result = await runtime.readSkill(body.workspaceId, body.path, body.directory)
              break
            case 'createSkill':
              result = await runtime.createSkill(body.workspaceId, body.input, body.directory)
              break
            case 'toggleSkill':
              result = await runtime.toggleSkill(body.workspaceId, body.name, body.disabled, body.directory)
              break
            case 'providers':
              if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length > 4 || body.ids.some((id: unknown) => typeof id !== 'string' || !['claude', 'codex', 'grok', 'gemini'].includes(id))))
                throw new Error('未知模型提供商')
              result = await runtime.providers(!!body.refresh, body.ids)
              break
            case 'start':
              result = await runtime.start(body)
              break
            case 'run':
              result = await runtime.run(body.id)
              break
            case 'cancel':
              result = await runtime.cancel(body.id)
              break
            case 'permission':
              result = await runtime.permission(body.id, body.permissionId, body.option)
              break
            case 'login':
              result = await runtime.login(body.provider)
              break
            case 'loginStatus':
              result = await runtime.loginStatus(body.provider)
              break
            default:
              reply(404, { error: '未知接口' })
              return
          }
          reply(200, { result: result ?? null })
        } catch (error) {
          reply(400, { error: safeError(error) })
        }
      })
    }
  }
}
