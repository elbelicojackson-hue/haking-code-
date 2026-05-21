import React, { memo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { feature } from 'bun:bundle';

const SPECIES_EMOJI: Record<string, string> = {
  cat: '🐱', duck: '🦆', goose: '🪿', blob: '🫧', dragon: '🐉',
  octopus: '🐙', owl: '🦉', penguin: '🐧', turtle: '🐢', snail: '🐌',
  ghost: '👻', axolotl: '🦎', capybara: '🦫', cactus: '🌵', robot: '🤖',
};

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

  const { getCompanion } = require('../../buddy/companion.js') as typeof import('../../buddy/companion.js');
  const companion = getCompanion();

  if (!companion) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>▾ Buddy</Text>
        <Box paddingLeft={1}>
          <Text dimColor>  No buddy yet</Text>
        </Box>
      </Box>
    );
  }

  // Try to render the sprite inline
  let SpriteComponent: React.ComponentType | null = null;
  try {
    const mod = require('../../buddy/CompanionSprite.js') as typeof import('../../buddy/CompanionSprite.js');
    SpriteComponent = mod.CompanionSprite;
  } catch {}

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1}>
      <Text bold>▾ Buddy</Text>
      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          {SPECIES_EMOJI[companion.species] ?? '🐾'} {companion.name}
        </Text>
        <Text dimColor>  {companion.species} · {companion.rarity}</Text>
      </Box>
      {SpriteComponent && (
        <Box marginTop={1}>
          <SpriteComponent />
        </Box>
      )}
    </Box>
  );
});
