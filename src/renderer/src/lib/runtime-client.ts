import type { RuntimeApi } from '@shared/runtime'
async function call<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/workspace/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Client': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'providers' ? 60000 : 20000)
  })
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('本机模型服务未启动，请重启预览服务')
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(data.error || '本机模型服务请求失败')
  return data.result
}
export const runtimeClient: RuntimeApi = {
  assistant: (scopeId) => window.grok?.workspace
    ? window.grok.workspace.assistant(scopeId) : call('assistant', { scopeId }),
  clearAssistant: (scopeId) => window.grok?.workspace
    ? window.grok.workspace.clearAssistant(scopeId) : call('clearAssistant', { scopeId }),
  updateAssistant: (scopeId, patch) => window.grok?.workspace
    ? window.grok.workspace.updateAssistant(scopeId, patch) : call('updateAssistant', { scopeId, patch }),
  saveMemory: (scopeId, input) => window.grok?.workspace
    ? window.grok.workspace.saveMemory(scopeId, input) : call('saveMemory', { scopeId, input }),
  forgetMemory: (scopeId, id) => window.grok?.workspace
    ? window.grok.workspace.forgetMemory(scopeId, id) : call('forgetMemory', { scopeId, id }),
  saveCommitment: (scopeId, input) => window.grok?.workspace
    ? window.grok.workspace.saveCommitment(scopeId, input) : call('saveCommitment', { scopeId, input }),
  deleteCommitment: (scopeId, id) => window.grok?.workspace
    ? window.grok.workspace.deleteCommitment(scopeId, id) : call('deleteCommitment', { scopeId, id }),
  prepareDirectory: (input) => window.grok?.workspace
    ? window.grok.workspace.prepareDirectory(input)
    : call('prepareDirectory', { input }),
  upload: (workspaceId, input, directory) => window.grok?.workspace
    ? window.grok.workspace.upload(workspaceId, input, directory)
    : call('upload', { workspaceId, input, directory }),
  media: (workspaceId, source, directory) => window.grok?.workspace
    ? window.grok.workspace.media(workspaceId, source, directory)
    : call('media', { workspaceId, source, directory }),
  skills: (workspaceId, directory) =>
    window.grok?.workspace
      ? window.grok.workspace.skills(workspaceId, directory)
      : call('skills', { workspaceId, directory }),
  readSkill: (workspaceId, path, directory) =>
    window.grok?.workspace
      ? window.grok.workspace.readSkill(workspaceId, path, directory)
      : call('readSkill', { workspaceId, path, directory }),
  createSkill: (workspaceId, input, directory) =>
    window.grok?.workspace
      ? window.grok.workspace.createSkill(workspaceId, input, directory)
      : call('createSkill', { workspaceId, input, directory }),
  toggleSkill: (workspaceId, name, disabled, directory) =>
    window.grok?.workspace
      ? window.grok.workspace.toggleSkill(workspaceId, name, disabled, directory)
      : call('toggleSkill', { workspaceId, name, disabled, directory }),
  providers: (refresh, ids) =>
    window.grok?.workspace
      ? window.grok.workspace.providers(refresh, ids)
      : call('providers', { refresh, ids }),
  start: (request) =>
    window.grok?.workspace ? window.grok.workspace.start(request) : call('start', request),
  run: (id) => (window.grok?.workspace ? window.grok.workspace.run(id) : call('run', { id })),
  cancel: (id) =>
    window.grok?.workspace ? window.grok.workspace.cancel(id) : call('cancel', { id }),
  permission: (id, permissionId, option) =>
    window.grok?.workspace
      ? window.grok.workspace.permission(id, permissionId, option)
      : call('permission', { id, permissionId, option }),
  login: (provider) =>
    window.grok?.workspace ? window.grok.workspace.login(provider) : call('login', { provider }),
  loginStatus: (provider) =>
    window.grok?.workspace
      ? window.grok.workspace.loginStatus(provider)
      : call('loginStatus', { provider })
}
