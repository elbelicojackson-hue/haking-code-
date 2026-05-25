'use client'
import ParticlesBg from '@/components/ParticlesBg'
import TerminalTyper from '@/components/TerminalTyper'
import { motion } from 'framer-motion'

const FEATURES = [
  { icon: '⚔️', title: '/arena 对抗共识', desc: '4 个 AI 角色互相攻击、质疑、验证，博弈论驱动收敛' },
  { icon: '🔬', title: '/recon 逆向引擎', desc: '假设驱动的二进制分析，自动调度 20+ 安全工具' },
  { icon: '🛡️', title: '70+ 安全工具', desc: '从侦察到后渗透，nmap/nuclei/sqlmap/hashcat 一键调用' },
  { icon: '🧠', title: '反致幻协议', desc: 'CVE 强制引用、Firecrawl 实时查证、不确定就沉默' },
  { icon: '🎯', title: 'FuzzTag 引擎', desc: '笛卡尔积 Payload 生成，SecLists 60k⭐ 字典库集成' },
  { icon: '🌐', title: '知识图谱 Wiki', desc: 'D3 力导向可视化，爬取安全文章自动建立节点关系' },
]

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <ParticlesBg />

      {/* Hero */}
      <section className="relative flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="text-5xl md:text-7xl font-bold mb-4"
        >
          <span className="glow-cyan">⚡ Haking Code</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.8 }}
          className="text-lg md:text-xl text-gray-400 mb-10 max-w-xl"
        >
          全球最强的 AI 驱动网络安全终端 Agent
          <br />
          <span className="text-sm text-gray-500">强制思考 · 从不编造 · 每一句话都有据可查</span>
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
        >
          <TerminalTyper />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
          className="mt-10 flex gap-4"
        >
          <a
            href="https://github.com/elbelicojackson-hue/haking-code-"
            target="_blank"
            className="px-6 py-3 rounded-md bg-cyber-cyan/10 border border-cyber-cyan text-cyber-cyan hover:bg-cyber-cyan/20 transition-all hover:shadow-[0_0_20px_rgba(0,255,247,0.3)]"
          >
            ⭐ GitHub
          </a>
          <a
            href="https://github.com/elbelicojackson-hue/haking-code-#-使用声明--不按规矩来直接报废"
            target="_blank"
            className="px-6 py-3 rounded-md bg-cyber-purple/10 border border-cyber-purple text-cyber-purple hover:bg-cyber-purple/20 transition-all hover:shadow-[0_0_20px_rgba(168,85,247,0.3)]"
          >
            📖 快速开始
          </a>
        </motion.div>
      </section>

      {/* Features */}
      <section className="relative px-6 py-24 max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16 glow-purple">核心能力</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="p-6 rounded-lg border border-gray-800 bg-cyber-card/50 backdrop-blur-sm hover:border-cyber-cyan/50 transition-all hover:shadow-[0_0_15px_rgba(0,255,247,0.1)] group"
            >
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="text-lg font-bold text-white mb-2 group-hover:text-cyber-cyan transition-colors">{f.title}</h3>
              <p className="text-sm text-gray-400">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Stats */}
      <section className="relative px-6 py-16 border-t border-gray-800">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {[
            ['70+', '安全工具'],
            ['183', 'AI Skills'],
            ['1M', '上下文窗口'],
            ['¥0', '全部免费'],
          ].map(([num, label], i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <div className="text-3xl font-bold text-cyber-cyan">{num}</div>
              <div className="text-sm text-gray-500 mt-1">{label}</div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 px-6 py-8 text-center text-sm text-gray-600">
        <p>MIT License · 仅供合法安全研究和教育用途</p>
        <p className="mt-2">
          Built with Next.js · tsParticles · Framer Motion
        </p>
      </footer>
    </main>
  )
}
