import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FilePreview, PreviewKind } from '../shared/types'
import { grokHome } from './paths'
import { sessionDir } from './sessions'
import { realFileWithin, readBoundedFile } from './file-boundary'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac'])
const MARKDOWN = new Set(['md', 'mdx', 'markdown'])
const JSON_EXT = new Set(['json', 'jsonc', 'json5'])
const PDF = new Set(['pdf'])
const TEXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'html',
  'htm',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'toml',
  'yaml',
  'yml',
  'xml',
  'svg',
  'sql',
  'txt',
  'log',
  'ini',
  'cfg',
  'conf',
  'env',
  'gitignore',
  'dockerignore',
  'editorconfig',
  'lock',
  'csv',
  'tsv',
  'vue',
  'svelte',
  'astro',
  'gradle',
  'properties',
  'rtf'
])

const LANG: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  mjs: 'JavaScript',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  json: 'JSON',
  jsonc: 'JSON',
  md: 'Markdown',
  mdx: 'MDX',
  toml: 'TOML',
  yml: 'YAML',
  yaml: 'YAML',
  sh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  xml: 'XML',
  svg: 'SVG'
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf'
}

function readHead(file: string, max: number): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = fs.readSync(fd, buf, 0, max, 0)
    return n === max ? buf : buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function formatPreview(file: string, extra: Partial<FilePreview> & { kind: PreviewKind; mime: string }): FilePreview {
  const name = path.basename(file)
  const ext = path.extname(file).replace(/^\./, '').toLowerCase() || name.replace(/^\./, '').toLowerCase()
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    size = 0
  }
  return {
    path: file,
    name,
    ext,
    size,
    language: LANG[ext],
    ...extra
  }
}

function normalizeFs(p: string): string {
  let clean = p.replace(/^['"]|['"]$/g, '').trim()
  if (/^file:/i.test(clean)) {
    try {
      clean = fileURLToPath(clean)
    } catch {
      return ''
    }
  }
  clean = clean.replace(/^\\\\\?\\/, '')
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(clean)) clean = clean.slice(1)
  return clean
}

function lookInDir(dir: string, clean: string, base: string): string | null {
  const rel = clean.replace(/[\\/]+/g, path.sep)
  for (const candidate of [
    path.join(dir, rel),
    path.join(dir, clean),
    path.join(dir, 'images', base),
    path.join(dir, 'videos', base),
    path.join(dir, base)
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function findNamedMedia(base: string): string | null {
  const root = path.join(grokHome(), 'sessions')
  if (!base || !fs.existsSync(root)) return null
  const hits: { file: string; mtime: number }[] = []
  const stack = [root]
  let steps = 0
  while (stack.length && steps < 8000) {
    steps += 1
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.name.toLowerCase() !== base.toLowerCase()) continue
      const parent = path.basename(dir).toLowerCase()
      if (parent !== 'images' && parent !== 'videos' && parent !== 'assets') continue
      try {
        hits.push({ file: full, mtime: fs.statSync(full).mtimeMs })
      } catch {
        /* skip */
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime)
  return hits[0]?.file || null
}

export function resolveMediaPath(file: string, cwd?: string, sessionId?: string, allowGlobalSearch = false): string | null {
  if (typeof file !== 'string' || !file || file.length > 32768 || file.includes('\0')) return null
  const clean = normalizeFs(file)
  if (!clean) return null
  const candidates = [clean]
  // Native filenames may contain literal # and % characters. Try them before URL-style fallbacks.
  // fileURLToPath already decoded file: URLs, so never decode those a second time.
  if (!/^file:/i.test(file.replace(/^['"]|['"]$/g, '').trim())) {
    candidates.push(clean.replace(/[?#].*$/, ''))
    for (const candidate of [...candidates]) {
      try { candidates.push(decodeURIComponent(candidate)) } catch { /* keep the literal path */ }
    }
  }
  const dir = sessionId && sessionId !== '__new__' ? sessionDir(sessionId, cwd || '') : null
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate
    if (allowGlobalSearch && !cwd && !sessionId && fs.existsSync(candidate)) return candidate
    const base = path.basename(candidate.replace(/\\/g, '/'))
    if (dir) {
      const hit = lookInDir(dir, candidate, base)
      if (hit) return hit
    }
    if (cwd) {
      const hit = lookInDir(cwd, candidate, base)
      if (hit) return hit
    }
    if (allowGlobalSearch && !cwd && !sessionId) {
      const hit = findNamedMedia(base)
      if (hit) return hit
    }
  }
  return null
}

/** Automatic reply media may read only its workspace or the selected CLI session. */
export function resolveScopedMediaPath(file: string, cwd?: string, sessionId?: string): string | null {
  const roots: string[] = []
  if (typeof cwd === 'string' && cwd) roots.push(cwd)
  if (typeof sessionId === 'string' && sessionId !== '__new__') {
    const directory = sessionDir(sessionId, cwd || '')
    if (directory) roots.push(directory)
  }
  if (!roots.length) return null
  const resolved = resolveMediaPath(file, cwd, sessionId)
  return resolved ? realFileWithin(resolved, roots) : null
}

export function inspectFile(file: string): FilePreview {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase()
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return formatPreview(file, {
      kind: 'binary',
      mime: 'application/octet-stream',
      error: err instanceof Error ? err.message : 'Unable to read file'
    })
  }
  if (!stat.isFile()) {
    return formatPreview(file, { kind: 'binary', mime: stat.isDirectory() ? 'inode/directory' : 'application/octet-stream',
      error: stat.isDirectory() ? 'This is a folder' : 'This is not a regular file' })
  }

  if (IMAGE.has(ext)) {
    if (stat.size > 32 * 1024 * 1024) {
      return formatPreview(file, {
        kind: 'image',
        mime: MIME[ext] || 'image/*',
        error: 'Image is larger than 32 MB. Open it in the system viewer.'
      })
    }
    const buf = readBoundedFile(file, 32 * 1024 * 1024)
    return formatPreview(file, {
      kind: 'image',
      mime: MIME[ext] || 'image/*',
      dataUrl: `data:${MIME[ext] || 'image/png'};base64,${buf.toString('base64')}`
    })
  }

  if (VIDEO.has(ext) || AUDIO.has(ext)) {
    const kind: PreviewKind = VIDEO.has(ext) ? 'video' : 'audio'
    if (stat.size > 24 * 1024 * 1024) {
      return formatPreview(file, {
        kind,
        mime: MIME[ext] || (kind === 'video' ? 'video/*' : 'audio/*'),
        error: 'Media is larger than 24 MB. Open it in the system viewer.'
      })
    }
    const buf = readBoundedFile(file, 24 * 1024 * 1024)
    const mime = MIME[ext] || (kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    return formatPreview(file, {
      kind,
      mime,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    })
  }

  if (PDF.has(ext)) {
    return formatPreview(file, {
      kind: 'pdf',
      mime: 'application/pdf'
    })
  }

  const TEXT_LIMIT = 400_000
  const buf = readHead(file, Math.min(stat.size, TEXT_LIMIT + 1))
  if (isBinary(buf) && !TEXT.has(ext) && !MARKDOWN.has(ext) && !JSON_EXT.has(ext)) {
    return formatPreview(file, {
      kind: 'binary',
      mime: 'application/octet-stream'
    })
  }

  let text = buf.subarray(0, TEXT_LIMIT).toString('utf8')
  const truncated = stat.size > TEXT_LIMIT
  if (truncated) text += '\n…'

  if (JSON_EXT.has(ext)) {
    try {
      text = JSON.stringify(JSON.parse(text.replace(/\n…$/, '')), null, 2)
    } catch {
      /* keep raw */
    }
    return formatPreview(file, { kind: 'json', mime: 'application/json', text, truncated, language: 'JSON' })
  }

  if (MARKDOWN.has(ext)) {
    return formatPreview(file, { kind: 'markdown', mime: 'text/markdown', text, truncated, language: 'Markdown' })
  }

  return formatPreview(file, {
    kind: 'text',
    mime: 'text/plain',
    text,
    truncated,
    language: LANG[ext] || ext.toUpperCase() || 'Text'
  })
}
