import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'island',
  aliases: ['float'],
  description: '启动灵动岛浮窗',
  load: () => import('./island.js'),
} satisfies Command
