// Run without invoking models or changing the user's authentication state.
const path = require('node:path')
const { spawnSync } = require('node:child_process')

async function checkPackage() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createRequire } = require('node:module')
  const { pathToFileURL } = require('node:url')
  const { execFileSync, spawn } = require('node:child_process')
  const root = path.dirname(process.execPath)
  const archive = path.join(root, 'resources', 'app.asar')
  const req = createRequire(path.join(archive, 'package.json'))
  const resources = path.join(archive, 'resources')
  const approvedPets = ['RIVE.md', 'elf.png', 'imp.png', 'ragdoll.png', 'secretary.png', 'shiba.png', 'xiaomei.png'].sort()
  assert.deepEqual(fs.readdirSync(resources).sort(), ['icon.png', 'pets'], 'Unapproved top-level packaged resources')
  assert(fs.statSync(path.join(resources, 'icon.png')).isFile(), 'Packaged icon is not a file')
  assert.deepEqual(fs.readdirSync(path.join(resources, 'pets')).sort(), approvedPets, 'Unapproved packaged pet resources')
  for (const file of approvedPets) assert(fs.statSync(path.join(resources, 'pets', file)).isFile(), `Unexpected pet resource directory: ${file}`)
  console.log('Resources: exactly 8 approved files; no development screenshots or debug dumps')
  for (const name of ['yauzl', 'yazl']) {
    assert(req.resolve(name).startsWith(root + path.sep), `External backup dependency: ${name}`)
    assert.equal(typeof req(name).ZipFile, 'function', `Missing ZIP implementation: ${name}`)
  }
  console.log('ZIP: yauzl and yazl loaded from the package')
  for (const file of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'])
    assert(fs.existsSync(path.join(archive, file)), `Missing entry: ${file}`)
  const unpack = (file) => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const claude = unpack(req.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'))
  const gemini = unpack(req.resolve('@google/gemini-cli/bundle/gemini.js'))
  for (const file of [claude, gemini]) assert(fs.existsSync(file), `Missing CLI: ${file}`)
  const cliReq = createRequire(gemini)
  assert(cliReq.resolve('@github/keytar').startsWith(root + path.sep), 'External dependency: @github/keytar')
  const keytar = cliReq('@github/keytar')
  assert.equal(typeof keytar.getPassword, 'function')
  assert.equal(typeof keytar.setPassword, 'function')
  console.log('Keytar: native module loaded (no credential operations)')

  // Resolve from Gemini's actual unpacked entry, including its optional fallback
  // name. Gemini runs outside app.asar, so the alias JS and its native dependency
  // must be reachable from that unpacked entry. Exercise isolated processes because ConPTY workers
  // can remain referenced after the terminal child has emitted its real exit.
  async function checkPty(geminiEntry, name) {
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    const path = require('node:path')
    const { createRequire } = require('node:module')
    const root = path.dirname(process.execPath)
    const resolver = createRequire(geminiEntry)
    const withinPackage = (file) => {
      const relative = path.relative(root, file)
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `External PTY dependency: ${name}`)
      return file
    }
    const entry = withinPackage(resolver.resolve(name))
    const metadata = resolver(`${name}/package.json`)
    assert.equal(metadata.name, '@lydell/node-pty', `PTY fallback is not the prebuilt alias: ${name}`)
    assert.equal(metadata.version, '1.1.0')
    const dependency = createRequire(entry)
    const platform = `@lydell/node-pty-${process.platform}-${process.arch}`
    const native = withinPackage(dependency.resolve(`${platform}/conpty.node`))
    const diskNative = native.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    assert(fs.existsSync(diskNative), `Missing unpacked native PTY: ${platform}`)
    dependency(`${platform}/conpty.node`)
    const pty = resolver(name)
    const marker = `PACKAGED_PTY_${name === 'node-pty' ? 'ALIAS' : 'CANONICAL'}_OK`
    await new Promise((resolve, reject) => {
      // Electron's Windows GUI subsystem can exit successfully without a
      // console stdout handle in a PTY. Exercise the system console shell with
      // a fixed inert command, without depending on a separately installed Node.
      const shell = path.join(process.env.SystemRoot, 'System32', 'cmd.exe')
      const terminal = pty.spawn(shell, ['/d', '/c', 'echo', marker], {
        name: 'xterm-color', cols: 80, rows: 24, cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      let output = ''
      const timer = setTimeout(() => {
        try { terminal.kill() } catch {}
        reject(new Error(`Packaged PTY timed out: ${name}`))
      }, 15000)
      terminal.onData((chunk) => { output = (output + chunk).slice(-8192) })
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer)
        try {
          assert.equal(exitCode, 0, `PTY child failed: ${name}`)
          assert(output.includes(marker), `PTY output missing: ${name}`)
          resolve()
        } catch (error) { reject(error) }
      })
    })
    return { name, entry: path.relative(root, entry), platform, command: 'cmd /d /c echo <fixed marker>', output: true, exitCode: 0 }
  }
  for (const name of ['@lydell/node-pty', 'node-pty']) {
    const source = `(${checkPty.toString()})(${JSON.stringify(gemini)}, ${JSON.stringify(name)})` +
      `.then(result => process.stdout.write(JSON.stringify(result), () => process.exit(0)))` +
      `.catch(error => process.stderr.write(error.message + '\\n', () => process.exit(1)))`
    const result = JSON.parse(execFileSync(process.execPath, ['-e', source], {
      env: process.env, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536
    }))
    assert.equal(result.output, true)
    assert.equal(result.exitCode, 0)
    console.log(`PTY: ${JSON.stringify(result)}`)
  }
  for (const [name, exe, args] of [
    ['Claude', claude, ['--version']],
    ['Gemini', process.execPath, [gemini, '--version']]
  ]) {
    const version = execFileSync(exe, args, {
      env: process.env, windowsHide: true, encoding: 'utf8', timeout: 30000
    }).trim()
    assert(/\d+\.\d+\.\d+/.test(version))
    console.log(`${name}: ${version}`)
  }
  const { query } = await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href)
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  async function* input() { await waiting }
  const q = query({ prompt: input(), options: {
    cwd: process.cwd(), pathToClaudeCodeExecutable: claude,
    env: process.env, settingSources: [], tools: [], persistSession: false
  } })
  let timer
  try {
    const result = await Promise.race([
      q.initializationResult(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude init timeout')), 30000) })
    ])
    assert(result.models.length > 0)
    console.log(`Claude SDK: ${result.models.length} models, initialization passed`)
  } finally { clearTimeout(timer); q.close(); release() }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gemini, '--acp', '--approval-mode', 'default'], {
      cwd: process.cwd(), env: process.env, windowsHide: true, stdio: 'pipe'
    })
    let buffer = ''
    let finished = false
    const timer = setTimeout(() => finish(new Error('Gemini ACP init timeout')), 30000)
    function finish(error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      error ? reject(error) : resolve()
    }
    child.on('error', finish)
    child.on('exit', () => { if (!finished) finish(new Error('Gemini exited before initialization')) })
    child.stderr.on('data', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let pos
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos)
        buffer = buffer.slice(pos + 1)
        try {
          const response = JSON.parse(line)
          if (response.id !== 1) continue
          if (response.error) return finish(new Error('Gemini initialization returned an error'))
          assert(response.result?.protocolVersion)
          console.log('Gemini ACP: initialization passed')
          finish()
        } catch (error) { if (error instanceof assert.AssertionError) finish(error) }
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientInfo: { name: 'package-smoke', version: '1.0.0' }, clientCapabilities: {}
    } }) + '\n')
  })
  console.log('Packaged entries, native modules and both bundled clients passed')
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
for (const key of Object.keys(env))
  if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDECODE|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|XAI_API_KEY|GROK_API_KEY)$/.test(key)) delete env[key]
const executable = path.resolve(process.argv[2] || 'release/win-unpacked/StarlinkAI.exe')
const result = spawnSync(executable, [
  '-e', `(${checkPackage.toString()})().catch(e => { console.error(e.message); process.exitCode = 1 })`
], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
