import React, { memo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useTasksV2 } from '../../hooks/useTasksV2.js';

const STATUS_ICON: Record<string, string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
};

type Props = {
  /** Maximum task rows to render. Caller (Sidebar) computes this from
   *  available terminal height. Falls back to a reasonable default if
   *  the panel is mounted standalone. */
  max?: number;
};

const DEFAULT_MAX = 8;

export const TaskPanel = memo(function TaskPanel({ max = DEFAULT_MAX }: Props): React.ReactNode {
  const tasks = useTasksV2();
  const limit = Math.max(1, max);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>▾ Tasks</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {!tasks || tasks.length === 0 ? (
          <Text dimColor>  No active tasks</Text>
        ) : (
          tasks.slice(0, limit).map(task => (
            <Text key={task.id} wrap="truncate-end">
              <Text color={task.status === 'completed' ? 'ansi:green' : task.status === 'in_progress' ? 'ansi:yellow' : undefined}>
                {STATUS_ICON[task.status] ?? '☐'}
              </Text>
              {' '}
              <Text dimColor={task.status === 'completed'}>{task.subject}</Text>
            </Text>
          ))
        )}
        {tasks && tasks.length > limit && (
          <Text dimColor>  +{tasks.length - limit} more</Text>
        )}
      </Box>
    </Box>
  );
});
