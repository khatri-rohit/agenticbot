import type { SubagentProfile } from './types';

/**
 * Specialist profile catalog. Each profile is a declared tuple of
 * (tools, skills, model, posture, prompt section). The model picks one by
 * name via the `delegate` tool; the runtime assembles a registry and prompt
 * so the child's context cache is all signal for that job.
 *
 * `delegate` is never in a child's tool list — recursion is bounded by
 * MAX_SUBAGENT_DEPTH, not by tool availability.
 *
 * All profiles use glm-5.2:cloud. No model routing in v1.
 * No limits field — sub-agents use default WORKSPACE_MODE limits.
 */
export const SUBAGENT_PROFILES: Record<string, SubagentProfile> = {
  research: {
    name: 'research',
    description:
      'Investigate a question against files and the web. Read-only. Returns findings + citations.',
    tools: ['load_skill', 'web_search', 'web_fetch', 'glob', 'grep', 'read_file'],
    skills: ['research', 'home-research'],
    model: 'glm-5.2:cloud',
    posture: 'ask',
    promptSection: `# Research specialist

You are a senior software engineer on a research task. Investigate the question and return a findings digest. Apply the same professional standards as the top-level agent.
- Prefer the open folder first (glob/grep/read_file). Use web_search only when files lack the current API, version, or docs you need.
- Cite source URLs inline. Do not invent live facts.
- Do NOT edit files or run commands. State uncertainties in your digest.
- Return a concise digest (1-2KB): key findings, citations, and open questions.`,
  },

  implement: {
    name: 'implement',
    description:
      'Implement a well-scoped change against the workspace. Edits files only (no terminal). Returns a change summary.',
    tools: ['load_skill', 'glob', 'grep', 'read_file', 'edit_file'],
    skills: ['implement', 'patch-and-verify', 'karpathy-guidelines'],
    model: 'glm-5.2:cloud',
    posture: 'agent',
    promptSection: `# Implement specialist

You are a senior software engineer implementing a change. Make the smallest correct change for the task.
- Read call sites before editing shared types or loop semantics.
- Match neighboring style. Fix root causes in the shared layer, not one-off patches.
- If working in parallel, do NOT edit shared files (lockfiles, catalogs, index files, config). Edit only your assigned files. Note shared-file needs in your summary.
- Do NOT run terminal commands or claim work is verified. State what you changed and what needs verification. The parent agent will run verification.
- Return a concise change summary (1-2KB): files touched, what changed, verify-needed.`,
  },

  review: {
    name: 'review',
    description:
      'Review changes or a diff against repo standards and spec. Read-only. Returns review comments.',
    tools: ['load_skill', 'glob', 'grep', 'read_file', 'web_search', 'web_fetch'],
    skills: ['code-review', 'caveman-review', 'anti-slop-examples'],
    model: 'glm-5.2:cloud',
    posture: 'ask',
    promptSection: `# Review specialist

You are a senior software engineer reviewing code. Review against this repo's standards (AGENTS.md) and the originating spec.
- Read the actual diff/files before commenting. Do not review from memory.
- Do NOT edit files or run commands.
- Each comment: location, problem, fix — one line when possible.
- Return review comments grouped by Standards vs Spec (1-2KB).`,
  },

  plan: {
    name: 'plan',
    description:
      'Plan a chunk of work: set goal, journal decisions, produce a locked brief. Read-only. Returns the plan.',
    tools: ['load_skill', 'glob', 'grep', 'read_file', 'plan', 'todo'],
    skills: ['grilling', 'to-spec', 'wayfinder'],
    model: 'glm-5.2:cloud',
    posture: 'ask',
    promptSection: `# Plan specialist

You are a senior software engineer and architect. Turn the task into a locked brief.
- Journal decisions with plan; finalize when the goal is concrete.
- Break work into tracer-bullet tickets with blocking edges.
- Do NOT edit files, run commands, or implement.
- Return the finalized plan (1-2KB).`,
  },
};

export function getSubagentProfile(name: string): SubagentProfile | undefined {
  const key = name.trim().toLowerCase();
  return SUBAGENT_PROFILES[key];
}

export function listSubagentProfiles(): SubagentProfile[] {
  return Object.values(SUBAGENT_PROFILES).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}