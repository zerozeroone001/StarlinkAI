import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-pets-test-'))
const output = path.join(temp, 'pets-test.cjs')
try {
  await build({
    entryPoints: [path.join(root, 'scripts/pets.test.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron'], define: { 'import.meta.url': JSON.stringify(pathToFileURL(output).href) },
    plugins: [{ name: 'isolated-pet-test', setup(b) {
      b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: path.join(root, 'scripts/pets-test-process.ts') }))
      b.onResolve({ filter: /^electron$/ }, (args) => args.importer.endsWith(`${path.sep}pets.ts`)
        ? { path: path.join(root, 'scripts/pets-test-electron.ts') } : { path: 'electron', external: true })
    } }]
  })
  const env = { ...process.env, GROK_HOME: path.join(temp, 'grok'), PET_TEST_TEMP: temp }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [output], { env, cwd: root, windowsHide: true, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  process.exitCode = code === 0 ? 0 : 1
} finally {
  // Only this run's mkdtemp directory is ever removed, never a user pet directory.
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('grok-pets-test-')) throw new Error('Unsafe test cleanup path')
  fs.rmSync(temp, { recursive: true, force: true })
}
