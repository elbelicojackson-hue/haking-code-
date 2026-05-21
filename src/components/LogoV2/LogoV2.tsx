import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { getDisplayPath } from '../../utils/file.js';

export function LogoV2(): React.ReactNode {
  const { columns } = useTerminalSize();
  const cwd = getDisplayPath(process.cwd());

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width={Math.min(columns, 70)}>
      <Text bold color="cyan">
        {'  _   _       _    _             '}
      </Text>
      <Text bold color="cyan">
        {' | | | | __ _| | _(_)_ __   __ _ '}
      </Text>
      <Text bold color="cyan">
        {" | |_| |/ _` | |/ / | '_ \\ / _` |"}
      </Text>
      <Text bold color="cyan">
        {' |  _  | (_| |   <| | | | | (_| |'}
      </Text>
      <Text bold color="cyan">
        {' |_| |_|\\__,_|_|\\_\\_|_| |_|\\__, |'}
      </Text>
      <Text bold color="cyan">
        {'                           |___/ '}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Haking Code</Text>
          <Text dimColor> v{MACRO.VERSION}</Text>
        </Text>
        <Text dimColor>cwd: {cwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Tips: Ctrl+B toggle sidebar · /help for commands · /model to switch</Text>
      </Box>
    </Box>
  );
}
