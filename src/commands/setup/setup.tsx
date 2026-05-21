import React, { useState } from 'react';
import { Box, Text, useInput } from '@anthropic/ink';
import { loadHakingConfig, saveHakingConfig, type HakingConfig, type ProviderEntry } from '../../utils/hakingConfig.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

type Screen = 'main' | 'edit-field' | 'providers' | 'add-provider' | 'done';

function SetupPanel({ onDone }: { onDone: (msg: string, opts?: any) => void }): React.ReactNode {
  const [config, setConfig] = useState<HakingConfig>(() => {
    const c = loadHakingConfig();
    return {
      apiKey: c.apiKey ?? '',
      baseUrl: c.baseUrl ?? 'https://api.deepseek.com/anthropic',
      model: c.model ?? 'deepseek-v4-pro',
      fastModel: c.fastModel ?? 'deepseek-v4-flash',
      providers: c.providers ?? [],
    };
  });
  const [screen, setScreen] = useState<Screen>('main');
  const [cursor, setCursor] = useState(0);
  const [editBuf, setEditBuf] = useState('');
  const [editTarget, setEditTarget] = useState('');
  // Add provider state
  const [newProvider, setNewProvider] = useState<Partial<ProviderEntry>>({});
  const [addStep, setAddStep] = useState(0);

  const mainItems = [
    { key: 'apiKey', label: 'API Key', value: config.apiKey ? config.apiKey.slice(0, 8) + '...' + config.apiKey.slice(-4) : '(未设置)' },
    { key: 'baseUrl', label: 'Base URL', value: config.baseUrl || '(未设置)' },
    { key: 'model', label: '主模型', value: config.model || '(未设置)' },
    { key: 'fastModel', label: '快速模型', value: config.fastModel || '(未设置)' },
    { key: '_providers', label: `Recon Providers [${config.providers?.length ?? 0}]`, value: '管理多 LLM →' },
    { key: '_save', label: '💾 保存配置', value: '' },
  ];

  useInput((input, key) => {
    // Edit field screen
    if (screen === 'edit-field') {
      if (key.return) {
        setConfig(c => ({ ...c, [editTarget]: editBuf }));
        setScreen('main');
        return;
      }
      if (key.escape) { setScreen('main'); return; }
      if (key.backspace || key.delete) { setEditBuf(b => b.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setEditBuf(b => b + input);
      return;
    }

    // Add provider screen
    if (screen === 'add-provider') {
      if (key.escape) { setScreen('providers'); setAddStep(0); setNewProvider({}); return; }
      if (key.return) {
        const fields = ['id', 'apiKey', 'baseUrl', 'model'] as const;
        const field = fields[addStep]!;
        const updated = { ...newProvider, [field]: editBuf };
        setNewProvider(updated);
        if (addStep < 3) {
          setAddStep(addStep + 1);
          setEditBuf(field === 'baseUrl' ? 'https://api.deepseek.com/anthropic' : field === 'model' ? 'deepseek-v4-pro' : '');
        } else {
          // Save provider
          const entry: ProviderEntry = {
            id: updated.id || `agent-${(config.providers?.length ?? 0) + 1}`,
            apiKey: updated.apiKey || '',
            baseUrl: updated.baseUrl || 'https://api.deepseek.com/anthropic',
            model: updated.model || 'deepseek-v4-pro',
          };
          setConfig(c => ({ ...c, providers: [...(c.providers ?? []), entry] }));
          setScreen('providers');
          setAddStep(0);
          setNewProvider({});
        }
        return;
      }
      if (key.backspace || key.delete) { setEditBuf(b => b.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setEditBuf(b => b + input);
      return;
    }

    // Providers list screen
    if (screen === 'providers') {
      const provLen = (config.providers?.length ?? 0);
      if (key.escape) { setScreen('main'); setCursor(4); return; }
      if (key.upArrow) setCursor(c => Math.max(0, c - 1));
      if (key.downArrow) setCursor(c => Math.min(provLen + 1, c + 1));
      if (key.return) {
        if (cursor === provLen) {
          // Add new
          setScreen('add-provider');
          setEditBuf('');
          setAddStep(0);
          setNewProvider({});
        } else if (cursor === provLen + 1) {
          // Back
          setScreen('main');
          setCursor(4);
        } else {
          // Delete provider
          setConfig(c => ({ ...c, providers: c.providers?.filter((_, i) => i !== cursor) }));
          setCursor(c => Math.max(0, c - 1));
        }
      }
      return;
    }

    // Main screen
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(mainItems.length - 1, c + 1));
    if (key.escape) { onDone('取消', { display: 'system' }); return; }
    if (key.return) {
      const item = mainItems[cursor]!;
      if (item.key === '_save') {
        saveHakingConfig(config);
        if (config.apiKey) process.env.ANTHROPIC_API_KEY = config.apiKey;
        if (config.baseUrl) process.env.ANTHROPIC_BASE_URL = config.baseUrl;
        if (config.model) process.env.ANTHROPIC_MODEL = config.model;
        if (config.fastModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.fastModel;
        setScreen('done');
        setTimeout(() => onDone('✓ 配置已保存到 ~/.haking/config.json', { display: 'system' }), 800);
        return;
      }
      if (item.key === '_providers') {
        setScreen('providers');
        setCursor(0);
        return;
      }
      // Edit a field
      setEditTarget(item.key);
      setEditBuf((config as any)[item.key] ?? '');
      setScreen('edit-field');
    }
  });

  if (screen === 'done') {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color="green" bold>✓ 配置已保存！下次启动自动生效。</Text>
      </Box>
    );
  }

  if (screen === 'add-provider') {
    const labels = ['Agent ID (如 gpt-agent)', 'API Key', 'Base URL', 'Model'];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">➕ 添加 Recon Provider ({addStep + 1}/4)</Text>
        <Box marginTop={1}>
          <Text>{labels[addStep]}: </Text>
          <Text color="yellow">{editBuf}█</Text>
        </Box>
        <Text dimColor>Enter 确认 · Esc 取消</Text>
      </Box>
    );
  }

  if (screen === 'edit-field') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>编辑 {editTarget}:</Text>
        <Text color="yellow">{editBuf}█</Text>
        <Text dimColor>Enter 确认 · Esc 取消</Text>
      </Box>
    );
  }

  if (screen === 'providers') {
    const provs = config.providers ?? [];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">🔗 Recon Providers（多 LLM 对抗分析）</Text>
        <Text dimColor>  PEV 引擎用多个不同 LLM 同时分析目标，提高准确率</Text>
        <Box flexDirection="column" marginTop={1}>
          {provs.map((p, i) => (
            <Text key={i} color={cursor === i ? 'cyan' : undefined}>
              {cursor === i ? '▸ ' : '  '}
              {p.id} → {p.model} ({p.baseUrl.replace('https://', '').slice(0, 20)})
              {cursor === i ? ' [Enter 删除]' : ''}
            </Text>
          ))}
          <Text color={cursor === provs.length ? 'green' : 'dimColor'}>
            {cursor === provs.length ? '▸ ' : '  '}[+ 添加 Provider]
          </Text>
          <Text color={cursor === provs.length + 1 ? 'cyan' : 'dimColor'}>
            {cursor === provs.length + 1 ? '▸ ' : '  '}← 返回
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑↓ 选择 · Enter 操作 · Esc 返回</Text>
        </Box>
        {provs.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>💡 未配置时，/recon 会用主 API Key 生成 2 个虚拟 agent</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Main screen
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">⚙ Haking Code 配置</Text>
      <Text dimColor>  ~/.haking/config.json · 下次启动自动加载</Text>
      <Box flexDirection="column" marginTop={1}>
        {mainItems.map((item, i) => (
          <Box key={item.key}>
            <Text color={cursor === i ? 'cyan' : undefined}>
              {cursor === i ? '▸ ' : '  '}{item.label}:{' '}
            </Text>
            <Text dimColor={!item.value || item.value.includes('未设置')}>
              {item.value}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择 · Enter 编辑 · Esc 退出</Text>
      </Box>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone) => {
  return <SetupPanel onDone={onDone} />;
};
