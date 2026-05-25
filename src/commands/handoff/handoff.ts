import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LocalCommandCall } from '../../types/command.js'

const HANDOFF_DIR = join(process.env.APPDATA || process.env.HOME || '.', '.haking', 'handoff')

export const call: LocalCommandCall = async (args, context) => {
  const { messages } = context
  mkdirSync(HANDOFF_DIR, { recursive: true })

  // 提取关键信息：最近的对话摘要、活跃任务、未完成工作
  const recentMessages = messages.slice(-30)
  const summary = compressSession(recentMessages, args)

  const filename = `handoff-${Date.now()}.json`
  const filepath = join(HANDOFF_DIR, filename)
  writeFileSync(filepath, JSON.stringify(summary, null, 2), 'utf-8')

  // 同时写一个 latest 指针
  writeFileSync(join(HANDOFF_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf-8')

  return {
    type: 'text' as const,
    value: `✓ 会话已保存到 ${filename}\n` +
      `  任务数: ${summary.tasks.length}\n` +
      `  上下文: ${summary.context.length} 条关键信息\n` +
      `  备注: ${summary.notes || '(无)'}\n\n` +
      `下次使用 /pickup 恢复。`,
  }
}

function compressSession(messages: any[], notes: string) {
  const tasks: string[] = []
  const context: string[] = []
  const toolResults: string[] = []

  for (const msg of messages) {
    if (!msg) continue
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')

    // 提取任务标记
    const taskMatch = content.match(/\[SET_TASK:\s*(.+?)\]/g)
    if (taskMatch) tasks.push(...taskMatch.map((m: string) => m.replace(/\[SET_TASK:\s*|\]/g, '')))

    // 提取工具调用结果摘要
    if (msg.role === 'tool' || msg.tool_use_id) {
      const preview = content.slice(0, 200)
      if (preview.trim()) toolResults.push(preview)
    }

    // 提取用户意图
    if (msg.role === 'user' && content.length > 10) {
      context.push(content.slice(0, 300))
    }
  }

  // 去重
  const uniqueTasks = [...new Set(tasks)]
  const uniqueContext = context.slice(-10)

  return {
    timestamp: new Date().toISOString(),
    notes: notes || '',
    tasks: uniqueTasks,
    context: uniqueContext,
    toolResults: toolResults.slice(-5),
    messageCount: messages.length,
  }
}
