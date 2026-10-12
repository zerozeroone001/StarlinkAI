import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({ entryPoints: ['scripts/portable-backup-service-test.ts'], outfile: '.tmp/portable-backup-service-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@shared': './src/shared' } })
const result = spawnSync(process.execPath, ['--test', '.tmp/portable-backup-service-test.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
