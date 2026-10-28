import { describe, expect, it } from 'vitest';
import { cliCommands, TROUBLESHOOTING } from './cli';

describe('agent setup commands (item zLwtX2WEEg3mER4CR74g)', () => {
  it('installs the CLI binary from Hivenod’s own hosting with one command, no Node', () => {
    const c = cliCommands('https://hivenod.com/');
    expect(c.install).toBe('curl -fsSL https://hivenod.com/install.sh | sh');
    expect(c.installWindows).toBe('irm https://hivenod.com/install.ps1 | iex');
    expect(c.check).toBe('hivenod --version');
    expect(Object.keys(c).sort()).toEqual(['check', 'install', 'installWindows']);
  });
  it('troubleshoots the two usual problems', () => {
    const text = TROUBLESHOOTING.map((t) => `${t.problem} ${t.fix}`).join('\n');
    expect(text).toMatch(/command not found[\s\S]*PATH/);
    expect(text).toMatch(/not trusted[\s\S]*Run claude once/);
  });
});
