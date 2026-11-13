import { describe, expect, it } from 'vitest';

import { earnedThoroughness, normalizeScopePaths, overlappingPath, usageDelta } from './delegation';

describe('delegation policy', () => {
  it('caps a first-pass thorough brief to medium and grants thorough on resume', () => {
    expect(earnedThoroughness('thorough', 'medium', false)).toEqual({ thoroughness: 'medium', capped: true });
    expect(earnedThoroughness('thorough', 'medium', true)).toEqual({ thoroughness: 'thorough', capped: false });
    expect(earnedThoroughness('quick', 'medium', false)).toEqual({ thoroughness: 'quick', capped: false });
    expect(earnedThoroughness(undefined, 'medium', false)).toEqual({ thoroughness: 'medium', capped: false });
    // A profile whose own default is thorough is capped on a first pass too.
    expect(earnedThoroughness(undefined, 'thorough', false)).toEqual({ thoroughness: 'medium', capped: true });
    expect(earnedThoroughness(undefined, undefined, false)).toEqual({ thoroughness: undefined, capped: false });
  });

  it('finds overlap between scopes: same path, or one inside the other', () => {
    const running = normalizeScopePaths(['./src/Components/DashBoard/', 'src\\redux']);
    expect(running).toEqual(['src/Components/DashBoard', 'src/redux']);
    expect(overlappingPath(['src/Components/DashBoard/DashBoard.tsx'], running)).toBe('src/Components/DashBoard/DashBoard.tsx');
    expect(overlappingPath(['src/Components'], running)).toBe('src/Components');
    expect(overlappingPath(['src/Components/DataViewer'], running)).toBeNull();
    // A prefix that is not a path boundary does not overlap.
    expect(overlappingPath(['src/reduxer'], running)).toBeNull();
    expect(overlappingPath([], running)).toBeNull();
  });

  it('charges only what was not charged yet', () => {
    const charged = { promptTokens: 100, completionTokens: 10, calls: 1, estimatedCalls: 0 };
    expect(usageDelta({ promptTokens: 250, completionTokens: 30, calls: 3, estimatedCalls: 0 }, charged)).toEqual({
      promptTokens: 150,
      completionTokens: 20,
      calls: 2,
      estimatedCalls: 0,
    });
    expect(usageDelta({ promptTokens: 50, completionTokens: 0, calls: 0, estimatedCalls: 0 }, charged).promptTokens).toBe(0);
  });
});
