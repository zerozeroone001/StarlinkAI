import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { FileNode, GitFile, GitState } from '../shared/types'

function gitExecutable(): string {
  if (process.env.GIT_BIN) return process.env.GIT_BIN
  const extras = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\git.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe')
  ]
  for (const candidate of extras) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return 'git'
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const timer = setTimeout(() => { child.kill(); reject(new Error('Git 操作超时')) }, 15000)
    child.once('close', () => clearTimeout(timer))
    child.once('error', () => clearTimeout(timer))
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(err || `git ${args.join(' ')} exited ${code}`))
    })
  })
}

export async function gitState(cwd: string): Promise<GitState | null> {
  try {
    const [status, prefix, diff] = await Promise.all([
      runGit(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all', '--', '.']),
      runGit(cwd, ['rev-parse', '--show-prefix']),
      runGit(cwd, ['-c', 'core.quotePath=false', 'diff', '--relative', 'HEAD', '--', '.']).catch(async () => {
      // New repositories do not have HEAD yet, but staged additions still have a diff.
        return runGit(cwd, ['-c', 'core.quotePath=false', 'diff', '--relative', '--cached', '--', '.']).catch(() => '')
      })
    ])
    const lines = status.split('\0').filter(Boolean)
    const header = lines[0] || ''
    const branch = header.replace(/^##\s+(?:No commits yet on |Initial commit on )?/, '').split('...')[0].split(' [')[0]
    const ahead = Number(/ahead\s+(\d+)/.exec(header)?.[1] || 0)
    const behind = Number(/behind\s+(\d+)/.exec(header)?.[1] || 0)
    const files: GitFile[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const code = line.slice(0, 2)
      const filePath = path.posix.relative(prefix.replace(/\r?\n$/, ''), line.slice(3))
      // In NUL format the destination comes first, followed by a separate source path.
      if (/[RC]/.test(code)) i += 1
      files.push({
        path: filePath,
        status: code.trim() || 'M',
        staged: code[0] !== ' ' && code[0] !== '?'
      })
    }
    return {
      branch: branch || 'HEAD',
      ahead,
      behind,
      dirty: files.length > 0,
      files,
      diff
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return {
        branch: '',
        ahead: 0,
        behind: 0,
        dirty: false,
        files: [],
        diff: '',
        missing: true
      }
    }
    return null
  }
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.next',
  'coverage',
  '__pycache__'
])

export function fileTree(root: string, depth = 0): FileNode[] {
  function walk(dir: string, remaining: number): FileNode[] {
    if (remaining < 0) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const nodes: FileNode[] = []
    for (const entry of entries) {
      const name = entry.name
      if (SKIP.has(name)) continue
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        nodes.push({
          name,
          path: full,
          dir: true,
          ...(remaining > 0 ? { children: walk(full, remaining - 1) } : {})
        })
      } else {
        nodes.push({ name, path: full, dir: false })
      }
    }
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    return nodes
  }
  return walk(root, depth)
}

export function readTextFile(file: string, limit = 200_000): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(limit + 1)
    const size = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, Math.min(size, limit)).toString('utf8') + (size > limit ? '\n…' : '')
  } finally { fs.closeSync(fd) }
}
