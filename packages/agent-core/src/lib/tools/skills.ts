import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Skill, SkillMetadata, Tool } from './type';

/**
 * Built-in packs: packages/agent-core/skills/<name>/SKILL.md.
 * Host may set a user root ($AGENT_HOME/skills). One catalog API;
 * user name wins on collision.
 *
 * Generic contract is name + description + body. Extra YAML is ignored.
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

export type ParsedSkill = {
  name: string;
  description: string;
  instructions: string;
};

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
    };
  }
  const fm = trimmed.slice(3, end).trim().replace(/\r/g, '');
  const body = trimmed.slice(end + 4).trim();
  let name = fallbackName;
  let description = fallbackName;
  for (const line of fm.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && value) name = value;
    if (key === 'description' && value) description = value;
  }
  return { name, description, instructions: body };
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
  return catalog().map(({ name, description }) => ({ name, description }));
}

export function getSkill(name: string): Skill | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return catalog().find((item) => item.name.toLowerCase() === key);
}

/** User-requested bodies (`/` picks). Not host guesses. */
/** Bodies above this are "large": they load as core + contents, then by section. */
export const SKILL_LARGE_CHARS = 8_000;
/** One section per load_skill call; longer sections are cut with a pointer. */
export const SKILL_SECTION_MAX_CHARS = 12_000;
/** Fallback core when a skill has no `## Core rules` section. */
const SKILL_CORE_FALLBACK_CHARS = 1_200;
/** `/` picks are pinned in full up to this total; larger picks pin core + contents. */
export const PINNED_SKILLS_MAX_CHARS = 24_000;

const CORE_HEADING = /^##\s+core rules\s*$/im;

/** `## ` sections of a skill body, in order. Text before the first heading is the preamble. */
export function skillSections(instructions: string): { title: string; body: string }[] {
  const parts = instructions.split(/\n(?=##\s)/);
  const sections: { title: string; body: string }[] = [];
  for (const part of parts) {
    const match = part.match(/^##\s+(.+)\n?/);
    if (!match) continue;
    sections.push({ title: match[1]!.trim(), body: part.slice(match[0].length).trim() });
  }
  return sections;
}

/**
 * The must-follow rules that stay in context after a skill body is evicted:
 * the `## Core rules` section, else the first paragraph or list block.
 */
export function skillCore(instructions: string): string {
  const core = skillSections(instructions).find((section) => CORE_HEADING.test(`## ${section.title}`));
  if (core) return core.body.trim();
  const firstBlock = instructions.trim().split(/\n\s*\n/)[0] ?? '';
  return firstBlock.length > SKILL_CORE_FALLBACK_CHARS
    ? `${firstBlock.slice(0, SKILL_CORE_FALLBACK_CHARS)}…`
    : firstBlock;
}

/** Large skills without `## Core rules` (their evicted card falls back to the first block). */
export function skillLintWarnings(): string[] {
  return catalog()
    .filter(
      (skill) =>
        skill.instructions.length > SKILL_LARGE_CHARS &&
        !CORE_HEADING.test(skill.instructions),
    )
    .map(
      (skill) =>
        `${skill.name}: ${Math.round(skill.instructions.length / 4)} tokens and no "## Core rules" section`,
    );
}

function contentsLine(skill: Skill): string {
  const sections = skillSections(skill.instructions);
  if (sections.length === 0) return '';
  return `Sections (load_skill with section): ${sections
    .map((section) => `${section.title} (~${Math.round(section.body.length / 4)} tokens)`)
    .join('; ')}`;
}

/** What load_skill returns: the whole body when small, else core + contents, or one section. */
export function skillForLoad(skill: Skill, section?: string): string {
  if (section) {
    const wanted = section.trim().toLowerCase();
    const found = skillSections(skill.instructions).find(
      (item) => item.title.toLowerCase() === wanted,
    );
    if (!found) return `Section "${section}" not found in ${skill.name}. ${contentsLine(skill)}`;
    return found.body.length > SKILL_SECTION_MAX_CHARS
      ? `${found.body.slice(0, SKILL_SECTION_MAX_CHARS)}\n…(section cut at ${SKILL_SECTION_MAX_CHARS} chars)`
      : found.body;
  }
  if (skill.instructions.length <= SKILL_LARGE_CHARS) return skill.instructions;
  return [`# ${skill.name} — core rules`, skillCore(skill.instructions), '', contentsLine(skill)]
    .filter(Boolean)
    .join('\n');
}

/**
 * Replaces a loaded skill body once it has been applied: core rules plus a
 * reload note. The model keeps the rules; the long body stops riding along.
 */
export function skillCard(name: string, loadedAtIteration?: number): string {
  const skill = getSkill(name);
  const when = loadedAtIteration !== undefined ? ` at iteration ${loadedAtIteration}` : '';
  if (!skill) return `(skill card) ${name} was loaded${when}; call load_skill again for the full text.`;
  return `(skill card) ${skill.name} loaded${when}. Core rules:\n${skillCore(skill.instructions)}\nCall load_skill again for the full text or a section.`;
}

/**
 * Bodies for `/` picks (mandatory for this send). Pinned in full while the
 * total stays under `capChars`; larger picks pin core + contents instead.
 */
export function formatPinnedSkills(
  names: string[],
  alreadyLoaded: string[] = [],
  capChars = PINNED_SKILLS_MAX_CHARS,
): { text: string; trimmed: string[] } {
  const skip = new Set(alreadyLoaded.map((name) => name.toLowerCase()));
  const blocks: string[] = [];
  const trimmed: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key) || skip.has(key)) continue;
    seen.add(key);
    let body = skill.instructions;
    if (used + body.length > capChars) {
      // Over the cap: large skills pin core + contents, small ones their core.
      body =
        skill.instructions.length > SKILL_LARGE_CHARS
          ? skillForLoad(skill)
          : skillCore(skill.instructions);
      trimmed.push(skill.name);
    }
    used += body.length;
    blocks.push(`## ${skill.name}\n${body}`);
  }
  if (blocks.length === 0) return { text: '', trimmed };
  return {
    text: [
      '# Loaded skills',
      'The user attached these packs to this send. Follow them.',
      'Do not call load_skill again for these names (except to load a listed section).',
      '',
      blocks.join('\n\n'),
    ].join('\n'),
    trimmed,
  };
}

export function formatSkillBodies(
  names: string[],
  alreadyLoaded: string[] = [],
): string {
  return formatPinnedSkills(names, alreadyLoaded).text;
}

/** Catalog lines are for matching, not reading; the body loads on demand. */
const CATALOG_DESCRIPTION_MAX_CHARS = 200;

export function formatSkillsCatalog(skills: SkillMetadata[]): string {
  const lines =
    skills.length === 0
      ? '- (none)'
      : skills
          .map((skill) => {
            const description =
              skill.description.length > CATALOG_DESCRIPTION_MAX_CHARS
                ? `${skill.description.slice(0, CATALOG_DESCRIPTION_MAX_CHARS)}…`
                : skill.description;
            return `- ${skill.name}: ${description}`;
          })
          .join('\n');
  return [
    '# Skills',
    'Catalog of procedure packs (name + description).',
    'Load one with load_skill (exact name) when its description matches what you are about to do. Most tasks need none.',
    'Large skills return core rules + a section list; load a section when you need it. Loading does not approve steps or add tools.',
    '',
    lines,
  ].join('\n');
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
        'Load the procedure body for a skill from the catalog. Built-in tools work without a skill.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'Exact skill name from the skills catalog',
          },
          section: {
            type: 'string',
            description: 'Optional section title, for large skills that list their sections.',
          },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'A catalog skill matches the user intent and its body is not already in Loaded skills.',
    ],
    whenNotToUse: [
      'Do not load a skill whose body is already in Loaded skills.',
      'Do not load a skill on every turn.',
      'Do not load a skill instead of calling a built-in tool.',
      'Do not load a skill for small talk or a one-line factual answer.',
      'Do not use offer_choice to decide which skill to load.',
    ],
    usage: [
      'Pass skill_name exactly as listed in the skills catalog.',
      'Follow the loaded steps; they do not grant extra tools or bypass the path jail.',
    ],
  },
  stage: 'skill',
  execute: async (args) => {
    const name = String(args.skill_name ?? '').trim();
    const skill = getSkill(name);
    const section = typeof args.section === 'string' ? args.section : undefined;
    if (skill) return skillForLoad(skill, section);
    const available = listSkills()
      .map((item) => item.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
