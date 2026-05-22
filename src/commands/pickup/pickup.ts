import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { LocalCommandCall } from '../../types/command.js'

const HANDOFF_DIR = join(process.env.APPDATA || process.env.HOME || '.', '.haking', 'handoff')

export const call: LocalCommandCall = async (_args, _context) => {
  const latestPath = join(HANDOFF_DIR, 'latest.json')

  if (!existsSync(latestPath)) {
    // 尝试找最新的 handoff 文件
    if (!existsSync(HANDOFF_DIR)) {
      return { type: 'text' as const, text: '没有找到任何 handoff 记录。先用 /handoff 保存一个会话。' }
    }
    const files = readdirSync(HANDOFF_DIR).filter(f => f.startsWith('handoff-') && f.endsWith('.json')).sort().reverse()
    if (files.length === 0) {
      return { type: 'text' as const, text: '没有找到任何 handoff 记录。先用 /handoff 保存一个会话。' }
    }
  }

  const raw = readFileSync(latestPath, 'utf-8')
  const data = JSON.parse(raw)

  const lines: string[] = []
  lines.push(`📋 恢复上次会话 (${data.timestamp})`)
  lines.push('')

  if (data.notes) {
    lines.push(`📝 备注: ${data.notes}`)
    lines.push('')
  }

  if (data.tasks.length > 0) {
    lines.push('🎯 未完成任务:')
    for (const t of data.tasks) lines.push(`  • ${t}`)
    lines.push('')
  }

  if (data.context.length > 0) {
    lines.push('💡 上下文摘要:')
    for (const c of data.context.slice(-5)) lines.push(`  - ${c.slice(0, 100)}`)
    lines.push('')
  }

  if (data.toolResults.length > 0) {
    lines.push('🔧 最近工具结果:')
    for (const r of data.toolResults.slice(-3)) lines.push(`  > ${r.slice(0, 120)}`)
    lines.push('')
  }

  lines.push(`(原会话共 ${data.messageCount} 条消息)`)

  return { type: 'text' as const, text: lines.join('\n') }
}
