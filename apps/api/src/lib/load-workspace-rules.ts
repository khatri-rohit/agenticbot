import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceRuleFiles = {
  agentsMd: string;
  project: string;
};

/** Keep project law inside the memory-layer budget, not the full disk files. */
export const WORKSPACE_AGENTS_MD_MAX_CHARS = 8_000;
export const WORKSPACE_PROJECT_MD_MAX_CHARS = 3_200;

function clipNamed(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n(${label} truncated at ${max} chars)`;
}

type ParsedRule = {
  alwaysApply: boolean;
  globs: string[];
  body: string;
  name: string;
};

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return '';
    throw error;
  }
}

function parseFrontmatter(raw: string, name: string): ParsedRule {
  if (!raw.startsWith('---')) {
    return { alwaysApply: false, globs: [], body: raw.trim(), name };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) {
    return { alwaysApply: false, globs: [], body: raw.trim(), name };
  }
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  let alwaysApply = false;
  const globs: string[] = [];
  for (const line of fm.split('\n')) {
    const match = line.match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'alwaysapply') {
      alwaysApply = value.toLowerCase() === 'true';
    }
    if (key === 'globs' || key === 'glob') {
      globs.push(
        ...value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      );
    }
  }
  return { alwaysApply, globs, body, name };
}

/**
 * Load AGENTS.md, PROJECT.md, and .cursor/rules/*.mdc from a workspace.
 * alwaysApply rules are always attached; glob rules are attached with their glob.
 */
export async function loadWorkspaceRules(
  workspaceRoot: string,
): Promise<WorkspaceRuleFiles> {
  const agents = (await readOptional(path.join(workspaceRoot, 'AGENTS.md'))).trim();
  const project = (await readOptional(path.join(workspaceRoot, 'PROJECT.md'))).trim();

  const rulesDir = path.join(workspaceRoot, '.cursor', 'rules');
  let ruleFiles: string[] = [];
  try {
    const entries = await readdir(rulesDir, { withFileTypes: true });
    ruleFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mdc'))
      .map((entry) => path.join(rulesDir, entry.name));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
  }

  const sections: string[] = [];
  if (agents) sections.push(agents);

  for (const filePath of ruleFiles.sort()) {
    const raw = await readFile(filePath, 'utf8');
    const rule = parseFrontmatter(raw, path.basename(filePath));
    if (!rule.body) continue;
    if (!rule.alwaysApply && rule.globs.length === 0) continue;
    const applies = rule.alwaysApply
      ? 'alwaysApply'
      : `globs: ${rule.globs.join(', ')}`;
    sections.push(`## ${rule.name} (${applies})\n\n${rule.body}`);
  }

  return {
    agentsMd: clipNamed(
      sections.join('\n\n'),
      WORKSPACE_AGENTS_MD_MAX_CHARS,
      'AGENTS.md',
    ),
    project: clipNamed(project, WORKSPACE_PROJECT_MD_MAX_CHARS, 'PROJECT.md'),
  };
}
