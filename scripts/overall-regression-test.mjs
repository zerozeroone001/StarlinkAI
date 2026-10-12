import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
await build({ entryPoints: ['scripts/overall-regression-tests.ts', 'scripts/startup-regression-tests.ts'], outdir: '.tmp', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
const result = spawnSync(process.execPath, ['--test', '.tmp/overall-regression-tests.mjs', '.tmp/startup-regression-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
