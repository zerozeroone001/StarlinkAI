import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/runtime-efficiency-tests.ts'], outfile: '.tmp/runtime-efficiency-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external'
})
const result = spawnSync(process.execPath, ['--test', '.tmp/runtime-efficiency-tests.mjs'], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
