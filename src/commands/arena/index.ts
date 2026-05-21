import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'arena',
  aliases: ['debate', 'consensus'],
  description: '多 LLM 对抗共识 — 多个模型围绕一个问题辩论并达成共识',
  load: () => import('./arena.js'),
} satisfies Command
