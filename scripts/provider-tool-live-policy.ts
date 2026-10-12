import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { RunPermission } from '../src/shared/runtime'

export const fixtureFiles = {
  'sum.mjs': `export function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}
`,
  'sum.test.mjs': `import assert from 'node:assert/strict'
import { sum } from './sum.mjs'
assert.equal(sum([]), 0)
assert.equal(sum([1, 2, 3]), 6)
assert.equal(sum([-5, 2]), -3)
assert.equal(sum([0.5, 1.25]), 1.75)
console.log('LOCAL_NODE_OK')
`
}

// Parse before executing generated code. TS inserts ASI semicolons, then token
// comparison permits harmless formatting/quote differences without new behavior.
function normalizedCode(source: string) {
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext
  }, reportDiagnostics: true })
  if (output.diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error))
    throw new Error('Generated verification file contains invalid syntax')
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, output.outputText)
  const tokens: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    tokens.push(`${token}:${scanner.getTokenValue() || scanner.getTokenText()}`)
  return tokens.join('\0')
}
export function validTarget(cwd: string, candidate: unknown) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) return false
  const resolved = path.resolve(cwd, candidate)
  if (path.dirname(resolved) !== path.resolve(cwd) || !Object.hasOwn(fixtureFiles, path.basename(resolved))) return false
  if (fs.existsSync(resolved) && (fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isFile())) return false
  return true
}
export function verifyFixtureFiles(cwd: string) {
  for (const [name, expected] of Object.entries(fixtureFiles)) {
    const file = path.join(cwd, name)
    if (!validTarget(cwd, file) || !fs.existsSync(file) || fs.statSync(file).size > 16384)
      throw new Error(`Missing or invalid acceptance file: ${name}`)
    if (normalizedCode(fs.readFileSync(file, 'utf8')) !== normalizedCode(expected))
      throw new Error(`Generated ${name} does not match the bounded verification fixture`)
  }
}
export function isNodeTestCommand(command: unknown) {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  // No shell operators, embedded scripts, redirection or additional arguments.
  if (/^(?:node(?:\.exe)?|"node(?:\.exe)?"|'node(?:\.exe)?')\s+(?:sum\.test\.mjs|\.\/sum\.test\.mjs|\.\\sum\.test\.mjs|"(?:\.\/|\.\\)?sum\.test\.mjs"|'(?:\.\/|\.\\)?sum\.test\.mjs')$/i.test(trimmed)) return true
  // Codex emits the official shell wrapper, even for an exact native command.
  // Accept only an existing PowerShell executable and one exact quoted command.
  const wrapper = /^"([^"\r\n]+[\\/](?:pwsh|powershell)\.exe)" -Command (?:'node sum\.test\.mjs'|"node sum\.test\.mjs")$/i.exec(trimmed)
  if (!wrapper) return false
  const shell = wrapper[1].replace(/\\+/g, '\\')
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const expectedRoots = [
    path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell'),
    ...(home ? [path.join(home, '.cache', 'codex-runtimes')] : [])
  ]
  return path.isAbsolute(shell) && fs.existsSync(shell) && fs.statSync(shell).isFile() &&
    expectedRoots.some((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(shell))
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
}
export function classifyPermission(permission: RunPermission, cwd: string): { allowed: boolean; category: string } {
  let detail: any
  try { detail = JSON.parse(permission.detail) } catch { return { allowed: false, category: 'unparseable_detail' } }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return { allowed: false, category: 'invalid_detail' }
  const command = detail.command ?? detail.operation?.command
  if (command !== undefined) {
    const declaredCwd = detail.cwd ?? detail.dir_path ?? detail.directory ?? detail.operation?.cwd
    if (declaredCwd !== undefined && (typeof declaredCwd !== 'string' || path.resolve(declaredCwd) !== path.resolve(cwd)))
      return { allowed: false, category: 'wrong_working_directory' }
    if (!isNodeTestCommand(command)) return { allowed: false, category: 'unapproved_command' }
    try { verifyFixtureFiles(cwd) } catch { return { allowed: false, category: 'unsafe_or_missing_test_files' } }
    return { allowed: true, category: 'bounded_node_test' }
  }
  if (detail.kind === 'execute' && isNodeTestCommand(detail.title) && Array.isArray(detail.content)) {
    const explanation = detail.content.find((entry: any) => entry?.type === 'content' && entry.content?.type === 'text')?.content?.text
    const directory = typeof explanation === 'string' ? /^\[(?:current working directory|in) (.+?)\]/.exec(explanation)?.[1] : undefined
    if (!directory || path.resolve(directory) !== path.resolve(cwd) || /\[background\]/.test(explanation))
      return { allowed: false, category: 'unknown_acp_working_directory' }
    if (detail.locations && (!Array.isArray(detail.locations) || !detail.locations.every((entry: any) => validTarget(cwd, entry?.path))))
      return { allowed: false, category: 'unbounded_acp_command_locations' }
    try { verifyFixtureFiles(cwd) } catch { return { allowed: false, category: 'unsafe_or_missing_test_files' } }
    return { allowed: true, category: 'bounded_acp_node_test' }
  }
  const changes = detail.operation?.changes
  if (Array.isArray(changes) && changes.length && changes.every((change: any) => validTarget(cwd, change?.path)) &&
      (!detail.grantRoot || path.resolve(detail.grantRoot) === path.resolve(cwd)))
    return { allowed: true, category: 'bounded_file_changes' }
  // ACP clients may omit rawInput and describe the proposed edit in content.
  if (detail.kind === 'edit' && Array.isArray(detail.content) && detail.content.length &&
      detail.content.every((entry: any) => entry?.type === 'diff' && validTarget(cwd, entry.path) &&
        typeof entry.newText === 'string' && typeof entry.oldText === 'string') &&
      (!detail.locations || (Array.isArray(detail.locations) && detail.locations.every((entry: any) => validTarget(cwd, entry?.path)))))
    return { allowed: true, category: 'bounded_acp_file_diff' }
  const target = detail.file_path ?? detail.path ?? detail.targetFile
  const tool = `${permission.title} ${detail.name || ''}`.toLowerCase()
  if (target && /write|edit|replace|patch/.test(tool) && validTarget(cwd, target))
    return { allowed: true, category: 'bounded_file_write' }
  return { allowed: false, category: 'unrecognized_operation' }
}
export function oneTimeApproval(permission: RunPermission) {
  return permission.options.find((option) => /^(?:accept|allow_once|allow-once|proceed_once|once)$/i.test(option.id)) ||
    permission.options.find((option) => !/always|persist|session|永久|始终/i.test(`${option.id} ${option.label}`) &&
      /allow once|allow this|允许本次|仅本次|本次允许/i.test(option.label))
}
