// Hive is now Hivenod (card wQ7ZfmYr, hard cut): no user-visible "Hive" may remain in the web app,
// the shared texts it shows or the CLI. Technical identifiers stay (the Firebase project id
// hive-board-43be, @hive/* workspace packages, the hive_agt_ token prefix, storage keys, the
// HiveError/HiveClient class names); they never match the patterns below. Anything that must
// mention the old name on purpose is listed in ALLOW with the reason.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Where user-visible text lives: sources (not tests), the page shell and the PWA manifest. */
const SCAN = [
  'apps/web/src',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/public',
  'packages/shared/src',
  'packages/agent/src',
];

const OLD_NAME = [
  { why: 'the product name Hive', re: /\bHive\b/ },
  { why: 'the old command (hive run, hive --version, …)', re: /\bhive (?=[a-z<-])/ },
  { why: 'the old command in backticks or quotes', re: /(['"`])hive\1/ },
  { why: 'an error prefix of the old command', re: /['"`]hive: / },
  { why: 'the old tarball', re: /\/cli\/hive-/ },
  { why: 'an old env var', re: /\bHIVE_[A-Z]/ },
  { why: 'the old MCP server', re: /mcp__hive__|mcp_servers\.hive\b|mcpServers\.hive\b/ },
  { why: 'the old token folder', re: /~\/\.hive\b|'\.hive'/ },
];

/** file -> substrings of lines that may mention the old name, and why. */
const ALLOW = {
  // Strips a token left over from the old CLI from the coding CLI's environment (never reads it).
  'packages/agent/src/runner.ts': ['old `hive` CLI', 'delete env.HIVE_TOKEN'],
  'packages/agent/src/interactive.ts': ['old `hive` CLI', 'delete out.HIVE_TOKEN'],
  // Denies the old token folder to the model (never reads it).
  'packages/agent/src/credentials.ts': ["The old `hive` CLI's folder", "join(homedir(), '.hive')"],
};

function files(path) {
  const abs = join(root, path);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { recursive: true })
    .map((f) => join(abs, String(f)))
    .filter((f) => statSync(f).isFile())
    .filter((f) => /\.(tsx?|mjs|js|html|css|json)$/.test(f) && !/\.test\.tsx?$/.test(f));
}

describe('rename to Hivenod (card wQ7ZfmYr)', () => {
  it('leaves no user-visible Hive in the web app, shared texts or the CLI', () => {
    const hits = [];
    for (const file of SCAN.flatMap(files)) {
      const rel = relative(root, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if ((ALLOW[rel] ?? []).some((ok) => line.includes(ok))) return;
          for (const { why, re } of OLD_NAME)
            if (re.test(line)) hits.push(`${rel}:${i + 1}: ${why}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('names the app Hivenod in the tab title and the PWA manifest', () => {
    const html = readFileSync(join(root, 'apps/web/index.html'), 'utf8');
    expect(html).toContain('<title>Hivenod</title>');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Hivenod"');
    const vite = readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8');
    expect(vite).toContain("name: 'Hivenod'");
    expect(vite).toContain("short_name: 'Hivenod'");
  });

  it('catches the old name (the check itself works)', () => {
    const bad = ['Install Hive', 'hive run claude', '`hive`', 'HIVE_TOKEN', 'mcp__hive__*'];
    for (const line of bad) expect(OLD_NAME.some(({ re }) => re.test(line))).toBe(true);
    const fine = ['Hivenod', 'hivenod run claude', 'hive-board-43be', '@hive/shared', 'hive_agt_'];
    for (const line of fine) expect(OLD_NAME.some(({ re }) => re.test(line))).toBe(false);
  });
});
