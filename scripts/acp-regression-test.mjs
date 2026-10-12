import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GrokAcp } from '../src/main/acp.ts'

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

const timeout = (ms) =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Regression test timed out after ${ms} ms`)), ms).unref()
  })

try {
  await client.start()
  // Keep the agent itself in ask mode so this exercises GrokAcp's per-prompt
  // auto-approval path instead of the server-side yoloMode shortcut.
  sessionId = await client.newSession(process.cwd(), { yoloMode: false })
  const result = await Promise.race([
    client.prompt(
      'Use the terminal tool to run exactly `python --version`. Wait for it to finish, then reply with exactly: acp-auto-approval-ok',
      sessionId,
      [],
      true
    ),
    timeout(120_000)
  ])

  const terminalUpdates = updates.filter((update) =>
    /python --version|run_terminal_command/i.test(JSON.stringify(update))
  )
  assert.ok(terminalUpdates.length > 0, 'the agent did not run the requested terminal command')
  assert.ok(automaticResponses > 0, 'the ACP client did not auto-answer a permission request')
  assert.equal(forwardedPermissions, 0, 'auto mode incorrectly forwarded a permission prompt to the UI')
  assert.ok(result, 'session/prompt returned no result')
  console.log(
    `PASS ACP auto approval — ${automaticResponses} permission response(s), ${terminalUpdates.length} terminal update(s)`
  )
} finally {
  client.stop()
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (sessionId) {
    const sessionsRoot = path.resolve(os.homedir(), '.grok', 'sessions')
    const testSession = path.resolve(sessionsRoot, encodeURIComponent(process.cwd()), sessionId)
    assert.ok(
      testSession.startsWith(sessionsRoot + path.sep) && path.basename(testSession) === sessionId,
      `refusing to remove unexpected session path: ${testSession}`
    )
    await fs.rm(testSession, { recursive: true, force: true })
  }
}
