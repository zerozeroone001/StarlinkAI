import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { assertDesktopSender, isDesktopMain, matchesDesktopEntry, registerDesktopWindow } from '../src/main/desktop-security'

const entry = path.resolve('.tmp', 'desktop-security', 'index.html')
const petEntry = path.resolve('.tmp', 'desktop-security', 'pet.html')
const entryUrl = pathToFileURL(entry).href
const petUrl = pathToFileURL(petEntry).href
const devEntry = 'http://127.0.0.1:5173/'
const denied = /无权调用桌面功能/

class Contents extends EventEmitter {
  mainFrame: { url: string }
  destroyed = false
  openHandler?: (details: { url: string }) => { action: string }

  constructor(url: string) { super(); this.mainFrame = { url } }
  isDestroyed() { return this.destroyed }
  setWindowOpenHandler(handler: NonNullable<Contents['openHandler']>) { this.openHandler = handler }
  get webContents() { return this as unknown as WebContents }
  get window() { return { webContents: this.webContents } as BrowserWindow }
  event(frame: { url: string } | null = this.mainFrame) {
    return { sender: this.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  }
}

function renderer(role: 'main' | 'pet', url = role === 'main' ? entryUrl : petUrl, dev?: string) {
  const contents = new Contents(url)
  registerDesktopWindow(contents.window, { role, entry: role === 'main' ? entry : petEntry, devEntry: dev })
  return contents
}

function navigation(contents: Contents, url: string, isMainFrame: boolean) {
  let prevented = false
  contents.emit('will-frame-navigate', { url, isMainFrame, preventDefault: () => { prevented = true } })
  return prevented
}

test('packaged entry matching allows only the exact file while preserving query and hash navigation', () => {
  for (const url of [entryUrl, `${entryUrl}?theme=dark#thread-1`])
    assert.equal(matchesDesktopEntry(url, entry), true, url)
  for (const url of [petUrl, pathToFileURL(`${entry}.backup`).href,
    pathToFileURL(path.join(path.dirname(entry), 'child', 'index.html')).href,
    'file:///unrelated/index.html', 'https://example.com/index.html', '', 'not a URL'])
    assert.equal(matchesDesktopEntry(url, entry), false, url)
})

test('development entry matching requires the configured origin and exact entry path', () => {
  for (const url of [devEntry, `${devEntry}index.html`, `${devEntry}?theme=dark#thread-1`])
    assert.equal(matchesDesktopEntry(url, entry, devEntry), true, url)
  for (const url of ['http://127.0.0.1:5174/', 'http://localhost:5173/', 'https://127.0.0.1:5173/',
    `${devEntry}pet.html`, `${devEntry}src/main.tsx`, `${devEntry}nested/index.html`, `${devEntry}index.html.bak`,
    'http://127.0.0.1:5173.evil.example/', 'http://127.0.0.1:5173@evil.example/'])
    assert.equal(matchesDesktopEntry(url, entry, devEntry), false, url)
  assert.equal(matchesDesktopEntry(devEntry, entry), false, 'a dev URL is not trusted in a packaged registration')
  assert.equal(matchesDesktopEntry('http://127.0.0.1:5173/app/', entry, 'http://127.0.0.1:5173/app/'), true)
  assert.equal(matchesDesktopEntry('http://127.0.0.1:5173/app/child', entry, 'http://127.0.0.1:5173/app/'), false)
})

test('entry matching rejects embedded credentials and non-entry schemes', () => {
  for (const url of ['http://user:password@127.0.0.1:5173/', 'http://user@127.0.0.1:5173/',
    'javascript:alert(1)', 'data:text/html,<h1>untrusted</h1>', 'about:blank',
    'blob:http://127.0.0.1:5173/untrusted'])
    assert.equal(matchesDesktopEntry(url, entry, devEntry), false, url)
})

test('only a registered main window at its current entry can invoke desktop capabilities', () => {
  const main = renderer('main')
  for (const channel of ['app:snapshot', 'workspace:start', 'workspace:permission', 'app:openExternal', 'pets:create'])
    assert.doesNotThrow(() => assertDesktopSender(main.event(), channel))
  const unknown = new Contents(entryUrl)
  assert.throws(() => assertDesktopSender(unknown.event(), 'workspace:start'), denied,
    'the same URL in an unregistered BrowserWindow must not grant IPC access')
  main.mainFrame.url = 'https://example.com/'
  assert.throws(() => assertDesktopSender(main.event(), 'app:snapshot'), denied)
  main.mainFrame.url = petUrl
  assert.throws(() => assertDesktopSender(main.event(), 'pets:snapshot'), denied,
    'a main registration cannot move to the pet document')
})

test('IPC requires the actual main frame, even when a child or replacement frame has the same URL', () => {
  const main = renderer('main')
  assert.throws(() => assertDesktopSender(main.event({ url: entryUrl }), 'app:snapshot'), denied)
  assert.throws(() => assertDesktopSender(main.event(null), 'app:snapshot'), denied)
  assert.doesNotThrow(() => assertDesktopSender(main.event(), 'app:snapshot'))
})

test('development IPC permits the configured app entry but rejects sibling pages on the same server', () => {
  const main = renderer('main', devEntry, devEntry)
  assert.doesNotThrow(() => assertDesktopSender(main.event(), 'workspace:start'))
  main.mainFrame.url = `${devEntry}index.html#thread-1`
  assert.doesNotThrow(() => assertDesktopSender(main.event(), 'workspace:start'))
  main.mainFrame.url = `${devEntry}pet.html`
  assert.throws(() => assertDesktopSender(main.event(), 'workspace:start'), denied)
})

test('pet renderers can invoke only their own rendering and movement channels', () => {
  const pet = renderer('pet')
  for (const channel of ['pets:snapshot', 'pets:visual', 'pets:spritesheet', 'pets:bounds',
    'pets:moveTo', 'pets:endDrag', 'pets:activate', 'pets:menu'])
    assert.doesNotThrow(() => assertDesktopSender(pet.event(), channel), channel)
  for (const channel of ['app:snapshot', 'app:readFile', 'app:openExternal', 'workspace:start', 'workspace:permission',
    'pets:create', 'pets:update', 'pets:delete', 'pets:generateImages', 'pets:generateActionSheet', 'pets:list', 'pets:unknown'])
    assert.throws(() => assertDesktopSender(pet.event(), channel), denied, channel)
  pet.mainFrame.url = entryUrl
  assert.throws(() => assertDesktopSender(pet.event(), 'pets:snapshot'), denied)
})

test('destroyed contents and destroyed registrations cannot invoke previously permitted channels', () => {
  for (const role of ['main', 'pet'] as const) {
    const contents = renderer(role)
    const channel = role === 'main' ? 'app:snapshot' : 'pets:snapshot'
    contents.destroyed = true
    assert.throws(() => assertDesktopSender(contents.event(), channel), denied)
    contents.destroyed = false
    contents.emit('destroyed')
    assert.throws(() => assertDesktopSender(contents.event(), channel), denied,
      'registration must be revoked even if a stale object reports itself alive')
  }
})

test('main renderer identification is based on registration role and is revoked on destruction', () => {
  const main = renderer('main')
  assert.equal(isDesktopMain(null), false)
  assert.equal(isDesktopMain(new Contents(entryUrl).webContents), false)
  assert.equal(isDesktopMain(renderer('pet').webContents), false)
  assert.equal(isDesktopMain(main.webContents), true)
  main.emit('destroyed')
  assert.equal(isDesktopMain(main.webContents), false)
})

test('both renderer roles prevent webview attachment and navigation outside their entry', () => {
  for (const role of ['main', 'pet'] as const) {
    const contents = renderer(role)
    const ownUrl = role === 'main' ? entryUrl : petUrl
    const siblingUrl = role === 'main' ? petUrl : entryUrl
    let webviewPrevented = false
    contents.emit('will-attach-webview', { preventDefault: () => { webviewPrevented = true } })
    assert.equal(webviewPrevented, true, role)
    assert.equal(navigation(contents, ownUrl, true), false, role)
    assert.equal(navigation(contents, `${ownUrl}#route`, true), false, role)
    assert.equal(navigation(contents, ownUrl, false), true, 'matching entry does not authorize subframes')
    for (const url of [siblingUrl, 'https://example.com/', 'about:blank'])
      assert.equal(navigation(contents, url, true), true, `${role}: ${url}`)
  }
})

test('development navigation is confined to each registered main or pet entry', () => {
  const main = renderer('main', devEntry, devEntry)
  const petDev = `${devEntry}pet.html`
  const pet = renderer('pet', petDev, petDev)
  assert.equal(navigation(main, `${devEntry}index.html`, true), false)
  assert.equal(navigation(main, petDev, true), true)
  assert.equal(navigation(pet, petDev, true), false)
  assert.equal(navigation(pet, devEntry, true), true)
  assert.equal(navigation(pet, petDev, false), true)
})

test('pet windows deny popups and direct navigation away from their renderer', () => {
  const pet = renderer('pet')
  for (const url of [petUrl, entryUrl, 'https://example.com/', 'javascript:alert(1)'])
    assert.deepEqual(pet.openHandler?.({ url }), { action: 'deny' }, url)
  for (const [url, expected] of [[petUrl, false], [`${petUrl}#position`, false], [entryUrl, true], ['https://example.com/', true]] as const) {
    let prevented = false
    pet.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
    assert.equal(prevented, expected, url)
  }
})
