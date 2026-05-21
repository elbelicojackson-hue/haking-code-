import React from 'react';
import { Box, Text } from '@anthropic/ink';

export function WelcomeV2(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
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
      <Box marginTop={1}>
        <Text>
          <Text bold>Haking Code</Text>
          <Text dimColor> v{MACRO.VERSION} · powered by DeepSeek</Text>
        </Text>
      </Box>
    </Box>
  );
}
