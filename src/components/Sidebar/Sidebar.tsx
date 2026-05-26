import React, { memo } from 'react';
import { Box, useTerminalSize } from '@anthropic/ink';
import { TaskPanel } from './TaskPanel.js';
import { MemoryPanel } from './MemoryPanel.js';
import { BuddyPanel } from './BuddyPanel.js';

type Props = {
  width: number;
  visible: boolean;
};

/**
 * Rough vertical budget for the sidebar:
 *
 *   - BUDDY_RESERVED_ROWS (5)   header + emoji line + species line + sprite
 *   - 2 panel headers           Tasks + Memory bold titles
 *   - 2 "+N more" overflow rows possible truncation indicators
 *
 * Whatever's left is split 60% Tasks / 40% Memory, then clamped so a tall
 * terminal doesn't render a 50-line list nobody can read at once.
 */
const BUDDY_RESERVED_ROWS = 5;
const PANEL_CHROME_ROWS = 4;
const TASK_HARD_CAP = 20;
const TASK_HARD_FLOOR = 2;
const MEMORY_HARD_CAP = 10;
const MEMORY_HARD_FLOOR = 2;

function computePanelBudgets(rows: number): { taskMax: number; memoryMax: number } {
  const available = Math.max(4, rows - BUDDY_RESERVED_ROWS - PANEL_CHROME_ROWS);
  const taskMax = Math.max(
    TASK_HARD_FLOOR,
    Math.min(TASK_HARD_CAP, Math.floor(available * 0.6)),
  );
  const memoryMax = Math.max(
    MEMORY_HARD_FLOOR,
    Math.min(MEMORY_HARD_CAP, available - taskMax),
  );
  return { taskMax, memoryMax };
}

export const Sidebar = memo(function Sidebar({ width, visible }: Props): React.ReactNode {
  const { rows } = useTerminalSize();
  const { taskMax, memoryMax } = computePanelBudgets(rows);

  if (!visible) return null;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      // ink: every border side defaults to true. To draw only the right
      // edge (vertical separator between sidebar and chat), explicitly
      // disable the other three. There's no shorthand for "right only".
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <TaskPanel max={taskMax} />
      <MemoryPanel max={memoryMax} />
      <BuddyPanel />
    </Box>
  );
});
