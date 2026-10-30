import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSkillHash } from './plugin-hash.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('hivenod plugin skill', () => {
  const skill = read('plugins/hivenod/skills/hivenod/SKILL.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  it('has valid frontmatter (name, description)', () => {
    expect(fm).toMatch(/^name: hivenod$/m);
    expect(fm).toMatch(/^description: .{40,}/m);
  });
  it('carries the visual rule for summaries at person steps (item OE8FmrTaIxFVGcaeGG3N)', () => {
    for (const w of [
      'thread_summary',
      'At every person step',
      'noVisualWhy',
      'summarize',
      '`thread_attach` both, then an `image_pair`',
    ])
      expect(skill).toContain(w);
  });
  it('is threads only: projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 11)', () => {
    for (const w of ['read_item', 'kind="work"', 'list_work', 'item_done', 'Build it'])
      expect(skill).not.toContain(w);
  });
  it('carries the orchestration hint the channel protocol no longer has', () => {
    for (const w of ['sub-agent', 'SendMessage', 'TaskStop', 'inbox', 'threadId', 'thread_read'])
      expect(skill).toContain(w);
  });
  it('is shipped by the plugin at version 0.3.9 and the marketplace points at it', () => {
    expect(JSON.parse(read('plugins/hivenod/.claude-plugin/plugin.json')).version).toBe('0.3.9');
    const m = JSON.parse(read('.claude-plugin/marketplace.json'));
    expect(JSON.stringify(m)).toContain('./plugins/hivenod');
  });
});

describe('hivenod plugin fallback hint', () => {
  it('a SessionStart hook points the session at the skill (Claude only, not in the channel)', () => {
    const h = JSON.parse(read('plugins/hivenod/hooks/hooks.json'));
    const cmd = h.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('hivenod skill');
  });
});

describe('hivenod plugin skill hash', () => {
  it('skillHash in plugin.json matches the skill and hook files', () => {
    const m = JSON.parse(read('plugins/hivenod/.claude-plugin/plugin.json'));
    expect(
      m.skillHash,
      'skill files changed: bump plugin.json version and update skillHash (node scripts/plugin-hash.mjs --write)',
    ).toBe(computeSkillHash());
  });
});
