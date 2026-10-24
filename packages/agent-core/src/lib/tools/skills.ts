import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Skill, SkillMetadata, Tool } from './type';

/**
 * Global skills live in packages/agent-core/skills/<name>/SKILL.md.
 * This wave loads that catalog only. Wave 4 should merge user + workspace
 * catalogs through the same listSkills / load_skill API — do not add a second loader.
 *
 * Resolved without import.meta so the CJS lib emit and the API bundle still work.
 */

type ParsedSkillFile = {
  name: string;
  description: string;
  instructions: string;
};

let cached: Skill[] | null = null;

function moduleDir(): string | null {
  try {
    return __dirname;
  } catch {
    return null;
  }
}

export function resolveSkillsRoot(): string {
  const starts = [process.cwd()];
  const fromModule = moduleDir();
  if (fromModule) starts.push(fromModule);

  const candidates: string[] = [];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, 'skills'));
      candidates.push(path.join(dir, 'packages', 'agent', 'core', 'skills'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return path.resolve(process.cwd(), 'packages', 'agent', 'core', 'skills');
}

function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ParsedSkillFile {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) {
    return {
      name: fallbackName,
      description: fallbackName,
      instructions: trimmed.trim(),
    };
  }
  const end = trimmed.indexOf('\n---', 3);
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

function readCatalogFromDisk(): Skill[] {
  const root = resolveSkillsRoot();
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, 'SKILL.md');
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(raw, entry.name);
    skills.push({
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function catalog(): Skill[] {
  if (!cached) cached = readCatalogFromDisk();
  return cached;
}

export function listSkills(): SkillMetadata[] {
  return catalog().map(({ name, description }) => ({ name, description }));
}

function getSkill(name: string): Skill | undefined {
  return catalog().find((skill) => skill.name === name);
}

export const load_skill: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the body of a named skill (patch-and-verify, diagnose-bug, home-research, anti-slop-examples, ai-writing-guidelines). Optional. Built-in tools work without a skill.',
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
      'You need the procedure body for a named workflow in the skill catalog (patch-and-verify, diagnose-bug, home-research, anti-slop-examples, ai-writing-guidelines).',
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
    const skill = String(args.skill_name ?? '').trim();
    const skillBody = getSkill(skill);
    if (skillBody) return skillBody.instructions;
    const available = listSkills()
      .map((item) => item.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
