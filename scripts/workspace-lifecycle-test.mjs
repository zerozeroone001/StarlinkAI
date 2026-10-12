import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
await build({ entryPoints: ['scripts/workspace-lifecycle-tests.ts'], outfile: '.tmp/workspace-lifecycle-tests.mjs', bundle: true,
  platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['--test', '.tmp/workspace-lifecycle-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
