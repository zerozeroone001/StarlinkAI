import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({ entryPoints: ['scripts/portable-archive-tests.ts'], outfile: '.tmp/portable-archive-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['--test', '.tmp/portable-archive-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
