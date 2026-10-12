import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CreateSkillResult, SkillInfo, SkillScope, SkillSource } from '../shared/types'
import { grokHome } from './paths'
import { loadDesktopState, patchPrefs } from './desktop-state'
import { ensureDirectoryWithin, readBoundedFile } from './file-boundary'

const SKIP_NAMES = new Set(['shell', 'canvas', 'statusline'])
const SKILL_FILE = /^skill\.md$/i
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function isInside(root: string, file: string): boolean {
  const a = path.resolve(root).toLowerCase()
  const b = path.resolve(file).toLowerCase()
  return b === a || b.startsWith(a + path.sep.toLowerCase()) || b.startsWith(a + '\\') || b.startsWith(a + '/')
}

function repoRoot(cwd: string): string {
  let dir = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

function ancestors(cwd: string): string[] {
  const out: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    out.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

function parseTomlSection(text: string, name: string): string {
  const re = new RegExp(`^\\[${name}\\]\\s*$`, 'm')
  const start = text.search(re)
  if (start < 0) return ''
  const rest = text.slice(start)
  const next = rest.search(/\n\[/)
  return next >= 0 ? rest.slice(0, next) : rest
}

function parseStringArray(section: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm')
  const m = section.match(re)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

function skillsConfig(): { paths: string[]; ignore: string[]; disabled: string[] } {
  const file = path.join(grokHome(), 'config.toml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { paths: [], ignore: [], disabled: [] }
  }
  const section = parseTomlSection(text, 'skills')
  return {
    paths: parseStringArray(section, 'paths').map(expandHome),
    ignore: parseStringArray(section, 'ignore').map(expandHome),
    disabled: parseStringArray(section, 'disabled')
  }
}

function writeDisabled(names: string[]): void {
  const file = path.join(grokHome(), 'config.toml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  const line = `disabled = [${names.map((n) => JSON.stringify(n)).join(', ')}]`
  const start = text.search(/^\[skills\]/m)
  if (start < 0) {
    text = `${text.trimEnd()}\n\n[skills]\n${line}\n`
  } else {
    const after = text.slice(start)
    const endRel = after.search(/\n\[/)
    const section = endRel >= 0 ? after.slice(0, endRel) : after
    const rest = endRel >= 0 ? after.slice(endRel) : ''
    let nextSection: string
    if (/^\s*disabled\s*=/m.test(section)) {
      nextSection = section.replace(/^\s*disabled\s*=\s*\[[^\]]*\][^\n]*/m, line)
    } else {
      nextSection = section.replace(/^\[skills\][ \t]*/m, `[skills]\n${line}`)
    }
    text = text.slice(0, start) + nextSection + rest
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
}

function parseFrontmatter(text: string): { data: Record<string, string | boolean>; body: string } {
  const norm = text.replace(/^\uFEFF/, '')
  if (!norm.startsWith('---')) return { data: {}, body: norm }
  const nl = norm.indexOf('\n---', 3)
  if (nl < 0) return { data: {}, body: norm }
  const raw = norm.slice(4, nl).replace(/^\r?\n/, '')
  const body = norm.slice(nl + 4).replace(/^\r?\n/, '')
  const data: Record<string, string | boolean> = {}
  let pending: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (!pending) return
    data[pending] = buf.join('\n').trim()
    pending = null
    buf = []
  }
  for (const line of raw.split(/\r?\n/)) {
    const folded = line.match(/^([A-Za-z0-9_-]+)\s*:\s*[>|][+-]?\s*$/)
    if (folded) {
      flush()
      pending = folded[1].toLowerCase()
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (kv && !/^\s/.test(line)) {
      flush()
      const key = kv[1].toLowerCase()
      let value = kv[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      data[key] = value === 'true' ? true : value === 'false' ? false : value
      continue
    }
    if (pending && /^\s/.test(line)) buf.push(line.trim())
  }
  flush()
  return { data, body }
}

function firstParagraph(body: string): string {
  return (
    body
      .replace(/^#.+$/m, '')
      .trim()
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280) || ''
  )
}

function normalizeName(raw: string, fallback: string): string {
  const n = (raw || fallback)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
  return n.slice(0, 64)
}

function collectSkillFiles(root: string, maxDepth = 5): string[] {
  const files: string[] = []
  if (!fs.existsSync(root)) return files
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const skill = entries.find((e) => e.isFile() && SKILL_FILE.test(e.name))
    if (skill) {
      files.push(path.join(dir, skill.name))
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(path.join(dir, entry.name), depth + 1)
    }
  }
  walk(root, 0)
  return files
}

function collectCommandFiles(root: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(root)) return files
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    if (entry.name.toLowerCase() === 'readme.md') continue
    if (SKILL_FILE.test(entry.name)) continue
    files.push(path.join(root, entry.name))
  }
  return files
}

function readSkillFile(
  file: string,
  source: SkillSource,
  disabled: Set<string>,
  includeBody = false
): SkillInfo | null {
  let text = ''
  try {
    text = readBoundedFile(file, 1024 * 1024).toString('utf8')
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(text)
  const dir = path.dirname(file)
  const fallback = path.basename(file).toLowerCase() === 'skill.md' ? path.basename(dir) : path.basename(file, path.extname(file))
  const name = normalizeName(String(data.name || ''), fallback)
  if (!name || SKIP_NAMES.has(name)) return null
  const description =
    String(data.description || data['when-to-use'] || '').trim() || firstParagraph(body)
  const descriptionZh = String(
    data['description-zh'] || data['description_zh'] || data['descriptionzh'] || ''
  ).trim()
  const userInvocable = data['user-invocable'] === false ? false : true
  const argumentHint = String(data['argument-hint'] || '').trim() || undefined
  return {
    name,
    description,
    descriptionZh: descriptionZh || undefined,
    path: file,
    dir,
    source,
    userInvocable,
    disabled: disabled.has(name),
    argumentHint,
    body: includeBody ? body.trim() : undefined
  }
}

function disabledSet(): Set<string> {
  const fromToml = skillsConfig().disabled
  const fromPrefs = loadDesktopState().disabledSkills || []
  return new Set([...fromToml, ...fromPrefs])
}

function sourceFor(file: string, cwd: string, root: string): SkillSource {
  const home = grokHome()
  if (isInside(path.join(home, 'bundled'), file)) return 'bundled'
  if (isInside(path.join(home, 'skills'), file) || isInside(path.join(home, 'commands'), file)) {
    return 'user'
  }
  const localRoots = ['.grok', '.agents']
  const cwdSkills = localRoots.some((n) => isInside(path.join(cwd, n), file))
  if (cwdSkills && path.resolve(cwd) !== path.resolve(root)) return 'local'
  if (isInside(path.join(root, '.grok'), file) || isInside(path.join(root, '.agents'), file)) return 'repo'
  if (cwdSkills) return 'local'
  return 'compat'
}

function scanRoots(cwd?: string): SkillInfo[] {
  const work = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : ''
  const root = work ? repoRoot(work) : ''
  const cfg = skillsConfig()
  const disabled = disabledSet()
  const ignore = cfg.ignore.map((p) => path.resolve(expandHome(p)))
  const skipped = (file: string) => ignore.some((p) => isInside(p, file))

  const ranked: { file: string; source: SkillSource }[] = []
  const addDir = (dir: string, source: SkillSource, commands = false) => {
    const files = commands ? collectCommandFiles(dir) : collectSkillFiles(dir)
    for (const file of files) {
      if (skipped(file)) continue
      ranked.push({ file, source })
    }
  }

  if (work) {
    for (const dir of ancestors(work)) {
      if (root && !isInside(root, dir) && dir !== root) continue
      const src = sourceFor(path.join(dir, '.grok', 'skills', 'x'), work, root || work)
      addDir(path.join(dir, '.grok', 'skills'), src)
      addDir(path.join(dir, '.grok', 'commands'), src, true)
      addDir(path.join(dir, '.agents', 'skills'), src)
      addDir(path.join(dir, '.agents', 'commands'), src, true)
      addDir(path.join(dir, '.claude', 'skills'), 'compat')
      addDir(path.join(dir, '.claude', 'commands'), 'compat', true)
      addDir(path.join(dir, '.cursor', 'skills'), 'compat')
    }
  }

  const home = grokHome()
  addDir(path.join(home, 'skills'), 'user')
  addDir(path.join(home, 'commands'), 'user', true)
  addDir(path.join(os.homedir(), '.claude', 'skills'), 'compat')
  addDir(path.join(os.homedir(), '.claude', 'commands'), 'compat', true)
  addDir(path.join(os.homedir(), '.cursor', 'skills'), 'compat')
  addDir(path.join(home, 'bundled', 'skills'), 'bundled')

  for (const extra of cfg.paths) {
    const resolved = path.resolve(expandHome(extra))
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      ranked.push({ file: resolved, source: 'user' })
    } else {
      addDir(resolved, 'user')
    }
  }

  const byName = new Map<string, SkillInfo>()
  for (const item of ranked) {
    const skill = readSkillFile(item.file, item.source, disabled)
    if (!skill) continue
    if (byName.has(skill.name)) continue
    byName.set(skill.name, skill)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function listSkills(cwd?: string): SkillInfo[] {
  return scanRoots(cwd)
}

export function readSkill(file: string): SkillInfo | null {
  if (!file) return null
  return readSkillFile(file, 'user', disabledSet(), true)
}

export function setSkillDisabled(name: string, disabled: boolean, cwd?: string): SkillInfo[] {
  const current = new Set(disabledSet())
  if (disabled) current.add(name)
  else current.delete(name)
  const names = [...current].sort()
  patchPrefs({ disabledSkills: names })
  try {
    writeDisabled(names)
  } catch {
    /* config.toml is best-effort so the agent honors the list */
  }
  return listSkills(cwd)
}

export function validSkillName(name: string): boolean {
  return NAME_RE.test(name) && name.length >= 2 && name.length <= 64
}

function titleFromName(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ')
}

export function createSkill(input: {
  name: string
  description: string
  scope: SkillScope
  cwd?: string
}): CreateSkillResult {
  if (!input || typeof input.name !== 'string' || input.name.length > 64 ||
    typeof input.description !== 'string' || input.description.length > 2000 ||
    !['user', 'project'].includes(input.scope)) return { ok: false, error: 'invalid_name' }
  const name = normalizeName(input.name, '')
  if (!validSkillName(name)) return { ok: false, error: 'invalid_name' }
  const description = (input.description || '').trim() || `Reusable workflow for /${name}. Use when the user asks for /${name}.`
  let anchor: string, relative: string
  if (input.scope === 'user') {
    anchor = grokHome()
    relative = path.join('skills', name)
  } else {
    const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : ''
    if (!cwd) return { ok: false, error: 'no_project' }
    anchor = repoRoot(cwd)
    relative = path.join('.grok', 'skills', name)
  }
  let root: string
  try {
    if (input.scope === 'user') fs.mkdirSync(anchor, { recursive: true })
    root = ensureDirectoryWithin(anchor, relative)
  } catch { return { ok: false, error: 'write_failed' } }
  const file = path.join(root, 'SKILL.md')
  if (fs.existsSync(file)) return { ok: false, error: 'exists' }
  const title = titleFromName(name)
  const md = `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${title}

${description}

## Steps

1. Restate the goal in one sentence
2. Inspect the current workspace
3. Follow the procedure for this skill
4. Summarize what changed
`
  try {
    fs.writeFileSync(file, md, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: 'exists' }
    return { ok: false, error: 'write_failed' }
  }
  const skills = listSkills(input.cwd)
  const skill = skills.find((s) => s.name === name) || readSkillFile(file, input.scope === 'user' ? 'user' : 'repo', disabledSet())
  if (!skill) return { ok: false, error: 'write_failed' }
  return { ok: true, skill, skills }
}

export function desktopStateSkills(): string[] {
  return loadDesktopState().disabledSkills || []
}
