import { listRuns, type RunSummary } from '../read/runs.js';
import { agentHome, flag, has, type Args } from './args.js';
import { duration, table, tokens } from './format.js';

function rows(runs: RunSummary[], indent = ''): string[][] {
  return runs.flatMap((run) => [
    [
      `${indent}${run.runId.slice(0, 8)}`,
      run.threadId.slice(0, 8),
      run.model ?? '-',
      String(run.depth),
      run.status,
      (run.limitReason ?? '').split(':')[0] ?? '',
      String(run.iterations),
      String(run.toolCalls),
      `${tokens(run.usage?.own.promptTokens)}/${tokens(run.usage?.children.promptTokens)}`,
      duration(run.durationMs),
      run.startedAt?.slice(0, 16).replace('T', ' ') ?? '-',
    ],
    ...rows(run.children, `${indent}  `),
  ]);
}

export const RUNS_HELP = `runs [--home <dir>] [--thread <id>] [--since <iso>] [--json]
  Runs under an agent home, newest first; sub-agent runs nested under their parent.`;

export async function runsCommand(args: Args): Promise<void> {
  const runs = await listRuns(agentHome(args), {
    ...(flag(args, 'thread') ? { threadId: flag(args, 'thread')! } : {}),
    ...(flag(args, 'since') ? { since: flag(args, 'since')! } : {}),
  });
  if (has(args, 'json')) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  console.log(
    table(
      ['run', 'thread', 'model', 'depth', 'status', 'limit', 'iters', 'tools', 'prompt own/children', 'duration', 'started'],
      rows(runs),
    ),
  );
  const warnings = runs.reduce((sum, run) => sum + run.traceWarnings, 0);
  console.log(`\n${runs.length} runs${warnings ? `, ${warnings} corrupt trace lines skipped` : ''}`);
}
