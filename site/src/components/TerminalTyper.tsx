'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

const LINES = [
  { prompt: '❯', text: '/arena 量子计算机能在 2028 年破解 RSA-2048 吗', delay: 0 },
  { prompt: 'C1', text: 'Proposer → 构建论点，寻找支持证据...', delay: 2000 },
  { prompt: 'C2', text: 'Challenger → 逻辑攻击，找漏洞和反例...', delay: 3500 },
  { prompt: 'C3', text: 'Verifier → 实时网络搜索事实查证...', delay: 5000 },
  { prompt: 'C4', text: '✓ 共识达成 — 置信度 0.94', delay: 6500 },
]

export default function TerminalTyper() {
  const [visibleLines, setVisibleLines] = useState(0)

  useEffect(() => {
    const timers = LINES.map((line, i) =>
      setTimeout(() => setVisibleLines(i + 1), line.delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className="w-full max-w-2xl rounded-lg border border-cyan-900/50 bg-black/60 backdrop-blur-sm p-6 font-mono text-sm">
      {/* Title bar */}
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-cyan-900/30">
        <span className="w-3 h-3 rounded-full bg-red-500/80" />
        <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
        <span className="w-3 h-3 rounded-full bg-green-500/80" />
        <span className="ml-3 text-xs text-gray-500">haking-code — /arena</span>
      </div>
      {/* Lines */}
      {LINES.slice(0, visibleLines).map((line, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-2"
        >
          <span className={i === 0 ? 'text-cyber-cyan' : i === LINES.length - 1 ? 'text-green-400' : 'text-cyber-purple'}>
            {line.prompt}
          </span>
          <span className="text-gray-300 ml-2">{line.text}</span>
        </motion.div>
      ))}
      {/* Cursor */}
      {visibleLines < LINES.length && (
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ repeat: Infinity, duration: 0.8 }}
          className="inline-block w-2 h-4 bg-cyber-cyan"
        />
      )}
    </div>
  )
}
