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
export function formatSkillBodies(
  names: string[],
  alreadyLoaded: string[] = [],
): string {
  const skip = new Set(alreadyLoaded.map((name) => name.toLowerCase()));
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key) || skip.has(key)) continue;
    seen.add(key);
    blocks.push(`## ${skill.name}\n${skill.instructions}`);
  }
  if (blocks.length === 0) return '';
  return [
    '# Loaded skills',
    'The user attached these packs to this send. Follow them.',
    'Do not call load_skill again for these names.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
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
    'On a new non-trivial task, match this list to the user intent before glob, grep, read_file, or edit_file.',
    'Call load_skill with an exact catalog name to load a body. If none apply, continue without a skill.',
    'Loading does not approve steps or add tools. Do not use offer_choice to pick a skill.',
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
  execute: async (args) => {
    const name = String(args.skill_name ?? '').trim();
    const skill = getSkill(name);
    if (skill) return skill.instructions;
    const available = listSkills()
      .map((item) => item.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
