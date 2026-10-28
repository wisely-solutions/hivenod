import { describe, expect, it } from 'vitest';
import { CLI_INFO, cliLabel, isRunCli, RUN_CLIS } from './clis';

describe('coding CLIs for hivenod run', () => {
  it('claude is verified; codex and copilot are labelled experimental and untested', () => {
    expect(RUN_CLIS).toEqual(['claude', 'codex', 'copilot']);
    expect(cliLabel('claude')).toBe('Claude Code');
    expect(cliLabel('codex')).toBe('Codex (experimental, untested)');
    expect(cliLabel('copilot')).toBe('GitHub Copilot CLI (experimental, untested)');
    expect(CLI_INFO.codex.name).toBe('Codex');
  });
  it('anything else is shown as is', () => {
    expect(isRunCli('gemini')).toBe(false);
    expect(cliLabel('gemini')).toBe('gemini');
  });
});
