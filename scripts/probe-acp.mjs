import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const grok = path.join(os.homedir(), '.grok', 'bin', 'grok.exe')
const env = { ...process.env, GROK_HOME: path.join(os.homedir(), '.grok') }
delete env.GROK_CONFIG
delete env.GROK_CONFIG_PATH

const proc = spawn(grok, ['agent', '--no-leader', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env
})

proc.stdout.on('data', (d) => process.stdout.write('OUT ' + d.toString()))
proc.stderr.on('data', (d) => process.stderr.write('ERR ' + d.toString()))
proc.on('exit', (c) => {
  console.log('EXIT', c)
  process.exit(c ?? 1)
})

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'StarlinkAI', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
  }
}
proc.stdin.write(JSON.stringify(init) + '\n')
setTimeout(() => {
  console.log('timeout, killing')
  proc.kill()
}, 5000)
