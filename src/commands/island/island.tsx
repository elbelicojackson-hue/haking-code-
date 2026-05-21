import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { LocalJSXCommandCall } from '../../types/command.js';

const EXE_PATH = resolve(import.meta.dirname || '.', '../../../island/src-tauri/target/debug/haking-island.exe');

export const call: LocalJSXCommandCall = async (onDone) => {
  if (!existsSync(EXE_PATH)) {
    setTimeout(() => onDone(`✗ 灵动岛未编译，请先 cd island && cargo tauri build`), 100);
    return (
      <Box paddingX={2}><Text color="error">✗ haking-island.exe 不存在: {EXE_PATH}</Text></Box>
    );
  }

  spawn(EXE_PATH, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => onDone('✓ 灵动岛已启动'), 500);
  return (
    <Box paddingX={2}><Text color="success">✓ 灵动岛已启动</Text></Box>
  );
};
