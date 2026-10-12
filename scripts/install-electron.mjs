import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

// Electron 44 no longer downloads its binary during its own postinstall.
// Keep clean npm ci / npm install usable, including production-only installs.
const require = createRequire(import.meta.url)
let installer
try { installer = require.resolve('electron/install.js') }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  console.log('Electron is a development dependency; desktop binary setup skipped.')
}
if (installer) {
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
