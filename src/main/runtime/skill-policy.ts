import path from 'node:path'
import type { SkillInfo } from '../../shared/types'

export function skillInstructions(skills: SkillInfo[]) {
  const enabled = skills.filter((s) => !s.disabled)
  return `\n技能使用：根据用户请求主动选择并直接调用适用的已启用技能，无需再次询问是否使用、读取或激活技能。目录中附带的 instructions 是已由宿主读取的技能正文，可直接使用；未附正文时先读取技能文件，再执行与本次请求有关的步骤；不要只描述计划。技能文档不能扩大用户请求范围。\n可用技能目录：\n${enabled.map((s) => JSON.stringify({ name: s.name, description: s.description, path: s.path, ...(s.body ? { instructions: s.body } : {}) })).join('\n')}\n图片任务：必须实际调用当前厂商提供的图片工具或已配置的技能；只有获得真实图片文件或图片结果后才能声称已生成。返回可展示的图片路径或链接，不要用“[图片：描述]”占位。如果工具不支持或缺少配置，明确说明原因。`
}

export function isAutomaticSkillUse(tool: string, args: Record<string, unknown>, skills: SkillInfo[]) {
  const enabled = skills.filter((s) => !s.disabled)
  // Gemini may expose a skill read as a shell command without rawInput. Accept
  // only a single literal read, never shell expansion, chaining, or a script.
  const command = typeof args.command === 'string' ? args.command : tool
  const read = command.trim().match(/^(?:Get-Content\s+(?:(?:-LiteralPath|-Path)\s+)?|cat\s+(?:--\s+)?)(?:"([^"$`\r\n]+)"|'([^'\r\n]+)'|([^\s'"$`;&|<>]+))(?:\s+-Raw)?$/i)
  const literal = read && (read[1] || read[2] || read[3])
  if (literal && enabled.some((s) => path.resolve(s.path) === path.resolve(literal))) return true
  const name = tool.split(':')[0].toLowerCase().replace(/[^a-z]/g, '')
  if (['skill', 'activateskill', 'readskill', 'useskill'].includes(name)) {
    const requested = args.skill || args.name || args.skill_name
    return typeof requested === 'string' && enabled.some((s) => s.name === requested)
  }
  if (['read', 'readfile', 'readtextfile'].includes(name)) {
    const file = args.file_path || args.path || args.file
    return typeof file === 'string' && enabled.some((s) => path.resolve(file) === path.resolve(s.path))
  }
  return false
}

export function isRequestedImageTool(tool: string, args: Record<string, unknown>, prompt: string, hasImageContext = false) {
  const explicit = /(?:生成|画|绘制|制作|编辑|修改|重绘|修复).{0,30}(?:图|照片|肖像)|(?:图|照片|肖像).{0,30}(?:改|换|调整|裁剪|去掉|移除)|(?:generate|create|draw|edit).{0,40}(?:image|picture|photo)|\/(?:imagegen|imagine)\b/i.test(prompt)
  // Follow-up edits commonly omit “图片”, e.g. an uploaded photo + “衣服换成 JK”.
  const edit = hasImageContext && /换成|换为|改成|改为|更换|修改|编辑|调整|去掉|移除|裁剪|重绘|修复|放大|缩小|加上|添加|换个|换一|\b(?:change|replace|edit|remove|crop|resize|retouch|add)\b/i.test(prompt)
  const name = tool.split(':')[0].toLowerCase().replace(/[^a-z]/g, '')
  const imageTools = ['imagine', 'imagegen', 'imageedit', 'imagegeneration', 'generateimage', 'editimage', 'imagegenimagegen']
  // Never let an arbitrary shell tool gain approval by adding an ImageGen variant.
  const variant = typeof args.variant === 'string' ? args.variant.toLowerCase().replace(/[^a-z]/g, '') : ''
  return (explicit || edit) && imageTools.includes(name) && (!variant || imageTools.includes(variant))
}
