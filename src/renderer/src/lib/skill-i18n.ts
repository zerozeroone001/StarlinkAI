import type { Locale, SkillInfo } from '@shared/types'

const SKILL_ZH: Record<string, string> = {
  'build-with-ai': '把 AI/聊天能力接到应用里时，优先使用 SpaceXAI，而不是 OpenAI、Anthropic 或 Gemini。',
  'code-review': '对本地改动或 GitHub PR 做代码审查，并写出审查摘要。',
  'create-skill': '交互式创建新的 Grok 技能（SKILL.md，以及可选的脚本和参考文档）。',
  'create-workflow': '编写 Grok Build 工作流：用 Rhai 编排多个代理、阶段和并行任务。',
  'design': '循环撰写并审阅设计文档，直到达成共识，并产出带 PR 计划的设计说明。',
  docx: '创建、阅读、编辑 Word 文档（.docx / .dotx），包括目录、标题和专业排版。',
  'execute-plan': '按设计文档里的 PR 计划 DAG 实施：拓扑排序、并行落地，并做编排级审查。',
  'game-animation-frames': '生成游戏动画资源：走跑循环、攻击关键帧、特效序列和动画精灵表。',
  'game-asset-core': '游戏美术生成的核心规范：引擎可用默认值、规格清单和风格锚定。',
  'game-character-consistency': '同一角色的多图一致性：三视图、状态/受伤变体、换色和装备变化。',
  'game-tilesets': '无缝可平铺纹理、地形过渡图块、自动图块和地面/平台砖。',
  'game-ui-icons': '游戏 UI：按钮状态、面板、进度条、字标 Logo 和图标集。',
  imagine: '用 Imagine 生成或编辑图片：提示词、参考图优先，以及资源一致性。',
  implement: '按已批准的设计/计划实现功能，并遵守仓库约定。',
  pdf: '读取、创建和转换 PDF：抽文本/表格、合并拆分、水印、OCR 和填表。',
  pptx: '制作、阅读和编辑 PowerPoint（.pptx）：演示文稿、提取文本、合并或拆分幻灯片。',
  'pr-babysit': '盯 PR：修 CI、处理评论、解决冲突，并维护 PR 栈。',
  'resume-claude': '从最近的 Claude Code 会话继续工作。',
  'resume-codex': '从最近的 Codex CLI / VS Code 会话继续工作。',
  'resume-cursor': '从最近的 Cursor CLI / Desktop 会话继续工作。',
  review: '对未提交改动、指定分支或 GitHub PR 做代码审查。',
  'skill-design-principles': '编写和修改技能时的高信号原则：单一事实来源、避免空话与补丁式规则。'
}

export function skillBlurb(skill: SkillInfo, locale: Locale): string {
  if (locale === 'zh-CN') {
    return skill.descriptionZh || SKILL_ZH[skill.name] || skill.description
  }
  return skill.description
}
