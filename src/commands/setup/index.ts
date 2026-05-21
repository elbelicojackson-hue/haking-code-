import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'setup',
  aliases: ['config-api', 'configure'],
  description: '配置 API Key 和模型（持久化保存，下次启动自动加载）',
  load: () => import('./setup.js'),
} satisfies Command
