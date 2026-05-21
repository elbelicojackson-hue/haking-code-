import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getModelUsage } from '../../bootstrap/state.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { formatTokens } from '../../utils/format.js';

/**
 * ModelStatsPanel
 *
 * 展示当前会话中 deepseek-v4-flash / deepseek-v4-pro 两个模型的
 * token 用量与人民币花费，挂在输入框下方。
 *
 * 设计要点：
 * 1. 单价直接用 DeepSeek 官方报价（CNY/Mtok），不走 cost-tracker 的
 *    USD 计价路径——src/utils/modelCost.ts 里 firstParty 映射到
 *    deepseek-v4-* 的单价仍是 Claude Sonnet/Opus 的 $3/$15、$15/$75，
 *    对 DeepSeek 是错的。这里独立计算。
 * 2. cost 数据在 STATE.modelUsage 里被 mutate，不会触发 React 重渲染，
 *    所以面板用 1s 轮询一次的方式刷新。
 * 3. 仅在 ANTHROPIC_BASE_URL 指向 DeepSeek 时显示，其他厂商场景
 *    （真正的 Claude/OpenAI 等）隐藏避免误导。
 * 4. 键名按 'flash' / 'pro' 子串归桶，兼容多版本变体（例如未来的
 *    deepseek-v4-pro-20260101）。
 */

type DeepSeekPricing = {
  /** 缓存命中输入（CNY per million tokens）*/
  cacheHitInput: number;
  /** 缓存未命中输入（CNY per million tokens）*/
  cacheMissInput: number;
  /** 输出（CNY per million tokens）*/
  output: number;
};

// DeepSeek 官方报价（V4 系列）
// flash: 缓存命中 0.02 / 未命中 1 / 输出 2 元 / Mtok
// pro 当前 2.5 折优惠价：缓存命中 0.025 / 未命中 3 / 输出 6 元 / Mtok
// pro 原价：缓存命中 0.1 / 未命中 12 / 输出 24 元 / Mtok
const FLASH_PRICING: DeepSeekPricing = {
  cacheHitInput: 0.02,
  cacheMissInput: 1,
  output: 2,
};
const PRO_PRICING_DISCOUNT: DeepSeekPricing = {
  cacheHitInput: 0.025,
  cacheMissInput: 3,
  output: 6,
};
const PRO_PRICING_FULL: DeepSeekPricing = {
  cacheHitInput: 0.1,
  cacheMissInput: 12,
  output: 24,
};

// DEEPSEEK_PRO_FULL_PRICE=1 切换 pro 列到原价（活动结束后用）。
// 同时 src/utils/modelCost.ts 的 USD 计价也读这个环境变量，保持一致。
function getProPricing(): DeepSeekPricing {
  return process.env.DEEPSEEK_PRO_FULL_PRICE === '1'
    ? PRO_PRICING_FULL
    : PRO_PRICING_DISCOUNT;
}

// CNY → USD 汇率（与 modelCost.ts 同步，1 USD ≈ 7.2 CNY）
const CNY_PER_USD = 7.2;

type ModelKind = 'flash' | 'pro';

type Bucket = {
  kind: ModelKind;
  fullName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  pricing: DeepSeekPricing;
};

function classifyModel(name: string): ModelKind | null {
  const n = name.toLowerCase();
  if (n.includes('flash')) return 'flash';
  if (n.includes('pro')) return 'pro';
  return null;
}

function computeCNY(b: Bucket): number {
  const p = b.pricing;
  return (
    (b.inputTokens / 1_000_000) * p.cacheMissInput +
    (b.cacheReadInputTokens / 1_000_000) * p.cacheHitInput +
    // 缓存写入按未命中输入的价格收费（DeepSeek 未单列，按行业惯例归类）
    (b.cacheCreationInputTokens / 1_000_000) * p.cacheMissInput +
    (b.outputTokens / 1_000_000) * p.output
  );
}

function formatCNY(v: number): string {
  if (v <= 0) return '¥0';
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  if (v < 1) return `¥${v.toFixed(3)}`;
  if (v < 100) return `¥${v.toFixed(2)}`;
  return `¥${v.toFixed(1)}`;
}

function isDeepSeekActive(): boolean {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '';
  return baseUrl.toLowerCase().includes('deepseek');
}

function ModelStatsPanelInner(): React.ReactNode {
  const { columns } = useTerminalSize();
  const [, setTick] = useState(0);

  // 轮询触发重渲染：cost-tracker 的 addToTotalCostState 是在 React 之外
  // 直接 mutate STATE，没有现成的事件可以订阅。1 秒一次足够流畅，
  // 而且每秒只是读两个 number，开销可以忽略。
  useEffect(() => {
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  // 仅 DeepSeek 后端时显示，避免给真 Claude 用户看错误的人民币价
  if (!isDeepSeekActive()) return null;

  // 终端太窄时不显示，避免 wrap 把布局撑乱
  if (columns < 70) return null;

  const usage = getModelUsage();
  const flash: Bucket = {
    kind: 'flash',
    fullName: 'deepseek-v4-flash',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    pricing: FLASH_PRICING,
  };
  const pro: Bucket = {
    kind: 'pro',
    fullName: 'deepseek-v4-pro',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    pricing: getProPricing(),
  };

  for (const [modelName, u] of Object.entries(usage)) {
    const kind = classifyModel(modelName);
    if (!kind) continue;
    const b = kind === 'flash' ? flash : pro;
    b.inputTokens += u.inputTokens;
    b.outputTokens += u.outputTokens;
    b.cacheReadInputTokens += u.cacheReadInputTokens;
    b.cacheCreationInputTokens += u.cacheCreationInputTokens;
  }

  const flashCNY = computeCNY(flash);
  const proCNY = computeCNY(pro);
  const total = flashCNY + proCNY;

  const rows: Array<{
    b: Bucket;
    cny: number;
    color: 'success' | 'claude';
  }> = [
    { b: flash, cny: flashCNY, color: 'success' },
    { b: pro, cny: proCNY, color: 'claude' },
  ];

  return (
    <Box flexDirection="column" paddingX={2}>
      {rows.map(({ b, cny, color }) => (
        <Box key={b.kind} gap={1}>
          <Text color={color} bold>
            {b.fullName}
          </Text>
          <Text dimColor>in</Text>
          <Text>{formatTokens(b.inputTokens)}</Text>
          <Text dimColor>· out</Text>
          <Text>{formatTokens(b.outputTokens)}</Text>
          <Text dimColor>· cache↓</Text>
          <Text>{formatTokens(b.cacheReadInputTokens)}</Text>
          <Text dimColor>· cache↑</Text>
          <Text>{formatTokens(b.cacheCreationInputTokens)}</Text>
          <Text color={color}>{formatCNY(cny)}</Text>
          <Text dimColor>
            ({b.pricing.cacheMissInput}/{b.pricing.output} ¥/Mtok)
          </Text>
        </Box>
      ))}
      <Box gap={1}>
        <Text bold color="warning">
          累计 {formatCNY(total)}
        </Text>
        <Text dimColor>
          (≈ ${(total / CNY_PER_USD).toFixed(total < 1 ? 4 : 2)})
        </Text>
        <Text dimColor>
          ·{' '}
          {process.env.DEEPSEEK_PRO_FULL_PRICE === '1'
            ? `pro 原价 ${PRO_PRICING_FULL.cacheMissInput}/${PRO_PRICING_FULL.output} ¥/Mtok`
            : `pro 当前 2.5 折，原价 ${PRO_PRICING_FULL.cacheMissInput}/${PRO_PRICING_FULL.output} ¥/Mtok`}
        </Text>
      </Box>
    </Box>
  );
}

export const ModelStatsPanel = memo(ModelStatsPanelInner);
