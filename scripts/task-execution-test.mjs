import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GrokAcp } from '../src/main/acp.ts'

const tempPrefix = path.join(os.tmpdir(), 'grok-desktop-task-execution-')
const sessionsRoot = path.resolve(os.homedir(), '.grok', 'sessions')
const encodedTestPrefix = encodeURIComponent(tempPrefix)

async function cleanupTestSessionResidues() {
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(encodedTestPrefix)) continue
    const target = path.resolve(sessionsRoot, entry.name)
    assert.ok(
      target.startsWith(sessionsRoot + path.sep) && path.basename(target).startsWith(encodedTestPrefix),
      `refusing to remove unexpected session residue: ${target}`
    )
    await fs.rm(target, { recursive: true, force: true })
  }
}

await cleanupTestSessionResidues()
const workspace = await fs.mkdtemp(tempPrefix)
const grok = path.join(
  os.homedir(),
  '.grok',
  'bin',
  process.platform === 'win32' ? 'grok.exe' : 'grok'
)
const client = new GrokAcp(grok, { effort: 'low' })
const updates = []
let forwardedPermissions = 0
let automaticResponses = 0
let sessionId = ''

const respondPermission = client.respondPermission.bind(client)
client.respondPermission = (id, optionId) => {
  automaticResponses += 1
  respondPermission(id, optionId)
}
client.on('permission', (request) => {
  forwardedPermissions += 1
  const option = request.options.find((item) =>
    /allow|approve|accept|proceed/i.test(`${item.optionId} ${item.kind || ''} ${item.name}`)
  )
  if (option) respondPermission(request.requestId, option.optionId)
  else client.denyPermission(request.requestId)
})
client.on('update', (update) => updates.push(update))

function withTimeout(promise, label, ms = 180_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref()
    })
  ])
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `${command} exited ${code}`))
    })
  })
}

async function verifyFileGeneration() {
  const before = updates.length
  await withTimeout(
    client.prompt(
      [
        'Create a Markdown file named REQUIREMENTS.md in the current workspace.',
        'It must contain the exact heading "# Task Execution Requirements" and the exact marker "FILE_GENERATION_OK".',
        'Use file-writing tools and verify the file exists. Do not merely describe the content.',
        'When finished, reply with exactly: file-generation-complete'
      ].join(' '),
      sessionId,
      [],
      true
    ),
    'file generation task'
  )

  const content = await fs.readFile(path.join(workspace, 'REQUIREMENTS.md'), 'utf8')
  assert.match(content, /^# Task Execution Requirements/m)
  assert.match(content, /FILE_GENERATION_OK/)
  const taskUpdates = updates.slice(before)
  assert.ok(
    taskUpdates.some((update) => /REQUIREMENTS\.md/i.test(JSON.stringify(update))),
    'file generation produced no REQUIREMENTS.md tool update'
  )
  console.log(`PASS file generation — REQUIREMENTS.md (${Buffer.byteLength(content)} bytes)`)
}

async function verifyCodeDevelopment() {
  const before = updates.length
  await withTimeout(
    client.prompt(
      [
        'Develop and test a package-free Node.js calculator in this workspace.',
        'Create src/calculator.mjs exporting add(a, b) and multiply(a, b).',
        'Create test/calculator.test.mjs using node:test and node:assert/strict with tests for both functions.',
        'Run `node --test test/calculator.test.mjs` and fix any failures before finishing.',
        'Do not only provide instructions or a code block; create the files and execute the tests.',
        'When everything passes, reply with exactly: code-development-complete'
      ].join(' '),
      sessionId,
      [],
      true
    ),
    'code development task'
  )

  const source = await fs.readFile(path.join(workspace, 'src', 'calculator.mjs'), 'utf8')
  const test = await fs.readFile(path.join(workspace, 'test', 'calculator.test.mjs'), 'utf8')
  assert.match(source, /export\s+(?:function|const)\s+add|export\s*\{[^}]*add/s)
  assert.match(source, /multiply/)
  assert.match(test, /node:test/)
  const external = await run(process.execPath, ['--test', 'test/calculator.test.mjs'], workspace)
  assert.match(external.stdout + external.stderr, /pass/i)

  const taskUpdates = updates.slice(before)
  assert.ok(
    taskUpdates.some((update) => /node --test test[\\/]calculator\.test\.mjs/i.test(JSON.stringify(update))),
    'code development did not execute the requested test command'
  )
  console.log(
    `PASS code development — calculator source/test created; independent node:test passed`
  )
}

async function verifyCodeModification() {
  const file = path.join(workspace, 'src', 'calculator.mjs')
  const before = await fs.readFile(file, 'utf8')
  const requirements = await fs.readFile(path.join(workspace, 'REQUIREMENTS.md'), 'utf8')
  await withTimeout(
    client.prompt(
      [
        'Modify the existing src/calculator.mjs: extend add to sum two or more arguments, so add(1, 2, 3) returns 6.',
        'Preserve multiply(a, b) and the original two-argument add behavior.',
        'Update test/calculator.test.mjs with a regression test for three arguments and run the full tests.',
        'Do not modify REQUIREMENTS.md. Edit the real files, not just a code block.',
        'When all tests pass, reply exactly: file-modification-complete'
      ].join(' '), sessionId, [], true
    ), 'existing file modification'
  )
  assert.notEqual(await fs.readFile(file, 'utf8'), before)
  assert.equal(await fs.readFile(path.join(workspace, 'REQUIREMENTS.md'), 'utf8'), requirements)
  await run(process.execPath, ['--input-type=module', '-e',
    "import assert from 'node:assert/strict'; import { add, multiply } from './src/calculator.mjs'; assert.equal(add(1,2,3),6); assert.equal(add(1,2),3); assert.equal(multiply(3,4),12);"
  ], workspace)
  await run(process.execPath, ['--test', 'test/calculator.test.mjs'], workspace)
  console.log('PASS file modification — existing code updated; new and original behavior independently verified')
}

try {
  await client.start()
  sessionId = await client.newSession(workspace, { yoloMode: false })
  await verifyFileGeneration()
  await verifyCodeDevelopment()
  await verifyCodeModification()
  assert.ok(automaticResponses > 0, 'no permission request was automatically approved')
  assert.equal(forwardedPermissions, 0, 'auto mode forwarded a permission request to the UI')
  console.log(`PASS task lifecycle — ${automaticResponses} permission response(s), ${updates.length} update(s)`)
} finally {
  if (sessionId) client.cancel(sessionId)
  client.stop()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const resolvedWorkspace = path.resolve(workspace)
  const resolvedTemp = path.resolve(os.tmpdir()) + path.sep
  assert.ok(
    resolvedWorkspace.startsWith(resolvedTemp) &&
      path.basename(resolvedWorkspace).startsWith('grok-desktop-task-execution-'),
    `refusing to remove unexpected path: ${resolvedWorkspace}`
  )
  await fs.rm(resolvedWorkspace, { recursive: true, force: true })

  const testSessions = path.resolve(sessionsRoot, encodeURIComponent(workspace))
  assert.ok(
    testSessions.startsWith(sessionsRoot + path.sep) &&
      path.basename(testSessions) === encodeURIComponent(workspace),
    `refusing to remove unexpected session path: ${testSessions}`
  )
  await fs.rm(testSessions, { recursive: true, force: true })
}
