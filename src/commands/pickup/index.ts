import type { Command } from '../../commands.js'

const pickup = {
  type: 'local',
  name: 'pickup',
  description: '加载上一个会话通过 /handoff 保存的未完成任务和上下文，继续工作。',
  isEnabled: () => true,
  argumentHint: '',
  load: () => import('./pickup.js'),
} satisfies Command

export default pickup
