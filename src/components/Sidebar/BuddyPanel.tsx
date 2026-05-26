import React, { memo, useSyncExternalStore } from 'react';
import { Box, Text } from '@anthropic/ink';
import { feature } from 'bun:bundle';
import { createSignal } from '../../utils/signal.js';
import { logForDebugging } from '../../utils/debug.js';

const SPECIES_EMOJI: Record<string, string> = {
  cat: '🐱', duck: '🦆', goose: '🪿', blob: '🫧', dragon: '🐉',
  octopus: '🐙', owl: '🦉', penguin: '🐧', turtle: '🐢', snail: '🐌',
  ghost: '👻', axolotl: '🦎', capybara: '🦫', cactus: '🌵', robot: '🤖',
};

/* eslint-disable @typescript-eslint/no-require-imports */
// Hoist the dynamic feature-gated requires to module top level so we don't
// pay the lookup cost on every render. When feature('BUDDY') is false at
// build time, both branches collapse to null via DCE.
const companionModule = feature('BUDDY')
  ? (require('../../buddy/companion.js') as typeof import('../../buddy/companion.js'))
  : null;

let SpriteComponent: React.ComponentType | null = null;
if (feature('BUDDY')) {
  try {
    SpriteComponent = (require('../../buddy/CompanionSprite.js') as typeof import('../../buddy/CompanionSprite.js')).CompanionSprite;
  } catch (err) {
    logForDebugging(`BuddyPanel: failed to load CompanionSprite: ${err}`, {
      level: 'warn',
    });
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

type CompanionSnapshot =
  | { kind: 'none' }
  | { kind: 'present'; name: string; species: string; rarity: string };

/**
 * Singleton store for the sidebar buddy panel. Subscribes once to
 * companion.ts's notifyCompanionChanged signal so /buddy hatch / rehatch
 * propagate to the panel without prop drilling or polling. Snapshot is
 * a tagged primitive-bag so useSyncExternalStore's Object.is identity
 * check is stable across renders that didn't actually change anything.
 */
class CompanionStore {
  #snapshot: CompanionSnapshot = computeSnapshot();
  #changed = createSignal();
  #unsubscribeCompanion: (() => void) | null = null;
  #subscriberCount = 0;

  getSnapshot = (): CompanionSnapshot => this.#snapshot;

  subscribe = (fn: () => void): (() => void) => {
    const unsubscribe = this.#changed.subscribe(fn);
    this.#subscriberCount++;
    if (this.#subscriberCount === 1 && companionModule) {
      this.#unsubscribeCompanion =
        companionModule.subscribeCompanionChanged(this.#refresh);
      // Refresh once on first subscriber so a session that hatched a
      // companion before the panel mounted still shows it.
      this.#refresh();
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubscribe();
      this.#subscriberCount--;
      if (this.#subscriberCount === 0) {
        this.#unsubscribeCompanion?.();
        this.#unsubscribeCompanion = null;
      }
    };
  };

  #refresh = (): void => {
    const next = computeSnapshot();
    if (!snapshotEqual(this.#snapshot, next)) {
      this.#snapshot = next;
      this.#changed.emit();
    }
  };
}

function computeSnapshot(): CompanionSnapshot {
  if (!companionModule) return { kind: 'none' };
  const c = companionModule.getCompanion();
  if (!c) return { kind: 'none' };
  return {
    kind: 'present',
    name: c.name,
    species: c.species,
    rarity: c.rarity,
  };
}

function snapshotEqual(a: CompanionSnapshot, b: CompanionSnapshot): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'none' || b.kind === 'none') return true;
  return a.name === b.name && a.species === b.species && a.rarity === b.rarity;
}

const companionStore = new CompanionStore();

export const BuddyPanel = memo(function BuddyPanel(): React.ReactNode {
  if (!feature('BUDDY')) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>▾ Buddy</Text>
        <Box paddingLeft={1}>
          <Text dimColor>  disabled</Text>
        </Box>
      </Box>
    );
  }

  const snapshot = useSyncExternalStore(
    companionStore.subscribe,
    companionStore.getSnapshot,
    companionStore.getSnapshot,
  );

  if (snapshot.kind === 'none') {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>▾ Buddy</Text>
        <Box paddingLeft={1}>
          <Text dimColor>  No buddy yet</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1}>
      <Text bold>▾ Buddy</Text>
      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          {SPECIES_EMOJI[snapshot.species] ?? '🐾'} {snapshot.name}
        </Text>
        <Text dimColor>  {snapshot.species} · {snapshot.rarity}</Text>
      </Box>
      {SpriteComponent && (
        <Box marginTop={1}>
          <SpriteComponent />
        </Box>
      )}
    </Box>
  );
});
