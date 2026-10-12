import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { collectRunImages, previewWorkspaceImage } from '../src/main/runtime/media'
import { createSkill, readSkill } from '../src/main/skills'
import { resolveMediaPath, resolveScopedMediaPath } from '../src/main/preview'
import { providerLoginCommand } from '../src/main/runtime/login-command'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')

test('Windows manual Gemini command selects Node mode and restores the caller environment', { skip: process.platform !== 'win32' }, (t) => {
  const { cwd } = fixture(t)
  const file = path.join(cwd, "user's client.cjs")
  fs.writeFileSync(file, 'console.log(JSON.stringify({ mode: process.env.ELECTRON_RUN_AS_NODE, argument: process.argv[2] }))')
  const argument = "literal ' $() & text"
  for (const prior of [undefined, 'prior-value']) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    if (prior !== undefined) env.ELECTRON_RUN_AS_NODE = prior
    const command = providerLoginCommand('gemini', process.execPath, [file, argument], 'win32')
    const script = `$ProgressPreference = 'SilentlyContinue'\n${command}\n@{ mode = $env:ELECTRON_RUN_AS_NODE } | ConvertTo-Json -Compress`
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, windowsHide: true, encoding: 'utf8', timeout: 15000 })
    const lines = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    assert.deepEqual(lines[0], { mode: '1', argument })
    assert.equal(lines[1].mode, prior ?? null)
  }
})
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-security-'))
  const previousHome = process.env.GROK_HOME
  const cwd = path.join(root, 'workspace'), outside = path.join(root, 'outside')
  fs.mkdirSync(cwd)
  fs.mkdirSync(outside)
  process.env.GROK_HOME = path.join(root, 'home')
  t.after(() => {
    if (previousHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-security-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, cwd, outside }
}
function junction(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

test('model image paths cannot automatically copy a private image from outside the workspace', (t) => {
  const { cwd, outside } = fixture(t)
  const secret = path.join(outside, 'private.png')
  fs.writeFileSync(secret, png)
  assert.deepEqual(collectRunImages({ path: secret }, cwd), [])
  assert.equal(fs.existsSync(path.join(cwd, 'images')), false)
})

test('model image paths cannot escape through a repository junction', (t) => {
  const { cwd, outside } = fixture(t)
  fs.writeFileSync(path.join(outside, 'private.png'), png)
  junction(outside, path.join(cwd, 'linked'))
  assert.deepEqual(collectRunImages({ path: path.join(cwd, 'linked', 'private.png') }, cwd), [])
})

test('generated images cannot write through an images junction outside the workspace', (t) => {
  const { cwd, outside } = fixture(t)
  junction(outside, path.join(cwd, 'images'))
  assert.deepEqual(collectRunImages({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, cwd), [])
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('images from the selected CLI session are still imported into the workspace', (t) => {
  const { cwd } = fixture(t)
  const session = path.join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(cwd), 'current-session', 'images')
  fs.mkdirSync(session, { recursive: true })
  const source = path.join(session, 'result.png')
  fs.writeFileSync(source, png)
  const images = collectRunImages({ path: source }, cwd, 'current-session')
  assert.equal(images.length, 1)
  assert.equal(path.dirname(images[0].path!), path.join(cwd, 'images'))
  assert.deepEqual(fs.readFileSync(images[0].path!), png)
})

test('an inaccessible generated image does not discard other valid reply images', (t) => {
  const { cwd } = fixture(t)
  const file = path.join(cwd, 'valid.png')
  fs.writeFileSync(file, png)
  const images = collectRunImages([{ path: path.join(cwd, 'missing.png') }, { path: file }], cwd)
  assert.deepEqual(images.map(image => image.path), [file])
})

test('project skill creation cannot write through a repository .grok junction', (t) => {
  const { cwd, outside } = fixture(t)
  junction(outside, path.join(cwd, '.grok'))
  const result = createSkill({ name: 'safe-workflow', description: 'Local workflow', scope: 'project', cwd })
  assert.deepEqual(result, { ok: false, error: 'write_failed' })
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('project skills still create normally and never replace an existing skill', (t) => {
  const { cwd } = fixture(t)
  const input = { name: 'safe-workflow', description: 'Local workflow', scope: 'project' as const, cwd }
  assert.equal(createSkill(input).ok, true)
  const file = path.join(cwd, '.grok', 'skills', input.name, 'SKILL.md')
  const before = fs.readFileSync(file, 'utf8')
  assert.deepEqual(createSkill({ ...input, description: 'replacement' }), { ok: false, error: 'exists' })
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('automatic media preview refuses outside paths and other CLI sessions', (t) => {
  const { cwd, outside } = fixture(t)
  const source = path.join(outside, 'private.png')
  fs.writeFileSync(source, png)
  assert.equal(resolveScopedMediaPath(source, cwd), null)
  assert.equal(resolveScopedMediaPath(source), null)
  const session = path.join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(cwd), 'other-session', 'images')
  fs.mkdirSync(session, { recursive: true })
  fs.writeFileSync(path.join(session, 'image.png'), png)
  assert.equal(resolveScopedMediaPath(path.join(session, 'image.png'), cwd, 'current-session'), null)
  assert.equal(resolveMediaPath(source), source, 'explicit local file selection remains available')
})

test('media lookup preserves literal hash and percent characters and decodes file URLs once', (t) => {
  const { cwd } = fixture(t)
  for (const name of ['chart#1.png', 'chart%20v1.png']) {
    const file = path.join(cwd, name)
    fs.writeFileSync(file, png)
    assert.equal(resolveMediaPath(name, cwd), file)
    assert.equal(resolveMediaPath(pathToFileURL(file).href, cwd), file)
  }
})

test('skills larger than the read budget cannot block catalog scanning', (t) => {
  const { cwd } = fixture(t)
  const file = path.join(cwd, 'SKILL.md')
  fs.writeFileSync(file, '# Large workflow\n' + 'x'.repeat(1024 * 1024))
  assert.equal(readSkill(file) === null, true)
  fs.writeFileSync(file, '---\nname: small-workflow\n---\n# A normal workflow\nKeep this content')
  assert.match(readSkill(file)?.body || '', /Keep this content/)
})

test('invalid embedded image bytes do not become a saved image', (t) => {
  const { cwd } = fixture(t)
  assert.deepEqual(collectRunImages({ type: 'image', data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' }, cwd), [])
  assert.equal(fs.existsSync(path.join(cwd, 'images')), false)
})

test('generated image cache never overwrites or returns an unrelated existing file', (t) => {
  const { cwd } = fixture(t)
  const directory = path.join(cwd, 'images')
  fs.mkdirSync(directory)
  const file = path.join(directory, `${createHash('sha256').update(png).digest('hex')}.png`)
  fs.writeFileSync(file, 'Unrelated existing content')
  assert.deepEqual(collectRunImages({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, cwd), [])
  assert.equal(fs.readFileSync(file, 'utf8'), 'Unrelated existing content')
})

test('a filename beginning with two dots is still a workspace file', (t) => {
  const { cwd } = fixture(t)
  const file = path.join(cwd, '..preview.png')
  fs.writeFileSync(file, png)
  assert.equal(previewWorkspaceImage(cwd, file).kind, 'image')
})
