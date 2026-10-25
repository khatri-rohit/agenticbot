import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@agent/agent-models';

import {
  formatSkillBodies,
  formatSkillsCatalog,
  load_skill,
  parseSkillMarkdown,
  selectSkills,
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
    when: ['patch', 'edit', 'implement'],
    not: ['trivia'],
    modes: ['workspace'],
  },
  {
    name: 'home-research',
    description: 'Multi-source web answer discipline.',
    when: ['search', 'news', 'current'],
    modes: ['home'],
  },
  {
    name: 'caveman-review',
    description: 'Compressed code review comments.',
    when: ['review', 'diff'],
    modes: ['workspace'],
  },
  {
    name: 'ai-writing-guidelines',
    description: 'Draft or rewrite prose.',
    when: ['write', 'draft', 'rewrite'],
  },
];

describe('parseSkillMarkdown', () => {
  it('reads when, not, and modes from frontmatter', () => {
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
    expect(parsed.when).toEqual(['patch', 'edit', 'implement']);
    expect(parsed.not).toEqual(['trivia', 'explain']);
    expect(parsed.modes).toEqual(['workspace']);
    expect(parsed.instructions).toBe('Body here.');
  });
});

describe('selectSkills', () => {
  it('selects on when-keywords and caps at 3', () => {
    const { selected } = selectSkills({
      query: 'please implement the login patch then review the diff',
      mode: 'workspace',
      catalog,
    });
    expect(selected.map((skill) => skill.name).sort()).toEqual([
      'caveman-review',
      'patch-and-verify',
    ]);
  });

  it('drops skills whose not-words appear in the query', () => {
    const { selected } = selectSkills({
      query: 'implement this trivia one-liner',
      mode: 'workspace',
      catalog,
    });
    expect(selected.map((skill) => skill.name)).not.toContain(
      'patch-and-verify',
    );
  });

  it('drops skills whose modes do not match', () => {
    const { selected } = selectSkills({
      query: 'search for the current version',
      mode: 'workspace',
      catalog,
    });
    expect(selected.map((skill) => skill.name)).not.toContain('home-research');
  });

  it('includes pinned skills first and skips dismissed', () => {
    const { selected } = selectSkills({
      query: 'hello',
      mode: 'home',
      catalog,
      pinned: ['patch-and-verify', 'home-research'],
      dismissed: ['home-research'],
    });
    expect(selected.map((skill) => skill.name)).toEqual(['patch-and-verify']);
  });

  it('returns nothing for small talk', () => {
    const { selected } = selectSkills({
      query: 'hi there',
      mode: 'home',
      catalog,
    });
    expect(selected).toEqual([]);
  });

  it('selects imported skills from name and description only', () => {
    const imported: SkillMetadata = {
      name: 'frontend-design',
      description:
        'Guides React UI implementation and layout in a Next.js app.',
    };
    const { selected } = selectSkills({
      query: 'implement the settings page UI',
      mode: 'workspace',
      catalog: [...catalog, imported],
    });
    expect(selected.map((skill) => skill.name)).toContain('frontend-design');
  });
});

describe('formatSkillsCatalog', () => {
  it('lists the full catalog and marks suggested names', () => {
    const text = formatSkillsCatalog(catalog, ['patch-and-verify']);
    expect(text).toContain('*patch-and-verify:');
    expect(text).toContain('- home-research:');
    expect(text).toContain('when: patch, edit, implement');
    expect(text).toContain('modes: workspace');
    expect(text).toMatch(/Catalog of procedure packs/i);
  });
});

describe('formatSkillBodies', () => {
  it('inlines suggested bodies and skips already loaded names', () => {
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
