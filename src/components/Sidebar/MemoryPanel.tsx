import React, { memo, useEffect, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getMemoryFiles, type MemoryFileInfo } from '../../utils/claudemd.js';
import { basename } from 'path';

export const MemoryPanel = memo(function MemoryPanel(): React.ReactNode {
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    getMemoryFiles().then(setFiles).catch(() => {});
  }, []);

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>▾ Memory</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {files.length === 0 ? (
          <Text dimColor>  No memory files</Text>
        ) : (
          files.slice(0, 6).map((f, i) => (
            <Text key={i} wrap="truncate-end" dimColor>
              • {basename(f.path)}
            </Text>
          ))
        )}
        {files.length > 6 && (
          <Text dimColor>  +{files.length - 6} more</Text>
        )}
      </Box>
    </Box>
  );
});
