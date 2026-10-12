import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

type Role = 'main' | 'pet'
type Registration = { role: Role; entry: string; devEntry?: string }
const renderers = new WeakMap<WebContents, Registration>()
const petChannels = new Set([
  'pets:snapshot', 'pets:visual', 'pets:spritesheet', 'pets:bounds',
  'pets:moveTo', 'pets:endDrag', 'pets:activate', 'pets:menu'
])

export function matchesDesktopEntry(raw: string, entry: string, devEntry?: string): boolean {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    if (url.protocol === 'file:') return path.resolve(fileURLToPath(url)) === path.resolve(entry)
    if (!devEntry) return false
    const dev = new URL(devEntry)
    return url.origin === dev.origin && (url.pathname === dev.pathname ||
      (dev.pathname === '/' && url.pathname === '/index.html'))
  } catch { return false }
}

export function registerDesktopWindow(window: BrowserWindow, registration: Registration): void {
  const contents = window.webContents
  renderers.set(contents, registration)
  contents.once('destroyed', () => renderers.delete(contents))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !matchesDesktopEntry(event.url, registration.entry, registration.devEntry))
      event.preventDefault()
  })
  if (registration.role === 'pet') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!matchesDesktopEntry(url, registration.entry, registration.devEntry)) event.preventDefault()
    })
  }
}

export function isDesktopMain(contents: WebContents | null): boolean {
  return !!contents && renderers.get(contents)?.role === 'main'
}

export function assertDesktopSender(event: IpcMainInvokeEvent, channel: string): void {
  const registration = renderers.get(event.sender)
  if (!registration || event.sender.isDestroyed() || !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !matchesDesktopEntry(event.senderFrame.url, registration.entry, registration.devEntry) ||
    (registration.role === 'pet' && !petChannels.has(channel))) {
    throw new Error('此页面无权调用桌面功能。')
  }
}
