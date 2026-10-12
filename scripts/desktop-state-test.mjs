import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/desktop-state-tests.ts'], outfile: '.tmp/desktop-state-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external'
})
const result = spawnSync(process.execPath, ['--test', '.tmp/desktop-state-tests.mjs'], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
