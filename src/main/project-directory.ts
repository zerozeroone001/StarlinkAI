import fs from 'node:fs'
import path from 'node:path'
import { isValidDirectoryName, type ProjectDirectoryInput } from '../shared/project-directory'

export function resolveProjectDirectory(folder: string): string {
  if (typeof folder !== 'string' || !folder.trim() || folder.length > 32768 ||
    folder.includes('\0') || !path.isAbsolute(folder))
    throw new Error('请选择项目目录，或输入完整的绝对路径。')
  try {
    const resolved = fs.realpathSync(path.resolve(folder))
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch {
    throw new Error('项目目录不存在或无法访问，请重新选择。')
  }
}

export function prepareProjectDirectory(input: ProjectDirectoryInput): string {
  if (!input || !['existing', 'new'].includes(input.mode))
    throw new Error('请选择已有目录或创建新目录。')
  if (input.mode === 'existing') return resolveProjectDirectory(input.path)
  if (typeof input.name !== 'string' || !isValidDirectoryName(input.name))
    throw new Error('文件夹名称无效，请勿使用路径分隔符、特殊字符或系统保留名称。')
  const parent = resolveProjectDirectory(input.parent)
  const target = path.join(parent, input.name)
  try {
    // Only create a single new folder; never reuse or replace an existing entry.
    fs.mkdirSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('此目录已存在，请选择已有目录或使用其他文件夹名称。')
    throw new Error('创建项目目录失败，请检查写入权限或更换位置。')
  }
  return resolveProjectDirectory(target)
}
