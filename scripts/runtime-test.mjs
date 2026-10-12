import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
await build({
  entryPoints: ['scripts/runtime-tests.ts'],
  outfile: '.tmp/runtime-tests.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external'
})
const result = spawnSync(process.execPath, ['--test', '.tmp/runtime-tests.mjs'], {
  stdio: 'inherit',
  windowsHide: true
})
process.exitCode = result.status ?? 1
