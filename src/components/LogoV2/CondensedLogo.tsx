import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getDisplayPath } from '../../utils/file.js';

export function CondensedLogo(): React.ReactNode {
  const cwd = getDisplayPath(process.cwd());

  return (
    <Box paddingX={2} paddingY={0}>
      <Text>
        <Text bold color="cyan">Haking</Text>
        <Text dimColor> v{MACRO.VERSION} · {cwd}</Text>
      </Text>
    </Box>
  );
}
