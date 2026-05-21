import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'wiki',
  aliases: ['kb', 'knowledge'],
  description: '知识图谱 — /wiki serve 启动 Web UI · /wiki add <url> 爬取页面',
  load: () => import('./wiki.js'),
} satisfies Command
