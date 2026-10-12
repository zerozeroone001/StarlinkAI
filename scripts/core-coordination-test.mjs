import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
await build({
  entryPoints: ['scripts/core-coordination-tests.ts'], outfile: '.tmp/core-coordination-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') }
})
const result = spawnSync(process.execPath, ['--test', '.tmp/core-coordination-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
