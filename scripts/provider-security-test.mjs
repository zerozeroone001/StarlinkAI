import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/provider-security-tests.ts'],
  outfile: '.tmp/provider-security-tests.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [{
    name: 'isolate-login-client',
    setup(build) {
      build.onResolve({ filter: /^\.\/providers$/ }, (args) => {
        if (!/[\\/]runtime[\\/]login\.ts$/.test(args.importer)) return
        return { path: 'login-rpc', namespace: 'provider-security-test' }
      })
      build.onResolve({ filter: /^\.\/cli$/ }, (args) => {
        if (!/[\\/]runtime[\\/]login\.ts$/.test(args.importer)) return
        return { path: 'login-cli', namespace: 'provider-security-test' }
      })
      build.onLoad({ filter: /.*/, namespace: 'provider-security-test' }, ({ path }) => ({
        loader: 'js',
        resolveDir: process.cwd(),
        contents: path === 'login-rpc'
          ? `export const providerIds = ['claude','codex','grok','gemini'];
             export const rpcFor = async () => ({rpc: globalThis.__providerSecurityRpc});`
          : `export {safeError} from './src/main/runtime/cli.ts';
             export const workspaceDir = () => '.';
             export const commandFor = () => {throw new Error('Real clients are forbidden in this test')};
             export const geminiAccount = () => ({methodId:'oauth-personal'});`
      }))
    }
  }]
})
const result = spawnSync(process.execPath, ['--test', '.tmp/provider-security-tests.mjs'], {
  stdio: 'inherit', windowsHide: true
})
process.exitCode = result.status ?? 1
