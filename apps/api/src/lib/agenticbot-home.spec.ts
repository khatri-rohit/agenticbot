import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgenticbotHome } from './agenticbot-home.js';

describe('resolveAgenticbotHome', () => {
  const previousCwd = process.cwd();

  afterEach(() => {
    process.chdir(previousCwd);
  });

  it('defaults to ~/.local/agenticbot for a posix-style homedir', () => {
    const home = resolveAgenticbotHome({
      env: {},
      homedir: '/Users/alice',
    });
    expect(home).toBe(path.join('/Users/alice', '.local', 'agenticbot'));
  });

  it('defaults to %USERPROFILE%\\.local\\agenticbot for a windows-style homedir', () => {
    const home = resolveAgenticbotHome({
      env: {},
      homedir: 'C:\\Users\\Alice',
    });
    expect(home).toBe(path.join('C:\\Users\\Alice', '.local', 'agenticbot'));
  });

  it('resolves AGENTICBOT_HOME to an absolute path', () => {
    const home = resolveAgenticbotHome({
      env: { AGENTICBOT_HOME: path.join('sandbox', 'agent-home') },
      homedir: '/Users/alice',
    });
    expect(path.isAbsolute(home)).toBe(true);
    expect(home).toBe(path.resolve(path.join('sandbox', 'agent-home')));
  });

  it('ignores process.cwd when AGENTICBOT_HOME is unset', () => {
    process.chdir(path.dirname(previousCwd));
    const home = resolveAgenticbotHome({
      env: {},
      homedir: '/home/bob',
    });
    expect(home).toBe(path.join('/home/bob', '.local', 'agenticbot'));
    expect(home).not.toContain(path.basename(previousCwd));
  });
});
