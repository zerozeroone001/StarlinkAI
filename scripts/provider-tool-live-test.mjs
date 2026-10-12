// Explicit opt-in: one real file/edit/test task per selected, signed-in provider.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

if (!process.argv.includes('--live') && !process.argv.includes('--self-test')) {
  console.error('Use --self-test, or --live [--provider=codex|gemini|all]. Live mode uses existing accounts once each.')
  process.exit(2)
}
await build({ entryPoints: ['scripts/provider-tool-live-test.ts'], outfile: '.tmp/provider-tool-live-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const result = spawnSync(process.execPath, ['.tmp/provider-tool-live-test.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
