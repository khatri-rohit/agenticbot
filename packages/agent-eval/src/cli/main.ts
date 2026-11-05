import { ANALYZE_HELP, analyzeCommand } from './analyze.js';
import { parseArgs, type Args } from './args.js';
import { BASELINE_HELP, GATE_HELP, baselineCommand, gateCommand } from './gate.js';
import { METRICS_HELP, metricsCommand } from './metrics.js';
import { RUNS_HELP, runsCommand } from './runs.js';
import { RUN_HELP, SEED_HELP, runCommand, seedCommand } from './trials.js';

type Command = { help: string; run: (args: Args) => Promise<void | number> };

const COMMANDS: Record<string, Command> = {
  runs: { help: RUNS_HELP, run: runsCommand },
  metrics: { help: METRICS_HELP, run: metricsCommand },
  analyze: { help: ANALYZE_HELP, run: analyzeCommand },
  seed: { help: SEED_HELP, run: seedCommand },
  run: { help: RUN_HELP, run: runCommand },
  baseline: { help: BASELINE_HELP, run: baselineCommand },
  gate: { help: GATE_HELP, run: gateCommand },
};

function usage(): string {
  return [
    'agent-eval <command> [options]',
    '',
    ...Object.values(COMMANDS).map((command) => command.help),
  ].join('\n');
}

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  const args = parseArgs(rest);
  if (!command || args.flags.has('help')) {
    console.log(command ? command.help : usage());
    return command || name === undefined || name === '--help' ? 0 : 1;
  }
  return (await command.run(args)) ?? 0;
}

// exitCode, not process.exit(): exiting while fetch sockets are still
// closing aborts Node on Windows (libuv UV_HANDLE_CLOSING assertion).
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
