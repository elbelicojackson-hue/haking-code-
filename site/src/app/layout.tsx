import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Haking Code — AI 驱动网络安全终端 Agent',
  description: '全球最强的 AI 驱动网络安全终端 Agent。4 链对抗共识、PEV 假设驱动逆向、70+ 安全工具集成。',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
