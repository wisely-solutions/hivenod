import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('hivenod plugin skill', () => {
  const skill = read('plugins/hivenod/skills/hivenod/SKILL.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  it('has valid frontmatter (name, description)', () => {
    expect(fm).toMatch(/^name: hivenod$/m);
    expect(fm).toMatch(/^description: .{40,}/m);
  });
  it('carries the orchestration hint the channel protocol no longer has', () => {
    for (const w of ['sub-agent', 'SendMessage', 'TaskStop', 'release', 'inbox', 'itemId'])
      expect(skill).toContain(w);
  });
  it('is shipped by the plugin at version 0.2.0 and the marketplace points at it', () => {
    expect(JSON.parse(read('plugins/hivenod/.claude-plugin/plugin.json')).version).toBe('0.2.0');
    const m = JSON.parse(read('.claude-plugin/marketplace.json'));
    expect(JSON.stringify(m)).toContain('./plugins/hivenod');
  });
});
