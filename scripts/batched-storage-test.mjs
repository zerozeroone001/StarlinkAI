import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
await build({ entryPoints: ['scripts/batched-storage-tests.ts'], outfile: '.tmp/batched-storage-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['--test', '.tmp/batched-storage-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
