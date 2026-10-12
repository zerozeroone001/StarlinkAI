import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok')
}

export function desktopStatePath(): string {
  return path.join(grokHome(), 'desktop', 'state.json')
}

export function findGrokBinary(): string | null {
  const candidates = [
    process.env.GROK_BIN,
    path.join(grokHome(), 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'),
    'grok'
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (candidate === 'grok') return candidate
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
