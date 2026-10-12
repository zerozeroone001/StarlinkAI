import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProviderDiagnostic, ProviderId } from '../shared/types'
import { readAuth } from './auth'

const exec = promisify(execFile)
const ids: ProviderId[] = ['claude', 'codex', 'grok', 'gemini']
let pending: Promise<ProviderDiagnostic[]> | null = null

async function inspect(id: ProviderId): Promise<ProviderDiagnostic> {
  const result: ProviderDiagnostic = {
    id,
    cli: { state: 'error', version: null, path: null },
    auth: id === 'grok' ? readAuth() : null,
    checkedAt: new Date().toISOString()
  }
  // Only fixed executable names are accepted. No prompt, login, update or model call is run.
  try {
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $cmd = Get-Command '${id}' -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$cmd) { @{state='not_found';path=$null;version=$null} | ConvertTo-Json -Compress; exit 0 }; $p=$cmd.Source; try { $v=(& $p --version 2>$null | Out-String).Trim(); if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { $v=$null } } catch { $v=$null }; @{state='installed';path=$p;version=$v} | ConvertTo-Json -Compress`
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ],
        { windowsHide: true, timeout: 12000, maxBuffer: 16384 }
      )
      const data = JSON.parse(stdout.trim())
      result.cli = {
        state: data.state === 'not_found' ? 'not_found' : 'installed',
        path: typeof data.path === 'string' ? data.path : null,
        version:
          typeof data.version === 'string'
            ? data.version.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || null
            : null
      }
    } else {
      const { stdout } = await exec(id, ['--version'], { timeout: 12000, maxBuffer: 16384 })
      result.cli = {
        state: 'installed',
        path: id,
        version: stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || null
      }
    }
  } catch (error) {
    if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'ENOENT')
      result.cli.state = 'not_found'
  }
  result.checkedAt = new Date().toISOString()
  return result
}

export function inspectProviders(): Promise<ProviderDiagnostic[]> {
  if (!pending)
    pending = Promise.all(ids.map(inspect)).finally(() => {
      pending = null
    })
  return pending
}
