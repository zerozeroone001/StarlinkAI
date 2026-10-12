import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/permission-runtime-tests.ts'], outfile: '.tmp/permission-runtime-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external'
})
const result = spawnSync(process.execPath, ['--test', '.tmp/permission-runtime-tests.mjs'], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
