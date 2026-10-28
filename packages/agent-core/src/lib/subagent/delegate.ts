import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

import type { ToolContext } from '@agent/agent-models';

import { getSubagentProfile, listSubagentProfiles } from './profiles';
import type { SubagentSpec } from './types';
import { MAX_SUBAGENT_DEPTH, encodeSubagentHeader } from './types';
import type { Tool, ToolGuidance } from '../tools/type';

const DELEGATE_DESCRIPTION = `Delegate a task to a specialist sub-agent. The sub-agent runs in an isolated context and returns a concise digest. Delegation keeps your context clean — the sub-agent does the noisy work and returns a summary.

## When to delegate
- Research with multiple unknowns (read many files, search web) → delegate(research)
- Implementation across multiple files or modules → delegate(implement), one per module, assign explicit files
- Code review after implementation → delegate(review). Review is cheap — use liberally.
- Planning a complex change → delegate(plan)

## When NOT to delegate
- Simple single-step tasks — do them yourself
- Quick one-file edit — do it yourself
- Answering a question you already know — just answer
- Running verification (nx typecheck/test) — do it yourself, always

## After delegation
- Run verification yourself (nx typecheck/test)
- Review delegate digests for completeness
- Report combined results to the user

## Profiles
${listSubagentProfiles()
  .map((p) => `- ${p.name}: ${p.description}`)
  .join('\n')}

Avoid fan-out > 5 sub-agents in a single turn.`;

const DELEGATE_DEFINITION: ChatCompletionFunctionTool = {
  type: 'function',
  function: {
    name: 'delegate',
    description: DELEGATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task to delegate. Be specific — include files, scope, and expected output.',
        },
        profile: {
          type: 'string',
          description: 'Specialist profile: research, implement, review, or plan.',
          enum: ['research', 'implement', 'review', 'plan'],
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional override for the profile tool allow-list.',
        },
        focusFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to seed the sub-agent context.',
        },
      },
      required: ['task', 'profile'],
      additionalProperties: false,
    },
  },
};

const DELEGATE_GUIDANCE: ToolGuidance = {
  whenToUse: [
    'Complex, decomposable tasks that would fill your context with tool results',
    'Research requiring many file reads or web searches',
    'Multi-file implementation that can be split by module',
    'Code review after implementation (cheap — use liberally)',
  ],
  whenNotToUse: [
    'Simple single-step tasks — do them yourself',
    'Quick one-file edits',
    'Running verification (nx typecheck/test) — always do this yourself',
  ],
  usage: [
    'Be specific in the task — include files, scope, and expected output format',
    'For parallel implementation, assign explicit files per delegate to avoid conflicts',
    'Avoid fan-out > 5 sub-agents in a single turn',
  ],
};

export const delegate: Tool = {
  definition: DELEGATE_DEFINITION,
  guidance: DELEGATE_GUIDANCE,
  risk: 'external',
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const task = args.task as string | undefined;
    const profileName = args.profile as string | undefined;

    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return 'Error: delegate requires a non-empty "task" argument.';
    }
    if (!profileName) {
      return 'Error: delegate requires a "profile" argument (research, implement, review, or plan).';
    }

    const profile = getSubagentProfile(profileName);
    if (!profile) {
      return `Error: unknown profile "${profileName}". Available: research, implement, review, plan.`;
    }

    // EC7: depth check before spawn — no child thread, no events.
    const depth = ctx.subagentDepth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return 'Agent depth limit reached. Solve the task yourself.';
    }

    const spec: SubagentSpec = {
      task,
      profile: profileName,
      ...(args.tools ? { tools: args.tools as string[] } : {}),
      ...(args.focusFiles ? { focusFiles: args.focusFiles as string[] } : {}),
    };

    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent delegation is not available in this context.';
    }

    // EC2/EC5: catch all errors — delegate.execute never throws.
    try {
      const result = await ctx.spawnSubagent(spec);
      const header = encodeSubagentHeader(result, spec.profile, profileName);
      return `${header}\n\n${result.summary}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error: sub-agent failed: ${msg}`;
    }
  },
};