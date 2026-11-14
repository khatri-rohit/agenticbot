import type { ToolContext } from '@agent/agent-models';
import {
  encodeSubagentHeader,
  MAX_CONCURRENT_SUBAGENTS,
  THOROUGHNESS_TOOL_CALLS,
  type SubagentSpec,
} from '@agent/agent-models';

import type { Tool } from '../tools/types';
import type { SubagentProfile } from './types';

const THOROUGHNESS = ['quick', 'medium', 'thorough'] as const;

const EFFORT_TEXT = THOROUGHNESS.map((level) => `${level} (${THOROUGHNESS_TOOL_CALLS[level]} tool calls)`).join(', ');

function describe(profiles: SubagentProfile[]): string {
  return `Hand a self-contained side task to a specialist sub-agent with its own context. You get back a short report, not its raw tool output.

Profiles:
${profiles.map((profile) => `- ${profile.name}: ${profile.description}`).join('\n')}

Rules:
- Delegate wide reading (more than ~5 files, several searches, or web research) to explore. Answer it yourself when a couple of reads will do.
- One explore per question. Start several only for clearly separate areas (different folders or files), and split them by area, never by sections of your answer: children with overlapping scope read the same files and cost the run several times over.
- Effort is a budget: ${EFFORT_TEXT}. The child stops at it. A new brief gets at most medium (explore's default); thorough is granted when you resume a sub-agent whose report came back partial.
- Name the files or folders a brief covers in paths: a brief whose paths overlap a running sub-agent's is refused.
- The child's findings join your record; its report lists open questions. Check those gaps, not its findings.
- Trust the report: it cites path:line for each finding. Check only what it marks uncertain or lists as open; do not repeat its search.
- For a change beyond a file or two, run review once after your edits pass the check; skip it for a small change. Fix findings inside the user's request; list the rest instead of acting on them.
- Use advisor when stuck, with one specific question.
- Never delegate edits or verification; you own both.
- Write a real brief: objective (what to find or decide) and scope (files, folders, or questions; what to ignore).
- Independent briefs in one turn run in parallel (at most ${MAX_CONCURRENT_SUBAGENTS} at a time).`;
}

/**
 * The parent-side tool. Validation lives here; spawning, capabilities, and
 * budgets live in the runner the loop binds to `ctx.spawnSubagent`.
 */
export function createDelegateTool(profiles: SubagentProfile[]): Tool {
  const names = profiles.map((profile) => profile.name);
  return {
    definition: {
      type: 'function',
      function: {
        name: 'delegate',
        description: describe(profiles),
        parameters: {
          type: 'object',
          properties: {
            profile: { type: 'string', enum: names, description: 'Which specialist.' },
            objective: {
              type: 'string',
              description: 'What the sub-agent must find, check, or decide. One sentence.',
            },
            scope: {
              type: 'string',
              description: 'Where to look and where to stop: files, folders, questions, and what is out of bounds.',
            },
            outputFocus: {
              type: 'string',
              description: 'Optional: what the report should emphasize.',
            },
            thoroughness: {
              type: 'string',
              enum: [...THOROUGHNESS],
              description: `Optional effort budget: ${EFFORT_TEXT}. The child stops at it. A new brief gets at most medium; thorough applies when resuming a partial sub-agent.`,
            },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: workspace files or folders this brief covers. Overlap with a running sub-agent is refused.',
            },
            resume: {
              type: 'string',
              description: 'Optional: subThreadId of an earlier sub-agent to continue with its history.',
            },
          },
          required: ['profile', 'objective', 'scope'],
          additionalProperties: false,
        },
      },
    },
    guidance: {
      whenToUse: [
        'A side task would fill your context with search results or file contents you will not need again.',
      ],
      whenNotToUse: ['One or two reads answer it, or the task is an edit or verification.'],
      usage: ['Give objective and scope; never delegate writes.'],
    },
    risk: 'external',
    stage: 'subagent',
    // The child run has its own wall-clock limit.
    ownsTimeout: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const text = (key: string) =>
        typeof args[key] === 'string' ? (args[key] as string).trim() : '';
      const profile = text('profile').toLowerCase();
      const objective = text('objective');
      const scope = text('scope');
      if (!names.includes(profile)) {
        return `Error: unknown profile "${profile}". Available: ${names.join(', ')}.`;
      }
      if (!objective || !scope) {
        return 'Error: delegate needs both "objective" and "scope".';
      }
      if (!ctx.spawnSubagent) {
        return 'Error: delegation is not available in this run.';
      }
      const thoroughness = text('thoroughness');
      const spec: SubagentSpec = {
        profile,
        objective,
        scope,
        ...(text('outputFocus') ? { outputFocus: text('outputFocus') } : {}),
        ...((THOROUGHNESS as readonly string[]).includes(thoroughness)
          ? { thoroughness: thoroughness as SubagentSpec['thoroughness'] }
          : {}),
        ...(text('resume') ? { resume: text('resume') } : {}),
        ...(Array.isArray(args.paths)
          ? { paths: (args.paths as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
          : {}),
      };
      const result = await ctx.spawnSubagent(spec);
      return `${encodeSubagentHeader(result)}\n\n${result.digest}`;
    },
  };
}
