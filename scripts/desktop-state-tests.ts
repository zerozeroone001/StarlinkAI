import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDesktopState, patchPrefs, mergeProjects, desktopStateHealth } from '../src/main/desktop-state'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-desktop-state-'))
  const previousHome = process.env.GROK_HOME
  process.env.GROK_HOME = root
  const file = path.join(root, 'desktop', 'state.json')
  const backup = `${file}.bak`
  fs.mkdirSync(path.dirname(file))
  t.after(() => {
    if (previousHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(root).startsWith('grok-desktop-state-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, file, backup }
}

test('malformed project records cannot crash startup or hide valid offline projects', t => {
  const { root, file } = fixture(t)
  const valid = { id: 'kept-id', name: '中文 Project', path: path.join(root, 'offline-project'), branch: 'feature/v1', lastActiveAt: '2026-10-11T00:00:00.000Z' }
  const raw = JSON.stringify({ projects: [null, 42, { path: 5 }, valid], hiddenProjects: [null, 8, 'hidden'], theme: 'light' })
  fs.writeFileSync(file, raw)
  assert.doesNotThrow(() => mergeProjects([]))
  assert.deepEqual(loadDesktopState().projects, [valid])
  assert.deepEqual(loadDesktopState().hiddenProjects, ['hidden'])
  assert.equal(fs.readFileSync(file, 'utf8'), raw)
})

test('a truncated desktop state recovers its backup without overwriting either file on read', t => {
  const { file, backup } = fixture(t)
  const saved = JSON.stringify({ theme: 'light', locale: 'zh-CN', projects: [{ id: 'project', name: 'Original', path: 'I:/offline-project' }] })
  fs.writeFileSync(file, '{"projects":[')
  fs.writeFileSync(backup, saved)
  assert.equal(loadDesktopState().theme, 'light')
  assert.equal(loadDesktopState().projects[0]?.name, 'Original')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"projects":[')
  assert.equal(fs.readFileSync(backup, 'utf8'), saved)
})

test('two damaged copies block preference writes and preserve both recovery candidates', t => {
  const { file, backup } = fixture(t)
  fs.writeFileSync(file, '{broken main')
  fs.writeFileSync(backup, '{broken backup')
  assert.throws(() => patchPrefs({ theme: 'light' }), /恢复|损坏/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken main')
  assert.equal(fs.readFileSync(backup, 'utf8'), '{broken backup')
})

test('failed state replacement never truncates the previous usable primary', t => {
  const { file } = fixture(t)
  patchPrefs({ theme: 'light' })
  const before = fs.readFileSync(file, 'utf8')
  const originalWrite = fs.writeFileSync
  const originalRename = fs.renameSync
  fs.writeFileSync = ((target, data, ...rest) => {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) {
      originalWrite(target, '{truncated')
      throw new Error('injected disk full')
    }
    return originalWrite(target, data, ...rest as [])
  }) as typeof fs.writeFileSync
  fs.renameSync = ((from, to) => {
    if (path.resolve(String(to)) === path.resolve(file)) throw new Error('injected replacement failure')
    return originalRename(from, to)
  }) as typeof fs.renameSync
  try {
    assert.throws(() => patchPrefs({ theme: 'dark' }), /injected/)
  } finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename }
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(loadDesktopState().theme, 'light')
})

test('legacy preferences retain numeric conversion while null pet coordinates stay unset', t => {
  const { file } = fixture(t)
  fs.writeFileSync(file, JSON.stringify({ theme: 'light', locale: 'zh-CN', permissionMode: 'review', effort: 'high',
    wallpaperOpacity: '73.6', petId: 'spark', petX: null, petY: '-42.8' }))
  const state = loadDesktopState()
  assert.equal(state.wallpaperOpacity, 74)
  assert.equal(state.petId, 'ragdoll')
  assert.equal(state.petX, null)
  assert.equal(state.petY, -43)
  assert.equal(state.permissionMode, 'review')
})

test('new profiles are read-only until the first intentional save', t => {
  const { file, backup } = fixture(t)
  assert.equal(desktopStateHealth().status, 'new')
  assert.deepEqual(loadDesktopState().projects, [])
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(backup), false)
  patchPrefs({ locale: 'zh-CN' })
  assert.equal(desktopStateHealth().status, 'ready')
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).locale, 'zh-CN')
})

test('normal saves retain one preceding usable state as a recoverable backup', t => {
  const { file, backup } = fixture(t)
  patchPrefs({ theme: 'light', locale: 'zh-CN' })
  const before = fs.readFileSync(file, 'utf8')
  patchPrefs({ theme: 'dark' })
  assert.equal(fs.readFileSync(backup, 'utf8'), before)
  assert.equal(loadDesktopState().theme, 'dark')
  fs.writeFileSync(file, '{interrupted')
  assert.equal(loadDesktopState().theme, 'light')
  assert.equal(desktopStateHealth().status, 'recovered')
})

test('saving recovered preferences never replaces the only valid backup with the broken primary', t => {
  const { file, backup } = fixture(t)
  const saved = JSON.stringify({ theme: 'light', locale: 'zh-CN', projects: [{ id: 'kept', name: 'Kept', path: 'I:/offline' }] })
  fs.writeFileSync(file, '{broken')
  fs.writeFileSync(backup, saved)
  patchPrefs({ theme: 'dark' })
  assert.equal(loadDesktopState().projects[0]?.id, 'kept')
  assert.equal(loadDesktopState().theme, 'dark')
  assert.equal(fs.readFileSync(backup, 'utf8'), saved)
  assert.equal(desktopStateHealth().status, 'ready')
})

test('partially damaged records preserve the good backup when saving surviving fields', t => {
  const { file, backup } = fixture(t)
  const saved = JSON.stringify({ theme: 'light', projects: [{ id: 'kept', name: 'Kept', path: 'I:/offline' }] })
  fs.writeFileSync(backup, saved)
  fs.writeFileSync(file, JSON.stringify({ projects: [null], locale: 'zh-CN', petAwake: 'false' }))
  assert.equal(desktopStateHealth().status, 'partial')
  assert.ok(desktopStateHealth().invalidFields?.includes('projects'))
  assert.equal(loadDesktopState().petAwake, false)
  patchPrefs({ theme: 'dark' })
  assert.equal(fs.readFileSync(backup, 'utf8'), saved)
  assert.equal(loadDesktopState().locale, 'zh-CN')
})

test('an absent primary recovers an orphan backup, while a valid primary stays authoritative', t => {
  const { file, backup } = fixture(t)
  fs.writeFileSync(backup, JSON.stringify({ theme: 'light', projects: [{ id: 'old', name: 'Old', path: 'I:/old' }] }))
  assert.equal(desktopStateHealth().status, 'recovered')
  assert.equal(loadDesktopState().theme, 'light')
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', projects: [] }))
  assert.equal(desktopStateHealth().status, 'ready')
  assert.equal(loadDesktopState().theme, 'dark')
  assert.deepEqual(loadDesktopState().projects, [], 'backup must not resurrect a deliberately removed project')
})

test('JSON primitives and arrays are damaged records rather than silently empty preferences', t => {
  const { file, backup } = fixture(t)
  fs.writeFileSync(backup, JSON.stringify({ theme: 'light' }))
  for (const value of [null, [], 42, 'hello']) {
    fs.writeFileSync(file, JSON.stringify(value))
    assert.equal(desktopStateHealth().status, 'recovered')
    assert.equal(loadDesktopState().theme, 'light')
  }
})

test('a failed flush preserves primary and backup and removes its incomplete staging file', t => {
  const { file, backup } = fixture(t)
  patchPrefs({ theme: 'light' })
  const before = fs.readFileSync(file, 'utf8'), saved = fs.readFileSync(backup, 'utf8')
  const original = fs.fsyncSync
  fs.fsyncSync = (() => { throw new Error('injected flush failure') }) as typeof fs.fsyncSync
  try { assert.throws(() => patchPrefs({ theme: 'dark' }), /injected flush failure/) }
  finally { fs.fsyncSync = original }
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(fs.readFileSync(backup, 'utf8'), saved)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['state.json', 'state.json.bak'])
})

test('a UTF-8 BOM from a text editor does not discard valid existing preferences', t => {
  const { file } = fixture(t)
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ theme: 'light', locale: 'zh-CN' }))
  assert.equal(loadDesktopState().theme, 'light')
  assert.equal(desktopStateHealth().status, 'ready')
})

test('saving unchanged preferences neither flushes files nor rotates away the previous backup', t => {
  const { file, backup } = fixture(t)
  patchPrefs({ theme: 'light' })
  patchPrefs({ theme: 'dark' })
  const saved = fs.readFileSync(backup, 'utf8'), current = fs.readFileSync(file, 'utf8')
  const original = fs.fsyncSync
  fs.fsyncSync = (() => assert.fail('unchanged preferences should not write')) as typeof fs.fsyncSync
  try { patchPrefs({ theme: 'dark' }) } finally { fs.fsyncSync = original }
  assert.equal(fs.readFileSync(file, 'utf8'), current)
  assert.equal(fs.readFileSync(backup, 'utf8'), saved)
})
