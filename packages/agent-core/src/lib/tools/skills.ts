import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Skill, SkillMetadata, Tool } from './type';

/**
 * Built-in packs: packages/agent-core/skills/<name>/SKILL.md.
 * Host may set a user root ($AGENT_HOME/skills). One catalog API;
 * user name wins on collision.
 */

export type SkillCatalogEntry = SkillMetadata & {
  folder: string;
  source: 'global' | 'user';
};

let userRoot: string | null = null;
let cached: Skill[] | null = null;

export function resolveSkillsRoot(): string {
  const starts = [process.cwd()];
  try {
    starts.push(__dirname);
  } catch {
    /* CJS bundle without __dirname */
  }

  const candidates: string[] = [];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, 'skills'));
      candidates.push(path.join(dir, 'packages', 'agent-core', 'skills'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return path.resolve(process.cwd(), 'packages', 'agent-core', 'skills');
}

export function configureSkillRoots(nextUserRoot: string | null): void {
  const resolved = nextUserRoot ? path.resolve(nextUserRoot) : null;
  if (resolved === userRoot) return;
  userRoot = resolved;
  cached = null;
}

export function invalidateSkillCatalog(): void {
  cached = null;
}

export const MAX_RUN_SKILLS = 3;

const TOKEN = /[a-z0-9][a-z0-9+._-]*/g;
const MODE_NAMES = new Set(['home', 'workspace', 'thinking']);

export type ParsedSkill = {
  name: string;
  description: string;
  instructions: string;
  when: string[];
  not: string[];
  modes: string[];
};

function csv(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

function metaFields(skill: {
  when?: string[];
  not?: string[];
  modes?: string[];
}): Pick<SkillMetadata, 'when' | 'not' | 'modes'> {
  return {
    ...(skill.when?.length ? { when: skill.when } : {}),
    ...(skill.not?.length ? { not: skill.not } : {}),
    ...(skill.modes?.length ? { modes: skill.modes } : {}),
  };
}

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ParsedSkill {
  const trimmed = raw.replace(/^\uFEFF/, '');
  const end = trimmed.startsWith('---') ? trimmed.indexOf('\n---', 3) : -1;
  if (end < 0) {
    return {
      name: fallbackName,
      description: fallbackName,
      instructions: trimmed.trim(),
      when: [],
      not: [],
      modes: [],
    };
  }
  const fm = trimmed.slice(3, end).trim().replace(/\r/g, '');
  const body = trimmed.slice(end + 4).trim();
  let name = fallbackName;
  let description = fallbackName;
  let when: string[] = [];
  let not: string[] = [];
  let modes: string[] = [];
  for (const line of fm.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && value) name = value;
    if (key === 'description' && value) description = value;
    if (key === 'when') when = csv(value);
    if (key === 'not') not = csv(value);
    if (key === 'modes') {
      modes = csv(value).filter((mode) => MODE_NAMES.has(mode));
    }
  }
  return { name, description, instructions: body, when, not, modes };
}

function readRoot(root: string): { folder: string; skill: Skill }[] {
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { folder: string; skill: Skill }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = parseSkillMarkdown(
        readFileSync(path.join(root, entry.name, 'SKILL.md'), 'utf8'),
        entry.name,
      );
      out.push({
        folder: entry.name,
        skill: {
          name: parsed.name,
          description: parsed.description,
          instructions: parsed.instructions,
          ...metaFields(parsed),
        },
      });
    } catch {
      continue;
    }
  }
  return out;
}

function catalog(): Skill[] {
  if (!cached) {
    const byName = new Map<string, Skill>();
    for (const { skill } of readRoot(resolveSkillsRoot())) {
      byName.set(skill.name, skill);
    }
    if (userRoot) {
      for (const { skill } of readRoot(userRoot)) {
        byName.set(skill.name, skill);
      }
    }
    cached = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return cached;
}

export function listSkills(): SkillMetadata[] {
  return catalog().map(({ name, description, when, not, modes }) => ({
    name,
    description,
    ...metaFields({ when, not, modes }),
  }));
}

/**
 * Compact catalog for the skills_catalog context layer.
 * `suggested` are host lexical hints (selectSkills); marked with `*`.
 */
export function formatSkillsCatalog(
  skills: SkillMetadata[],
  suggested: string[] = [],
): string {
  const suggestedSet = new Set(
    suggested.map((name) => name.toLowerCase()),
  );
  const lines =
    skills.length === 0
      ? '- (none)'
      : skills
          .map((skill) => {
            const mark = suggestedSet.has(skill.name.toLowerCase())
              ? '*'
              : '';
            const tags: string[] = [];
            if (skill.when?.length) {
              tags.push(`when: ${skill.when.join(', ')}`);
            }
            if (skill.modes?.length) {
              tags.push(`modes: ${skill.modes.join(', ')}`);
            }
            const suffix = tags.length > 0 ? ` (${tags.join('; ')})` : '';
            return `- ${mark}${skill.name}: ${skill.description}${suffix}`;
          })
          .join('\n');
  return [
    '# Skills',
    'Catalog of procedure packs. Host suggestions for this turn are marked *.',
    'Call load_skill with skill_name when that workflow matches the user intent.',
    'Prefer suggested when they fit; if unsure which skill applies, ask briefly or load the closest match.',
    'Built-in tools work without a skill. Loading does not approve steps or add tools.',
    '',
    lines,
  ].join('\n');
}

/**
 * Deterministic soft suggestions for UI chips + catalog `*` marks. No LLM.
 * Does not gate load_skill — the model may load any catalog skill.
 */
export function selectSkills(input: {
  query: string;
  mode?: string;
  pinned?: string[];
  dismissed?: string[];
  catalog?: SkillMetadata[];
  limit?: number;
}): { selected: SkillMetadata[]; scores: { name: string; score: number }[] } {
  const catalog = input.catalog ?? listSkills();
  const limit = input.limit ?? MAX_RUN_SKILLS;
  const dismissed = new Set(
    (input.dismissed ?? []).map((name) => name.toLowerCase()),
  );
  const pinnedNames = (input.pinned ?? []).map((name) => name.toLowerCase());
  const query = input.query.toLowerCase();
  const queryTokens = new Set(tokens(query));

  const byName = new Map(
    catalog.map((skill) => [skill.name.toLowerCase(), skill]),
  );
  const selected: SkillMetadata[] = [];
  const seen = new Set<string>();

  for (const name of pinnedNames) {
    if (selected.length >= limit) break;
    const skill = byName.get(name);
    if (!skill || dismissed.has(name) || seen.has(name)) continue;
    selected.push(skill);
    seen.add(name);
  }

  const scored: { skill: SkillMetadata; score: number }[] = [];
  for (const skill of catalog) {
    const key = skill.name.toLowerCase();
    if (seen.has(key) || dismissed.has(key)) continue;
    if (
      skill.modes?.length &&
      input.mode &&
      !skill.modes.includes(input.mode)
    ) {
      continue;
    }
    if (skill.not?.some((word) => queryTokens.has(word))) continue;

    const nameParts = skill.name
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((part) => part.length >= 4);
    const nameHit =
      query.includes(key) ||
      (nameParts.length > 0 && nameParts.every((part) => queryTokens.has(part)));

    let score = nameHit ? 100 : 0;
    for (const word of skill.when ?? []) {
      if (queryTokens.has(word)) score += 10;
    }
    for (const word of tokens(skill.description)) {
      if (word.length >= 4 && queryTokens.has(word)) score += 1;
    }
    if (score < 10 && !nameHit) continue;
    scored.push({ skill, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
  );
  for (const row of scored) {
    if (selected.length >= limit) break;
    selected.push(row.skill);
  }

  return {
    selected,
    scores: [
      ...selected
        .filter((skill) =>
          pinnedNames.includes(skill.name.toLowerCase()),
        )
        .map((skill) => ({ name: skill.name, score: Number.POSITIVE_INFINITY })),
      ...scored.map((row) => ({ name: row.skill.name, score: row.score })),
    ],
  };
}

export function listSkillCatalogs(): {
  global: SkillCatalogEntry[];
  user: SkillCatalogEntry[];
} {
  const toEntries = (
    root: string,
    source: SkillCatalogEntry['source'],
  ): SkillCatalogEntry[] =>
    readRoot(root)
      .map(({ folder, skill }) => ({
        name: skill.name,
        description: skill.description,
        folder,
        source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  return {
    global: toEntries(resolveSkillsRoot(), 'global'),
    user: userRoot ? toEntries(userRoot, 'user') : [],
  };
}

export const load_skill: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the procedure body for a skill from the catalog. Optional. Built-in tools work without a skill.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'Exact skill name from the skills catalog',
          },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'A catalog skill (especially a * suggested one) matches the user intent and you need its procedure body.',
    ],
    whenNotToUse: [
      'Do not load a skill on every turn.',
      'Do not load a skill instead of calling a built-in tool.',
      'Do not load a skill for small talk or a one-line factual answer.',
      'Do not load a skill whose modes clearly exclude this run mode.',
    ],
    usage: [
      'Pass skill_name exactly as listed in the skills catalog.',
      'If several skills could apply and intent is unclear, ask briefly before loading.',
      'Follow the loaded steps; they do not grant extra tools or bypass the path jail.',
    ],
  },
  execute: async (args) => {
    const name = String(args.skill_name ?? '').trim();
    const skill = catalog().find((item) => item.name === name);
    if (skill) return skill.instructions;
    const available = listSkills()
      .map((item) => item.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
