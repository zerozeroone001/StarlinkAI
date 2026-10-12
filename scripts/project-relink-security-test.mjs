import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({ entryPoints: ['scripts/project-relink-security-test.ts'], outfile: '.tmp/project-relink-security-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@shared': './src/shared' } })
const result = spawnSync(process.execPath, ['--test', '.tmp/project-relink-security-test.mjs'], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
