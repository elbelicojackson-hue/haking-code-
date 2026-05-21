import React, { useState, useEffect } from 'react';
import { Box, Text } from '@anthropic/ink';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { getOriginalCwd } from '../../bootstrap/state.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

const WIKI_DIR = resolve(import.meta.dirname || '.', '../../../wiki');
const PORT = Number(process.env.WIKI_PORT || 7891);
const URL = `http://127.0.0.1:${PORT}`;

type Mode = 'idle' | 'serving' | 'crawling' | 'done' | 'error';

function WikiPanel({ args, onDone }: { args: string; onDone: (msg: string, opts?: any) => void }): React.ReactNode {
  const [mode, setMode] = useState<Mode>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || 'serve';

    if (sub === 'serve' || sub === 'start') {
      startServer();
    } else if (sub === 'add' || sub === 'crawl') {
      const url = parts.slice(1).join(' ');
      if (!url) {
        setMode('error');
        setMessage('用法: /wiki add <url>');
        setTimeout(() => onDone('用法: /wiki add <url>'), 1500);
      } else {
        crawlUrl(url);
      }
    } else if (sub === 'open') {
      openBrowser();
      onDone(`✓ 已打开 ${URL}`);
    } else {
      setMode('error');
      setMessage(`未知子命令: ${sub}\n用法: /wiki serve | /wiki add <url> | /wiki open`);
      setTimeout(() => onDone(`未知子命令: ${sub}`), 2000);
    }
  }, []);

  async function startServer() {
    setMode('serving');
    setMessage(`启动 Wiki server...`);

    // Check if already running
    try {
      const res = await fetch(`${URL}/api/graph`);
      if (res.ok) {
        setMessage(`Wiki 已在运行 → ${URL}`);
        openBrowser();
        setTimeout(() => onDone(`✓ Wiki 已在运行 ${URL}`), 1000);
        return;
      }
    } catch {
      // Not running, start it
    }

    const child = spawn('bun', ['server.ts'], {
      cwd: WIKI_DIR,
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        WIKI_ROOT: resolve(getOriginalCwd(), '.haking', 'wiki'),
        WIKI_PORT: String(PORT),
      },
    });
    child.unref();

    // Wait for server to be ready
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const res = await fetch(`${URL}/api/graph`);
        if (res.ok) { ready = true; break; }
      } catch { /* not yet */ }
    }

    if (ready) {
      openBrowser();
      setMessage(`✓ Wiki running at ${URL}`);
      setTimeout(() => onDone(`✓ Wiki running at ${URL}`), 1200);
    } else {
      setMode('error');
      setMessage('Wiki server 启动超时，请手动 cd wiki && bun run dev');
      setTimeout(() => onDone('Wiki server 启动超时'), 2000);
    }
  }

  async function crawlUrl(url: string) {
    setMode('crawling');
    setMessage(`爬取中: ${url}`);

    // Try via running wiki server first
    try {
      const res = await fetch(`${URL}/api/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: url, kind: 'page', url }),
      });
      if (res.ok) {
        // Trigger crawl via WS is cleaner, but REST POST to a crawl endpoint
        // doesn't exist yet. Use the direct import as fallback.
      }
    } catch {
      // Server not running — that's fine, we'll crawl directly
    }

    // Direct crawl (works whether server is running or not)
    try {
      const { WikiGraph } = await import('../../../wiki/core/graph.js');
      const { WikiCrawler } = await import('../../../wiki/core/crawler.js');
      const wikiRoot = resolve(getOriginalCwd(), '.haking', 'wiki');
      const graph = new WikiGraph(resolve(wikiRoot, 'graph.json'));
      const crawler = new WikiCrawler(graph, { wikiRoot });
      const result = await crawler.crawl(url);
      setMode('done');
      setMessage(`✓ ${result.title}\n  → ${result.node.id}`);
      setTimeout(() => onDone(`✓ 已爬取: ${result.title}`), 1500);
    } catch (err) {
      setMode('error');
      setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => onDone(`爬取失败: ${err instanceof Error ? err.message : String(err)}`), 2500);
    }
  }

  function openBrowser() {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', URL], { stdio: 'ignore', detached: true }).unref();
      } else {
        spawn('open', [URL], { stdio: 'ignore', detached: true }).unref();
      }
    } catch { /* ignore */ }
  }

  const color = mode === 'error' ? 'error' : mode === 'done' ? 'success' : 'claude';

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="claude">📚 Haking Wiki</Text>
      <Text color={color}>{message}</Text>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  return <WikiPanel args={args || 'serve'} onDone={onDone} />;
};
