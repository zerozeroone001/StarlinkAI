import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const base = path.resolve('.tmp/quality-0.1.25')
fs.mkdirSync(base, { recursive: true })
const output = fs.mkdtempSync(path.join(base, 'managed-assets-'))
const home = path.join(output, 'home')
fs.mkdirSync(home)
const bundle = path.join(output, 'tests.mjs')
await build({ entryPoints: ['scripts/managed-assets-tests.ts'], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
const result = spawnSync(process.execPath, ['--test', bundle], {
  env: { ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, '.grok') },
  encoding: 'utf8', windowsHide: true, timeout: 60000
})
fs.writeFileSync(path.join(output, 'results.tap'), (result.stdout || '') + (result.stderr || ''))
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
console.log(`Evidence: ${output}`)
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
