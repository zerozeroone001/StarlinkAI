import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

await build({
  entryPoints: ['scripts/assistant-renderer-tests.ts'], outfile: '.tmp/assistant-renderer-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') }
})
const result = spawnSync(process.execPath, ['--test', '.tmp/assistant-renderer-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
