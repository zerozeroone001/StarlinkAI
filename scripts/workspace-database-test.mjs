import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// Runs source-level storage tests against Chromium's real IndexedDB. This is a
// minimal account-free Electron harness and does not build or load the product.
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Usage: node scripts/workspace-database-test.mjs [--output-dir directory]')
const output = path.resolve(args[1] || '.tmp/workspace-database-tests')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'database-tests-'))
const resultsFile = path.join(root, 'results.json')
await build({ entryPoints: ['scripts/workspace-database-tests.ts'], outfile: path.join(root, 'tests.js'),
  bundle: true, platform: 'browser', format: 'iife', globalName: 'WorkspaceDatabaseTests', target: 'es2022' })
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Workspace database tests</title><script src="tests.js"></script>')
fs.writeFileSync(path.join(root, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await window.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
    const report = await window.webContents.executeJavaScript('WorkspaceDatabaseTests.run()');
    fs.writeFileSync(${JSON.stringify(resultsFile)}, JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  } catch (error) { fs.writeFileSync(${JSON.stringify(resultsFile)}, JSON.stringify({ok:false,error:String(error)})); app.exit(1); }
});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
const child = spawn(require('electron'), [path.join(root, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let diagnostics = ''
child.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-8000) })
const timer = setTimeout(() => { child.kill(); console.error('Native IndexedDB tests timed out') }, 90000)
const code = await new Promise((resolve) => { child.once('exit', (code) => resolve(code ?? 1)); child.once('error', (error) => { console.error(error); resolve(1) }) })
clearTimeout(timer)
if (fs.existsSync(resultsFile)) {
  const result = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
  for (const entry of result.results || []) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.error ? `\n${entry.error}` : ''}`)
  console.log(JSON.stringify({ ok: result.ok, passed: result.results?.filter((item) => item.ok).length,
    failed: result.results?.filter((item) => !item.ok).length, resultsFile, error: result.error }, null, 2))
} else console.error(diagnostics)
process.exitCode = code
