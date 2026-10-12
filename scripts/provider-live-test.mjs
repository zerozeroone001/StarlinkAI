// Explicit opt-in: one real, text-only acceptance call per ready provider.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

if (!process.argv.includes('--live') && !process.argv.includes('--inspect-only')) {
  console.error('Use --inspect-only to inspect local readiness, or --live for at most one real call per ready provider.')
  process.exit(2)
}
await build({ entryPoints: ['scripts/provider-live-test.ts'], outfile: '.tmp/provider-live-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['.tmp/provider-live-test.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
