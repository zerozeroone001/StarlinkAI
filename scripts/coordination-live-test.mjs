import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({ entryPoints: ['scripts/coordination-live-tests.ts'], outfile: '.tmp/coordination-live-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['.tmp/coordination-live-tests.mjs', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
