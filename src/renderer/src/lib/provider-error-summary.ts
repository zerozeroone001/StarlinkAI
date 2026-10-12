// Show an actionable category, never arbitrary client/IPC text. Errors can
// contain credentials, local paths, terminal output and JavaScript stacks.
export function providerErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/timed?\s*out|timeout|超时/i.test(message)) return '检测超时，请重试。'
  if (/unauthori[sz]ed|forbidden|\b40[13]\b|(?:token|auth).*?(?:expired|invalid)|授权.*?(?:过期|失效)|未授权|未登录/i.test(message))
    return '账号授权失效，请在模型与账号中重新登录。'
  if (/ENOENT|Get-Command|CommandNotFoundException|command not found|未找到.*客户端|无法找到.*客户端/i.test(message))
    return '未找到本机客户端，请在模型与账号中检查安装。'
  if (/EACCES|EPERM|permission denied|拒绝访问/i.test(message)) return '没有权限访问本机客户端，请检查安装权限。'
  if (/ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|fetch failed|network|网络|连接.*?(?:失败|中断|拒绝)/i.test(message))
    return '无法连接模型服务，请检查网络或代理后重试。'
  if (/\b429\b|rate.?limit|请求.*?频繁/i.test(message)) return '服务请求过于频繁，请稍后重试。'
  if (/\b50[0234]\b|service unavailable/i.test(message)) return '模型服务暂时不可用，请稍后重试。'
  return '本机客户端检测失败，请重试或检查账号设置。'
}
