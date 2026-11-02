import { spawn } from 'node:child_process';

export type ExecResult = {
  code: number;
  /** stdout + stderr interleaved (tail), for logs and check output. */
  out: string;
  /** stdout only: parse this, never `out` (git prints warnings on stderr). */
  stdout: string;
  timedOut: boolean;
};

/** Output kept per command (tail); grading only needs the end of a long log. */
const MAX_OUT = 20_000;

function tail(text: string): string {
  return text.length > MAX_OUT ? text.slice(-MAX_OUT) : text;
}

/**
 * Run a command and capture its output. Never throws on a non-zero exit.
 * With `shell`, `command` is one command line (task checks) and takes no args.
 */
export function exec(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; shell?: boolean },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const options = { cwd: opts.cwd, windowsHide: true, env: process.env };
    const child = opts.shell
      ? spawn([command, ...args].join(' '), { ...options, shell: true })
      : spawn(command, args, options);
    let out = '';
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out = tail(out + text);
      stdout += text;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out = tail(out + chunk.toString('utf8'));
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: tail(`${out}\n${error.message}`), stdout, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? -1 : (code ?? -1), out, stdout, timedOut });
    });
  });
}

export async function git(cwd: string, args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd });
}
