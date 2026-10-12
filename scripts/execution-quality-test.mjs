import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

await build({ entryPoints: ['scripts/execution-quality-tests.ts'], outfile: '.tmp/execution-quality-tests.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
const result = spawnSync(process.execPath, ['--test', '.tmp/execution-quality-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
