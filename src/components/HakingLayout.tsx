import React, { createContext, memo, useContext, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { Box, useKeybindings, useTerminalSize, instances } from '@anthropic/ink';
import { Sidebar } from './Sidebar/Sidebar.js';

type Props = {
  children: React.ReactNode;
};

const SIDEBAR_WIDTH = 24;

/** Sentinel value indicating no HakingLayout provider is present. */
const NO_PROVIDER = -1;

/** Context providing the content area's available column width (terminal columns minus sidebar). */
export const ContentColumnsContext = createContext<number>(NO_PROVIDER);

/** Hook to get the actual content area width (accounts for sidebar). */
export function useContentColumns(): number {
  const ctx = useContext(ContentColumnsContext);
  const { columns } = useTerminalSize();
  // If no HakingLayout wraps us, fall back to terminal width
  return ctx === NO_PROVIDER ? columns : ctx;
}

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
  const contentColumns = showSidebar ? columns - SIDEBAR_WIDTH : columns;
  const prevShowSidebar = useRef(showSidebar);

  useLayoutEffect(() => {
    if (prevShowSidebar.current !== showSidebar) {
      prevShowSidebar.current = showSidebar;
      instances.get(process.stdout)?.invalidatePrevFrame();
    }
  });

  return (
    <ContentColumnsContext value={contentColumns}>
      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && <MemoizedSidebar width={SIDEBAR_WIDTH} visible />}
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    </ContentColumnsContext>
  );
}
