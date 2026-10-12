import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
await build({
  entryPoints: ['scripts/chat-regression-tests.ts'], outfile: '.tmp/chat-regression-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') }
})
const result = spawnSync(process.execPath, ['--test', '.tmp/chat-regression-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
