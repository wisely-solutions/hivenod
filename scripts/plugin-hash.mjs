#!/usr/bin/env node
// SHA-256 over the plugin's skill and hook files. plugin.json carries it as `skillHash`,
// so every change to what agents read forces a deliberate version bump.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(root, 'plugins/hivenod');
const manifestPath = join(pluginDir, '.claude-plugin/plugin.json');

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

export function computeSkillHash() {
  const list = ['skills', 'hooks']
    .flatMap((d) => files(join(pluginDir, d)))
    .map((p) => relative(pluginDir, p).split('\\').join('/'))
    .sort();
  const h = createHash('sha256');
  for (const f of list) {
    h.update(`${f}\0`);
    h.update(readFileSync(join(pluginDir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hash = computeSkillHash();
  if (process.argv.includes('--write')) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.skillHash = hash;
    writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
    console.log(`skillHash written: ${hash}`);
  } else console.log(hash);
}
