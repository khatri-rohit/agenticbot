import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@agent/agent-models';

import {
  formatSkillBodies,
  formatSkillsCatalog,
  load_skill,
  parseSkillMarkdown,
  type ParsedSkill,
} from './skills';
import type { SkillMetadata } from './type';

function ctx(): ToolContext {
  return {
    runId: 'r1',
    threadId: 't1',
    origin: 'eval',
    signal: new AbortController().signal,
  };
}

const catalog: SkillMetadata[] = [
  {
    name: 'patch-and-verify',
    description: 'Edit then run the project check.',
  },
  {
    name: 'home-research',
    description: 'Multi-source web answer discipline.',
  },
];

describe('parseSkillMarkdown', () => {
  it('reads name and description and ignores extra frontmatter', () => {
    const parsed: ParsedSkill = parseSkillMarkdown(
      [
        '---',
        'name: patch-and-verify',
        'description: Edit then verify.',
        'when: patch, edit, implement',
        'not: trivia, explain',
        'modes: workspace',
        '---',
        '',
        'Body here.',
      ].join('\n'),
      'fallback',
    );
    expect(parsed.name).toBe('patch-and-verify');
    expect(parsed.description).toBe('Edit then verify.');
    expect(parsed.instructions).toBe('Body here.');
  });
});

describe('formatSkillsCatalog', () => {
  it('lists name and description only', () => {
    const text = formatSkillsCatalog(catalog);
    expect(text).toContain('- patch-and-verify:');
    expect(text).toContain('- home-research:');
    expect(text).not.toContain('when:');
    expect(text).not.toContain('modes:');
    expect(text).toMatch(/Catalog of procedure packs/i);
  });
});

describe('formatSkillBodies', () => {
  it('inlines requested bodies and skips already loaded names', () => {
    const text = formatSkillBodies(
      ['patch-and-verify', 'missing-skill'],
      ['patch-and-verify'],
    );
    expect(text).toBe('');
    const loaded = formatSkillBodies(['patch-and-verify']);
    expect(loaded).toMatch(/# Loaded skills/);
    expect(loaded).toContain('## patch-and-verify');
    expect(loaded).toMatch(/Use this when the user asked you to change code/i);
  });
});

describe('load_skill', () => {
  it('loads any catalog skill (no run-set jail)', async () => {
    const result = await load_skill.execute(
      { skill_name: 'patch-and-verify' },
      ctx(),
    );
    expect(result).not.toMatch(/not selected/i);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(20);
  });

  it('reports available names when missing', async () => {
    const result = await load_skill.execute(
      { skill_name: 'no-such-skill' },
      ctx(),
    );
    expect(result).toMatch(/Skill not found/i);
    expect(result).toMatch(/Available skills:/i);
  });
});
