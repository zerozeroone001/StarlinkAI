export type ProjectDirectoryInput =
  | { mode: 'existing'; path: string }
  | { mode: 'new'; parent: string; name: string }

export function isAbsoluteDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') &&
    /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|\/)/i.test(value)
}

export function isValidDirectoryName(value: string): boolean {
  return !!value && value.length <= 100 && value === value.trim() &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}

export function projectDirectoryPreview(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return parent.replace(/[\\/]+$/, '') + separator + name
}
