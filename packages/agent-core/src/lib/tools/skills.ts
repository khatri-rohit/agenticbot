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

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; description: string; instructions: string } {
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
        'Load the body of a named skill from the catalog. Optional. Built-in tools work without a skill.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'Exact skill name from the catalog',
          },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You need the procedure body for a named workflow listed in the skill catalog.',
    ],
    whenNotToUse: [
      'Do not load a skill on every turn.',
      'Do not load a skill instead of calling a built-in tool.',
      'Do not load a skill for small talk or a one-line factual answer.',
    ],
    usage: [
      'Pass skill_name exactly as listed in the catalog.',
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
