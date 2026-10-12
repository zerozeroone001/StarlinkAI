import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.argv.includes('--live')) throw new Error('Pass --live to opt in to provider image requests (up to sixteen requests for PET_SMOKE_FULL_ACTION=1).')
const require = createRequire(import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-pet-smoke-runner-'))
try {
  const output = path.join(temp, 'smoke.cjs')
  await build({ entryPoints: [path.join(import.meta.dirname, 'pets-live-smoke.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [output], { env, windowsHide: true, stdio: 'inherit' })
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code === 0 ? 0 : 1)) })
} finally {
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('grok-pet-smoke-runner-')) throw new Error('Unsafe test cleanup path')
  fs.rmSync(temp, { recursive: true, force: true })
}
