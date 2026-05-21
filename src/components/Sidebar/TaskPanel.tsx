import React, { memo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useTasksV2 } from '../../hooks/useTasksV2.js';

const STATUS_ICON: Record<string, string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
};

export const TaskPanel = memo(function TaskPanel(): React.ReactNode {
  const tasks = useTasksV2();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>▾ Tasks</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {!tasks || tasks.length === 0 ? (
          <Text dimColor>  No active tasks</Text>
        ) : (
          tasks.slice(0, 8).map(task => (
            <Text key={task.id} wrap="truncate-end">
              <Text color={task.status === 'completed' ? 'green' : task.status === 'in_progress' ? 'yellow' : undefined}>
                {STATUS_ICON[task.status] ?? '☐'}
              </Text>
              {' '}
              <Text dimColor={task.status === 'completed'}>{task.subject}</Text>
            </Text>
          ))
        )}
        {tasks && tasks.length > 8 && (
          <Text dimColor>  +{tasks.length - 8} more</Text>
        )}
      </Box>
    </Box>
  );
});
