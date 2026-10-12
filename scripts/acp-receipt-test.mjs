import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
await build({ entryPoints: ['scripts/acp-receipt-tests.ts'], outfile: '.tmp/acp-receipt-tests.mjs', bundle: true,
  platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['--test', '.tmp/acp-receipt-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
