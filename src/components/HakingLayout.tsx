import React, { memo, useState, useCallback } from 'react';
import { Box, useKeybindings, useTerminalSize } from '@anthropic/ink';
import { Sidebar } from './Sidebar/Sidebar.js';

type Props = {
  children: React.ReactNode;
};

const SIDEBAR_WIDTH = 24;

const MemoizedSidebar = memo(Sidebar);

export function HakingLayout({ children }: Props): React.ReactNode {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const { columns } = useTerminalSize();

  const toggleSidebar = useCallback(() => {
    setSidebarVisible(v => !v);
  }, []);

  useKeybindings(
    { 'app:toggleSidebar': toggleSidebar },
    { context: 'Global', isActive: true },
  );

  const showSidebar = sidebarVisible && columns > 80;

  return (
    <Box flexDirection="row" width="100%" height="100%">
      {showSidebar && <MemoizedSidebar width={SIDEBAR_WIDTH} visible />}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
