import React, { createContext, useContext, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { Box, useKeybindings, useTerminalSize, instances } from '@anthropic/ink';
import { Sidebar } from './Sidebar/Sidebar.js';
import { getSidebarVisible, setSidebarVisible } from '../utils/hakingConfig.js';

type Props = {
  children: React.ReactNode;
};

const SIDEBAR_WIDTH = 24;
/**
 * Below this width the sidebar auto-hides regardless of user preference,
 * because subtracting SIDEBAR_WIDTH from the terminal width would leave too
 * little room for the chat content (also clashes with the billing panel's
 * own < 70-column auto-hide threshold). Bumped from 80 → 100 in the
 * P2 sidebar audit to keep the chat column ≥ 76 cols.
 */
const SIDEBAR_MIN_TERMINAL_COLS = 100;

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

export function HakingLayout({ children }: Props): React.ReactNode {
  // Initialize from persisted preference. Lazy initializer keeps the
  // synchronous fs read off the render hot path (runs once on mount).
  const [sidebarVisible, setSidebarVisibleState] = useState<boolean>(getSidebarVisible);
  const { columns } = useTerminalSize();

  const toggleSidebar = useCallback(() => {
    setSidebarVisibleState(v => {
      const next = !v;
      // Fire-and-forget write. Save is synchronous fs IO but human-paced
      // (one toggle per intentional keypress) and saveHakingConfig already
      // mkdirSyncs the parent dir, so it can't throw on missing path.
      try {
        setSidebarVisible(next);
      } catch {
        // Persistence failure is non-fatal — the toggle still works for
        // the rest of this session.
      }
      return next;
    });
  }, []);

  useKeybindings(
    { 'app:toggleSidebar': toggleSidebar },
    { context: 'Global', isActive: true },
  );

  const showSidebar = sidebarVisible && columns >= SIDEBAR_MIN_TERMINAL_COLS;
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
        {showSidebar && <Sidebar width={SIDEBAR_WIDTH} visible />}
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    </ContentColumnsContext>
  );
}
