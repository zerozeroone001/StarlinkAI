import fs from 'node:fs'
import path from 'node:path'
import type { RunPermission } from '../src/shared/runtime'
import { isNodeTestCommand, oneTimeApproval } from './provider-tool-live-policy'

export { oneTimeApproval }
export const fixtureName = 'cancel-fixture.mjs'
export const fixtureLifetime = 10000
export const heartbeatPeriod = 200
export function fixtureSource(nonce: string, lifetime = fixtureLifetime) {
  if (!/^[\w-]+$/.test(nonce) || !Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 10000)
    throw new Error('Invalid isolated fixture parameters')
  return `import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const directory = path.dirname(fileURLToPath(import.meta.url))
if (path.resolve(process.cwd()) !== directory) throw new Error('Fixture directory mismatch')
const nonce = '${nonce}'
const startedAt = Date.now()
fs.writeFileSync('started.json', JSON.stringify({ nonce, pid: process.pid, startedAt }), { flag: 'wx' })
let sequence = 0
const beat = () => fs.appendFileSync('heartbeat.log', JSON.stringify({ nonce, sequence: ++sequence, at: Date.now() }) + '\\n')
beat()
const timer = setInterval(beat, ${heartbeatPeriod})
setTimeout(() => {
  clearInterval(timer)
  fs.writeFileSync('completed.json', JSON.stringify({ nonce, sequence, at: Date.now() }), { flag: 'wx' })
  console.log('CANCEL_FIXTURE_COMPLETED')
}, ${lifetime})
`
}
export function verifyFixture(cwd: string, expected: string) {
  if (fs.lstatSync(cwd).isSymbolicLink() || !fs.lstatSync(cwd).isDirectory()) throw new Error('Unsafe fixture directory')
  const file = path.join(cwd, fixtureName)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || fs.readFileSync(file, 'utf8') !== expected)
    throw new Error('The known cancellation fixture was modified')
  for (const name of ['started.json', 'heartbeat.log', 'completed.json']) {
    const output = path.join(cwd, name)
    if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || !fs.lstatSync(output).isFile()))
      throw new Error('Unsafe fixture output')
  }
}
export function isCancelCommand(value: unknown) {
  if (typeof value !== 'string' || !value.includes(fixtureName) || value.includes('sum.test.mjs')) return false
  // Reuse the previously tested exact Node/official PowerShell grammar, with
  // only its literal fixture filename substituted. Operators stay forbidden.
  return isNodeTestCommand(value.replaceAll(fixtureName, 'sum.test.mjs'))
}
export function classifyCancelPermission(permission: RunPermission, cwd: string, expected: string) {
  const reject = (reason: string) => ({ allowed: false, reason })
  let data: any
  try { data = JSON.parse(permission.detail) } catch { return reject('unparseable_detail') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reject('invalid_detail')
  const command = data.command ?? data.operation?.command
  if (command !== undefined) {
    if (!isCancelCommand(command)) return reject('unapproved_command')
    const declaredCwd = data.cwd ?? data.dir_path ?? data.directory ?? data.operation?.cwd
    if (typeof declaredCwd !== 'string' || path.resolve(declaredCwd) !== path.resolve(cwd)) return reject('wrong_working_directory')
    if (data.operation?.changes || data.grantRoot) return reject('unexpected_file_or_scope_grant')
  } else if (data.kind === 'execute' && isCancelCommand(data.title) && Array.isArray(data.content)) {
    const explanation = data.content.find((entry: any) => entry?.type === 'content' && entry.content?.type === 'text')?.content?.text
    const declaredCwd = typeof explanation === 'string' ? /^\[(?:current working directory|in) (.+?)\]/.exec(explanation)?.[1] : undefined
    if (!declaredCwd || path.resolve(declaredCwd) !== path.resolve(cwd) || /\[background\]/.test(explanation))
      return reject('unknown_acp_working_directory')
    if (data.locations && (!Array.isArray(data.locations) || data.locations.some((entry: any) =>
      typeof entry?.path !== 'string' || path.resolve(cwd, entry.path) !== path.join(cwd, fixtureName))))
      return reject('unbounded_acp_locations')
  } else return reject('only_known_foreground_node_command_allowed')
  try { verifyFixture(cwd, expected) } catch { return reject('fixture_not_exact_or_unsafe') }
  return { allowed: true, reason: 'known_foreground_node_fixture' }
}
