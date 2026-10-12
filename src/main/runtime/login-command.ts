import type { ProviderId } from '../../shared/types'

/** Copyable manual fallback; launching an Electron-hosted CLI needs Node mode. */
export function providerLoginCommand(provider: ProviderId, executable: string, args: string[], platform = process.platform): string {
  const words = [executable, ...args]
  if (platform === 'win32') {
    const command = `& ${words.map((word) => `'${word.replace(/'/g, "''")}'`).join(' ')}`
    if (provider !== 'gemini') return command
    // A script block alone does not isolate environment variables in PowerShell.
    // Restore the caller's setting even when login fails or is interrupted.
    return `& { $desktopPreviousNodeMode = $env:ELECTRON_RUN_AS_NODE; try { $env:ELECTRON_RUN_AS_NODE = '1'; ${command} } finally { if ($null -eq $desktopPreviousNodeMode) { Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $desktopPreviousNodeMode } } }`
  }
  const command = words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ')
  return provider === 'gemini' ? `ELECTRON_RUN_AS_NODE=1 ${command}` : command
}
