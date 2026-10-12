import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { archiveContext } from './run-journal'

async function fileStamp(file: string) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return undefined
    return JSON.stringify([await fs.realpath(file), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
  } catch { return undefined }
}

// Only the latest payload for each destination can be reused: later worker/lead archives may overwrite it.
export function createContextArchive(archive: typeof archiveContext) {
  const latest = new Map<string, { hash: string; file: string; stamp: string }>()
  return async (...args: Parameters<typeof archiveContext>) => {
    const [cwd, request] = args
    const key = JSON.stringify([path.resolve(cwd), request.assistantScopeId || '', request.id])
    const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex')
    const previous = latest.get(key)
    if (previous?.hash === hash && await fileStamp(previous.file) === previous.stamp)
      return { path: previous.file, reused: true }
    latest.delete(key)
    const file = await archive(...args)
    const stamp = await fileStamp(file)
    if (stamp) {
      latest.set(key, { hash, file, stamp })
      if (latest.size > 200) latest.delete(latest.keys().next().value!)
    }
    return { path: file, reused: false }
  }
}
