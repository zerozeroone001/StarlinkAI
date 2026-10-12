import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

if (!process.argv.includes('--live') && !process.argv.includes('--self-test')) {
  console.error('Use --self-test, or --live [--provider=codex|gemini|all]. One task per selected signed-in provider; no retries.')
  process.exit(2)
}
await build({ entryPoints: ['scripts/provider-cancel-live-test.ts'], outfile: '.tmp/provider-cancel-live-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['.tmp/provider-cancel-live-test.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
