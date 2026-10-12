import { EventEmitter } from 'node:events'
export { app, nativeImage } from 'electron'
const display = { workArea: { x: 0, y: 0, width: 1200, height: 900 } }
export const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display] }
export const Menu = { buildFromTemplate: () => ({ popup: () => {} }) }
export class BrowserWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {}, send: (channel: string, payload: unknown) => {
    const ctx = globalThis as unknown as { petTestEvents: unknown[] }
    ctx.petTestEvents.push({ channel, payload })
  } })
  isDestroyed() { return false }
  isVisible() { return true }
  isMinimized() { return false }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setMenuBarVisibility() {}
  showInactive() {}
  restore() {}
  getPosition() { return [0, 0] }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
}
