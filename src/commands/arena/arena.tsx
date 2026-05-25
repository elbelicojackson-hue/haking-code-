import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { firecrawlSearch } from '../../services/firecrawl.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

type Chain = { id: string; role: string; axis: string; color: string }

const FOUR_CHAINS: Chain[] = [
  { id: 'C1', role: 'Proposer', axis: '正向构建', color: 'green' },
  { id: 'C2', role: 'Challenger', axis: '逻辑攻击', color: 'red' },
  { id: 'C3', role: 'Verifier', axis: '事实查证', color: 'blue' },
  { id: 'C4', role: 'Synthesizer', axis: '综合收敛', color: 'yellow' },
];

type ChainResp = { chainId: string; role: string; text: string; confidence: number }
type RoundData = { number: number; responses: ChainResp[] }

async function callLLM(system: string, user: string): Promise<string> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, temperature: 0.7, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  return json.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') ?? '';
}

function parseConf(text: string): number {
  const m = text.match(/confidence[:\s]*([0-9.]+)/i);
  return m ? Number(m[1]) || 0.5 : 0.5;
}

function ArenaPanel({ claim, onDone }: { claim: string; onDone: (msg: string, opts?: any) => void }): React.ReactNode {
  const [rounds, setRounds] = useState<RoundData[]>([]);
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running');
  const [consensus, setConsensus] = useState('');
  const [currentChain, setCurrentChain] = useState('');

  useEffect(() => {
    run().catch(err => {
      setStatus('error');
      setConsensus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      onDone('', { display: 'system' });
    });
  }, []);

  async function run() {
    const allRounds: RoundData[] = [];

    for (let r = 0; r < 4; r++) {
      const history = allRounds.map(rd =>
        rd.responses.map(resp => `[${resp.chainId}/${resp.role}] ${resp.text}`).join('\n')
      ).join('\n---\n');

      const round: RoundData = { number: r + 1, responses: [] };

      // Run 4 chains in parallel (single model, different prompts)
      setCurrentChain('C1+C2+C3+C4 thinking...');

      // C3 Verifier gets web search results as external truth anchor
      let webContext = '';
      try {
        const searchResults = await firecrawlSearch(claim, 3);
        if (searchResults.length > 0 && !searchResults[0]!.startsWith('[Firecrawl')) {
          webContext = `\n\n[Web Search Results]:\n${searchResults.join('\n---\n')}`;
        }
      } catch {}

      const chainResults = await Promise.all(FOUR_CHAINS.map(async chain => {
        const sys = `你是 ${chain.id}(${chain.role})，职责: ${chain.axis}。
${chain.id === 'C1' ? '提出论点，构建论证，寻找支持证据。' : ''}
${chain.id === 'C2' ? '质疑 C1 的论点，找逻辑漏洞和反例。不要为反对而反对。' : ''}
${chain.id === 'C3' ? '验证事实性声明，区分可验证事实和主观判断，标注知识边界。你有 web search 结果可参考。' : ''}
${chain.id === 'C4' ? '综合各方论点，标注共识和分歧，判断是否收敛。' : ''}
回复 200 字以内。末尾写 confidence: 0.0-1.0 表示你对结论的置信度。`;

        const user = r === 0
          ? `分析: ${claim}${chain.id === 'C3' ? webContext : ''}`
          : `Claim: ${claim}\n\n前轮记录:\n${history}\n\nRound ${r + 1}: 回应其他链的论点。${chain.id === 'C3' ? webContext : ''}`;

        try {
          const text = await callLLM(sys, user);
          return { chainId: chain.id, role: chain.role, text, confidence: parseConf(text) };
        } catch (err) {
          return { chainId: chain.id, role: chain.role, text: `[Error: ${err instanceof Error ? err.message : String(err)}]`, confidence: 0 };
        }
      }));

      round.responses = chainResults;

      allRounds.push(round);
      setRounds([...allRounds]);
      setCurrentChain('');

      // Check convergence: all confidence > 0.85
      const avgConf = round.responses.reduce((s, r) => s + r.confidence, 0) / 4;
      if (avgConf > 0.85 && r >= 1) break;
    }

    // Synthesize
    setCurrentChain('Synthesizing...');
    const fullHistory = allRounds.map(rd =>
      rd.responses.map(r => `[${r.chainId}/${r.role}] conf=${r.confidence.toFixed(2)}\n${r.text}`).join('\n\n')
    ).join('\n\n── Round ──\n\n');

    const final = await callLLM(
      '你是中立裁判。综合 4 链辩论输出最终共识。标注共识度和分歧点。300字以内。',
      `Claim: ${claim}\n\n辩论记录:\n${fullHistory}`,
    );
    setConsensus(final);
    setStatus('done');
    setCurrentChain('');
    onDone('', { display: 'system' });
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="ansi:cyan">⚔ Arena — 4 链对抗共识</Text>
      <Text dimColor>  {claim}</Text>
      <Text dimColor>  C1 Proposer · C2 Challenger · C3 Verifier · C4 Synthesizer</Text>

      {rounds.map(round => (
        <Box key={round.number} flexDirection="column" marginTop={1}>
          <Text bold dimColor>── Round {round.number} ──</Text>
          {round.responses.map(resp => (
            <Box key={resp.chainId} flexDirection="column" paddingLeft={1}>
              <Text color={FOUR_CHAINS.find(c => c.id === resp.chainId)?.color as any} bold>
                [{resp.chainId}] {resp.role} <Text dimColor>conf={resp.confidence.toFixed(2)}</Text>
              </Text>
              <Text wrap="wrap">{resp.text.slice(0, 300)}</Text>
            </Box>
          ))}
        </Box>
      ))}

      {status === 'running' && currentChain && (
        <Box marginTop={1}><Text color="ansi:yellow">⏳ {currentChain}...</Text></Box>
      )}

      {status === 'done' && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
          <Text bold color="ansi:green">✓ Consensus</Text>
          <Text wrap="wrap">{consensus}</Text>
        </Box>
      )}

      {status === 'error' && (
        <Box marginTop={1}><Text color="ansi:red">{consensus}</Text></Box>
      )}
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const claim = (args ?? '').trim();
  if (!claim) {
    onDone('用法: /arena <问题>\n例: /arena 人类在未来会被AI毁灭吗', { display: 'system' });
    return null;
  }
  return <ArenaPanel claim={claim} onDone={onDone} />;
};
