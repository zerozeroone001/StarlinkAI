import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ProviderId } from '../../shared/types'
import type { Command } from './rpc'
import { resolveProjectDirectory } from '../project-directory'
import { assertUnlinkedPath, isPathWithin } from '../file-boundary'

const require = createRequire(import.meta.url)
const exec = promisify(execFile)
export const runtimeRoot = path.join(os.homedir(), '.grok', 'desktop', 'workspaces')
/** Host-owned assets keep their identity when the project source directory changes. */
export function managedAssetDirectory(scopeId: string, create = false): string | undefined {
  if (typeof scopeId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(scopeId))
    throw new Error('无效的资源空间编号')
  const home = assertUnlinkedPath(os.homedir())
  const target = path.join(runtimeRoot, scopeId)
  if (!isPathWithin(home, target)) throw new Error('资源目录不在应用目录中')
  let current = home
  for (const part of path.relative(home, target).split(path.sep).filter(Boolean)) {
    const parent = fs.statSync(current, { bigint: true })
    const next = path.join(current, part)
    if (create) {
      try { fs.mkdirSync(next) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    try {
      const stat = fs.lstatSync(next)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('资源目录包含链接或不是文件夹')
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    assertUnlinkedPath(next)
    const after = fs.statSync(current, { bigint: true })
    if (parent.dev !== after.dev || parent.ino !== after.ino) throw new Error('资源目录已变化，请重试')
    current = next
  }
  return assertUnlinkedPath(current)
}
export function workspaceDir(id = 'catalog', directory?: string) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new Error('无效的工作空间编号')
  if (directory !== undefined) return resolveProjectDirectory(directory)
  return managedAssetDirectory(id, true)!
}
export function subscriptionEnv(provider?: ProviderId, source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ELECTRON_RUN_AS_NODE: '1' }
  for (const key of Object.keys(env)) {
    // Windows resolves environment names without regard to case. Normalize the
    // supported Gemini keys, and strip every spelling of keys for other modes.
    const name = key.toUpperCase()
    if (name === 'ELECTRON_RUN_AS_NODE' && key !== name) {
      delete env[key]
      continue
    }
    if (provider === 'gemini' && /^(GEMINI_API_KEY|GOOGLE_API_KEY)$/.test(name)) {
      if (key !== name) {
        if (!env[name]) env[name] = env[key]
        delete env[key]
      }
      continue
    }
    if (
      /^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDECODE|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|XAI_API_KEY|GROK_API_KEY)$/.test(
        name
      )
    )
      delete env[key]
  }
  if (provider === 'gemini' && !env.GEMINI_API_KEY && env.GOOGLE_API_KEY)
    env.GEMINI_API_KEY = env.GOOGLE_API_KEY
  return env
}
// Desktop installs do not necessarily register their bundled CLI on PATH.
export function desktopCodexCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  if (!localAppData) return []
  const root = path.join(localAppData, 'OpenAI', 'Codex')
  const bin = path.join(root, 'bin')
  let versions: string[] = []
  try {
    versions = fs.readdirSync(bin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(bin, entry.name, 'codex.exe'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  } catch { /* desktop is optional */ }
  return [...versions, path.join(root, 'resources', 'codex.exe'), path.join(root, 'app', 'resources', 'codex.exe')]
}
export async function resolveWindowsCli(provider: 'codex' | 'grok'): Promise<string> {
  // Suppress localized shell diagnostics and explicitly emit UTF-8 paths.
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $p = Get-Command '${provider}.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Source }`
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 })
    const file = stdout.trim()
    if (file && fs.existsSync(file)) return file
  } catch { /* continue with native desktop locations */ }
  const candidates = provider === 'codex' ? desktopCodexCandidates() : []
  candidates.push(path.join(os.homedir(), `.${provider}`, 'bin', `${provider}.exe`))
  const found = candidates.find((file) => fs.existsSync(file))
  if (found) return found
  if (provider === 'codex') {
    try {
      const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-AppxPackage '*Codex*' -ErrorAction SilentlyContinue | ForEach-Object { $_.InstallLocation }`
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 })
      for (const root of stdout.trim().split(/\r?\n/).filter(Boolean)) {
        for (const relative of ['app/resources/codex.exe', 'resources/codex.exe']) {
          const file = path.join(root, relative)
          if (fs.existsSync(file)) return file
        }
      }
    } catch { /* no Store install */ }
  }
  throw new Error(provider === 'codex'
    ? '未找到 Codex 客户端。请安装或更新 Codex 桌面端，也可安装 Codex CLI 后刷新。'
    : '未找到 Grok CLI，请安装后刷新。')
}
function unpack(file: string) {
  return file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}
export function geminiEntry() {
  return unpack(require.resolve('@google/gemini-cli/bundle/gemini.js'))
}
export function claudeEntry() {
  const platform = `${process.platform}-${process.arch}`
  return unpack(
    require.resolve(
      `@anthropic-ai/claude-agent-sdk-${platform}/claude${process.platform === 'win32' ? '.exe' : ''}`
    )
  )
}
export async function commandFor(provider: ProviderId, args: string[] = []): Promise<Command> {
  if (provider === 'gemini')
    return { file: process.execPath, args: [geminiEntry(), ...args], env: subscriptionEnv('gemini') }
  if (provider === 'claude') return { file: claudeEntry(), args, env: subscriptionEnv() }
  let file: string = provider
  if (process.platform === 'win32') {
    file = await resolveWindowsCli(provider)
  }
  return { file, args, env: subscriptionEnv() }
}
export async function cliOutput(provider: ProviderId, args: string[]) {
  const cmd = await commandFor(provider, args)
  const { stdout } = await exec(cmd.file, cmd.args, {
    env: cmd.env,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 256 * 1024
  })
  return stdout.trim()
}
export function geminiAccount(root = path.join(os.homedir(), '.gemini'), env = process.env) {
  let selected: string | undefined
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
    selected = settings.security?.auth?.selectedType
  } catch { /* environment-only authentication is supported */ }
  const methodId = selected || (env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'gemini-api-key' : 'oauth-personal')
  const apiKey = methodId === 'gemini-api-key'
  const authSource = apiKey ? 'Google AI Studio · API Key' : 'Google OAuth（个人账号）'
  if (apiKey) {
    // The official CLI reads the OS credential store / .env and validates availability.
    // Selecting this method is not itself evidence of successful authentication.
    return { signedIn: false, email: null, methodId, canAuthenticate: true, authSource }
  }
  if (methodId !== 'oauth-personal')
    return { signedIn: false, email: null, methodId, canAuthenticate: false, authSource: '暂不支持的授权方式' }
  try {
    const hasCredentials = fs.existsSync(path.join(root, 'oauth_creds.json'))
    let email: string | null = null
    try {
      const account = JSON.parse(fs.readFileSync(path.join(root, 'google_accounts.json'), 'utf8'))
      email = typeof account.active === 'string' ? account.active : null
    } catch {
      /* optional metadata */
    }
    return { signedIn: hasCredentials, email, methodId, canAuthenticate: hasCredentials, authSource }
  } catch {
    return { signedIn: false, email: null, methodId, canAuthenticate: false, authSource }
  }
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Get-Command|CommandNotFoundException/.test(message))
    return '未找到客户端程序，请安装或更新官方客户端后刷新。'
  if (/\uFFFD/.test(message)) return '客户端返回了无法解码的错误信息，请刷新状态或更新客户端。'
  return message
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(
      /(Bearer\s+|(?:token|api[_ -]?key|secret)(?:\s+(?:provided|supplied|received|value))?["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[已隐藏]'
    )
    // Clients sometimes include a key directly in prose rather than a labelled
    // field. Redact recognized provider key formats before truncating errors.
    .replace(/\b(?:sk-[\w-]{8,}|xai-[\w-]{8,}|AIza[\w-]+)/g, '[已隐藏]')
    .slice(0, 700)
}
