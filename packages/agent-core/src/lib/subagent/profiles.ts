import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ModelRole } from '@agent/agent-models';

import { getSkill } from '../tools/skills';
import type { SubagentContext, SubagentLimits, SubagentProfile } from './types';

/**
 * Built-in specialists. Writes stay with the parent (one writer, many
 * readers): no profile edits files or runs commands, and planning stays in
 * the parent, which is the only agent that holds the conversation.
 */
const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: 'explore',
    description:
      'Read-only search of the workspace (and the web when the parent has it). Use for questions that need more than ~5 files or several searches. Returns findings with path:line evidence.',
    modelRole: 'fast',
    tools: ['glob', 'grep', 'read_file', 'recall', 'web_search', 'web_fetch'],
    limits: { maxIterations: 20, maxToolCalls: 60, maxWallMs: 5 * 60_000, maxPromptTokens: 300_000 },
    context: 'none',
    rules: false,
    report: true,
    skills: [],
    inheritPickedSkills: false,
    source: 'builtin',
    prompt: `You are a code search specialist. Find what the brief asks for and stop.
- Start broad (glob, grep), then read only the files that matter.
- Every finding cites evidence as path:line, or a URL for web facts.
- If something is not in the workspace, say so; do not guess.`,
  },
  {
    name: 'review',
    description:
      'Fresh-context review of uncommitted changes against the user request and project rules. Run once after edits pass verification. Returns issues with location, problem, fix, severity.',
    modelRole: 'strong',
    tools: ['diff', 'glob', 'grep', 'read_file', 'recall'],
    limits: { maxIterations: 15, maxToolCalls: 50, maxWallMs: 5 * 60_000, maxPromptTokens: 300_000 },
    context: 'diff',
    rules: true,
    report: true,
    skills: ['caveman-review', 'anti-slop-examples'],
    inheritPickedSkills: true,
    source: 'builtin',
    prompt: `You are a code reviewer with no stake in the change.
- Start with the diff tool, then read surrounding code where a change touches shared types, callers, or error paths.
- Report real defects: wrong behavior, broken contracts, missed edge cases, rule violations. Skip style nits the project rules do not require.
- Mark anything outside the user's request as out of scope instead of asking for it.
- Each issue: location (path:line), problem, fix, severity.`,
  },
  {
    name: 'advisor',
    description:
      'Second opinion from a stronger model that sees this whole conversation. Use when stuck (same failure twice) or before a risky design choice. Ask one specific question.',
    modelRole: 'strong',
    tools: [],
    limits: { maxIterations: 2, maxToolCalls: 0, maxWallMs: 3 * 60_000, maxPromptTokens: 600_000 },
    context: 'fork',
    rules: false,
    report: false,
    skills: [],
    inheritPickedSkills: false,
    source: 'builtin',
    prompt: '',
  },
];

let userRoot: string | null = null;
let knownTools: Set<string> | null = null;
let cachedUser: SubagentProfile[] | null = null;
/** File names + mtimes of the agents folder when `cachedUser` was built. */
let cachedSignature = '';
const warnings: string[] = [];

/**
 * Host sets the user agents folder ($AGENT_HOME/agents) and the tool names
 * that exist, so user profiles naming unknown tools are rejected at load.
 */
export function configureSubagentRoot(root: string | null, toolNames: string[]): void {
  userRoot = root ? path.resolve(root) : null;
  knownTools = new Set(toolNames);
  cachedUser = null;
}

/** Problems found while loading user agents (unknown tools, bad fields). */
export function subagentProfileWarnings(): string[] {
  listSubagentProfiles();
  return [...warnings];
}

function frontmatter(raw: string): { fields: Map<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r/g, '');
  const fields = new Map<string, string>();
  if (!text.startsWith('---')) return { fields, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fields, body: text.trim() };
  for (const line of text.slice(3, end).split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim().replace(/^['"]|['"]$/g, ''));
  }
  return { fields, body: text.slice(end + 4).trim() };
}

const ROLES: ModelRole[] = ['main', 'fast', 'strong'];
const USER_CONTEXTS: SubagentContext[] = ['none', 'diff'];

function parseUserProfile(file: string, raw: string): SubagentProfile | string {
  const { fields, body } = frontmatter(raw);
  const name = (fields.get('name') ?? path.basename(file, '.md')).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) return `${file}: invalid name "${name}"`;
  const description = fields.get('description')?.trim();
  if (!description) return `${file}: description is required`;
  if (!body) return `${file}: prompt body is empty`;
  const role = (fields.get('model') ?? 'main') as ModelRole;
  if (!ROLES.includes(role)) return `${file}: model must be one of ${ROLES.join(', ')}`;
  const context = (fields.get('context') ?? 'none') as SubagentContext;
  if (!USER_CONTEXTS.includes(context)) return `${file}: context must be none or diff`;
  const tools = (fields.get('tools') ?? 'glob, grep, read_file, recall')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  const unknown = knownTools ? tools.filter((tool) => !knownTools!.has(tool)) : [];
  if (unknown.length > 0) return `${file}: unknown tools ${unknown.join(', ')}`;
  const skills = (fields.get('skills') ?? '')
    .split(',')
    .map((skill) => skill.trim())
    .filter(Boolean);
  const turns = Number(fields.get('maxturns') ?? 15);
  const limits: SubagentLimits = {
    maxIterations: Number.isFinite(turns) && turns > 0 ? Math.min(Math.floor(turns), 40) : 15,
    maxToolCalls: 60,
    maxWallMs: 5 * 60_000,
    maxPromptTokens: 300_000,
  };
  return {
    name,
    description,
    modelRole: role,
    tools,
    limits,
    context,
    rules: fields.get('rules') === 'true' || context === 'diff',
    report: fields.get('report') !== 'false',
    skills,
    inheritPickedSkills: fields.get('inheritpickedskills') === 'true',
    prompt: body,
    source: 'user',
  };
}

/** Cheap change detector: adding, removing, or editing an agent file reloads. */
function folderSignature(root: string): { files: string[]; signature: string } {
  let files: string[] = [];
  try {
    files = readdirSync(root).filter((file) => file.endsWith('.md'));
  } catch {
    return { files: [], signature: '' };
  }
  const signature = files
    .map((file) => {
      try {
        return `${file}:${statSync(path.join(root, file)).mtimeMs}`;
      } catch {
        return file;
      }
    })
    .sort()
    .join('|');
  return { files, signature };
}

function userProfiles(): SubagentProfile[] {
  const current = userRoot ? folderSignature(userRoot) : { files: [], signature: '' };
  if (cachedUser && current.signature === cachedSignature) return cachedUser;
  cachedSignature = current.signature;
  warnings.length = 0;
  cachedUser = [];
  if (!userRoot) return cachedUser;
  const files = current.files;
  const builtinNames = new Set(BUILTIN_PROFILES.map((profile) => profile.name));
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(path.join(userRoot, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseUserProfile(file, raw);
    if (typeof parsed === 'string') {
      warnings.push(parsed);
    } else if (builtinNames.has(parsed.name)) {
      warnings.push(`${file}: "${parsed.name}" is a built-in profile name`);
    } else {
      cachedUser.push(parsed);
    }
  }
  return cachedUser;
}

/**
 * Bound skills that do not exist are dropped with a warning (startup log via
 * subagentProfileWarnings), never silently at spawn.
 */
function withKnownSkills(profile: SubagentProfile): SubagentProfile {
  const missing = profile.skills.filter((name) => !getSkill(name));
  if (missing.length === 0) return profile;
  const note = `${profile.name}: unknown skills ${missing.join(', ')} (dropped)`;
  if (!warnings.includes(note)) warnings.push(note);
  return { ...profile, skills: profile.skills.filter((name) => getSkill(name)) };
}

export function listSubagentProfiles(): SubagentProfile[] {
  return [...BUILTIN_PROFILES, ...userProfiles()].map(withKnownSkills);
}

export function getSubagentProfile(name: string): SubagentProfile | undefined {
  const key = name.trim().toLowerCase();
  return listSubagentProfiles().find((profile) => profile.name === key);
}
