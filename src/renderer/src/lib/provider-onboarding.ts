import type { ModelChoice, RunSnapshot, RuntimeProvider } from '@shared/runtime'
import type { Member, Team } from './collaboration-data'

export function onboardingContextError(teamId: string, generation: number,
  workspace: { activeTeamId: string; teams: Team[] }, currentGeneration: number): string | null {
  if (generation !== currentGeneration) return '工作区已被替换，请关闭此窗口后重新选择账号。'
  if (!workspace.teams.some((team) => team.id === teamId)) return '原会话已被删除，请关闭此窗口后重新选择账号。'
  if (workspace.activeTeamId !== teamId) return '当前会话已切换，请关闭此窗口后在目标会话中重新选择账号。'
  return null
}

export function currentConversationBlockReason(team: Team | undefined, runs: Record<string, RunSnapshot>): string | null {
  if (!team) return '原会话已不存在，请返回工作区重新选择。'
  if (team.kind !== 'conversation' || team.gallery) return '项目与画廊的配置保持不变；可将此服务设为新会话默认。'
  if (team.members.length !== 1 || !team.members[0].isLead) return '此会话有多个员工或独立配置，不能在连接账号时替换。'
  if (team.messages.length || team.tasks.length || team.artifacts.length || team.deletedMessageIds?.length)
    return '此会话已有历史或工作成果，连接账号不会替换其配置。'
  if (Object.values(runs).some((run) => run.workspaceId === team.id && ['queued', 'running', 'needs_permission'].includes(run.status)))
    return '此会话仍有执行，请结束后再选择；原配置保持不变。'
  return null
}

export function availableOnboardingChoice(provider: RuntimeProvider, preferred: ModelChoice = {}): ModelChoice {
  const model = provider.models.find((model) => model.id === preferred.model)
    || provider.models.find((model) => model.isDefault) || provider.models[0]
  return { model: model?.id, effort: model?.efforts.includes(preferred.effort || '') ? preferred.effort : undefined }
}

export function onboardingMember(team: Team | undefined, runs: Record<string, RunSnapshot>, provider: RuntimeProvider, choice: ModelChoice): Member {
  const blocked = currentConversationBlockReason(team, runs)
  if (blocked) throw new Error(blocked)
  const model = choice.model ? provider.models.find((model) => model.id === choice.model)
    : provider.models.find((model) => model.isDefault) || provider.models[0]
  if (!model || (choice.effort && !model.efforts.includes(choice.effort))) throw new Error('所选型号或推理等级已不可用，请重新选择。')
  return { ...team!.members[0], provider: provider.id, model: choice.model, effort: choice.effort }
}
