import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

await build({ entryPoints: ['scripts/portable-backup-ui-tests.ts'], outfile: '.tmp/portable-backup-ui-tests.mjs', bundle: true,
  platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
  alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } })
const result = spawnSync(process.execPath, ['--test', '.tmp/portable-backup-ui-tests.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
