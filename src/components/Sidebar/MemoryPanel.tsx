import React, { memo, useSyncExternalStore } from 'react';
import { Box, Text } from '@anthropic/ink';
import { basename } from 'path';
import {
  getMemoryFiles,
  subscribeMemoryFilesChanged,
  type MemoryFileInfo,
} from '../../utils/claudemd.js';
import { createSignal } from '../../utils/signal.js';
import { logForDebugging } from '../../utils/debug.js';

/**
 * Singleton store for the sidebar memory panel. Owns the cached file list
 * and one subscription to the cache-invalidation signal exposed by
 * claudemd.ts. Multiple MemoryPanel mounts (transcript view + main view)
 * share one store and one in-flight fetch instead of each setting up its
 * own. Implements the useSyncExternalStore contract.
 */
class MemoryFilesStore {
  /** Stable array reference; replaced only when fetch completes. */
  #files: MemoryFileInfo[] = [];
  /** Coalesces overlapping fetches: at most one inflight fetch at a time. */
  #fetching = false;
  /** True if a refetch was requested while one was already inflight. */
  #refetchPending = false;
  #changed = createSignal();
  #unsubscribeCache: (() => void) | null = null;
  #subscriberCount = 0;

  getSnapshot = (): MemoryFileInfo[] => this.#files;

  subscribe = (fn: () => void): (() => void) => {
    const unsubscribe = this.#changed.subscribe(fn);
    this.#subscriberCount++;
    if (this.#subscriberCount === 1) {
      // First subscriber: hook into claudemd's invalidation signal +
      // kick off the initial fetch. We rely on claudemd to fire on every
      // /memory edit, worktree switch, settings sync, post-compact reload.
      this.#unsubscribeCache = subscribeMemoryFilesChanged(this.#fetch);
      void this.#fetch();
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubscribe();
      this.#subscriberCount--;
      if (this.#subscriberCount === 0) {
        this.#unsubscribeCache?.();
        this.#unsubscribeCache = null;
      }
    };
  };

  #fetch = async (): Promise<void> => {
    if (this.#fetching) {
      // A fetch is already in flight. Mark a pending refetch so the new
      // signal isn't lost — we'll re-run once the current call settles.
      this.#refetchPending = true;
      return;
    }
    this.#fetching = true;
    try {
      const files = await getMemoryFiles();
      // Reference-stable update: only replace + notify when the list
      // actually changes, so unrelated subscriber re-renders don't pile up.
      if (!arrayShallowEqualByPath(this.#files, files)) {
        this.#files = files;
        this.#changed.emit();
      }
    } catch (err) {
      logForDebugging(`MemoryPanel.getMemoryFiles failed: ${err}`, {
        level: 'error',
      });
    } finally {
      this.#fetching = false;
      if (this.#refetchPending) {
        this.#refetchPending = false;
        void this.#fetch();
      }
    }
  };
}

function arrayShallowEqualByPath(
  a: MemoryFileInfo[],
  b: MemoryFileInfo[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.path !== b[i]?.path) return false;
  }
  return true;
}

const memoryFilesStore = new MemoryFilesStore();

export const MemoryPanel = memo(function MemoryPanel(): React.ReactNode {
  const files = useSyncExternalStore(
    memoryFilesStore.subscribe,
    memoryFilesStore.getSnapshot,
    memoryFilesStore.getSnapshot,
  );

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>▾ Memory</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {files.length === 0 ? (
          <Text dimColor>  No memory files</Text>
        ) : (
          files.slice(0, 6).map((f, i) => (
            <Text key={f.path ?? i} wrap="truncate-end" dimColor>
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
