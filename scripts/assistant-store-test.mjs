import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/assistant-store-tests.ts'],
  outfile: '.tmp/assistant-store-tests.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external'
})
const result = spawnSync(process.execPath, ['--test', '.tmp/assistant-store-tests.mjs'], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
