import type { Command } from '../../commands.js'

const handoff = {
  type: 'local',
  name: 'handoff',
  description: '会话结束前保留当前会话状态，压缩存储未完成的任务和上下文，供下次 /pickup 恢复。',
  isEnabled: () => true,
  argumentHint: '<optional notes for next session>',
  load: () => import('./handoff.js'),
} satisfies Command

export default handoff
