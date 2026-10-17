import { describe, expect, it } from 'vitest';
import { seedThreadTitle } from './generate-thread-title';

describe('seedThreadTitle', () => {
  it('clamps the first message for an instant sidebar title', () => {
    expect(
      seedThreadTitle(
        'How does Nx affected work with project references in a monorepo?',
      ),
    ).toBe('How does Nx affected work with project');
  });

  it('falls back when empty', () => {
    expect(seedThreadTitle('   ')).toBe('New Chat');
  });
});
