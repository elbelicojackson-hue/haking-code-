import React, { memo } from 'react';
import { Box } from '@anthropic/ink';
import { TaskPanel } from './TaskPanel.js';
import { MemoryPanel } from './MemoryPanel.js';
import { BuddyPanel } from './BuddyPanel.js';

type Props = {
  width: number;
  visible: boolean;
};

const MemoTaskPanel = memo(TaskPanel);
const MemoMemoryPanel = memo(MemoryPanel);
const MemoBuddyPanel = memo(BuddyPanel);

export const Sidebar = memo(function Sidebar({ width, visible }: Props): React.ReactNode {
  if (!visible) return null;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderRight
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <MemoTaskPanel />
      <MemoMemoryPanel />
      <MemoBuddyPanel />
    </Box>
  );
});
