#!/usr/bin/env node
// Usage: node scripts/rules-size.mjs [rules file]   (default: firestore.rules)
// Prints the compiled size Google computes for the rules, against the 256000-byte release limit,
// and exits 1 when it is over the budget (RULES_COMPILED_BUDGET) or the limit.
// It uploads throwaway rulesets and a throwaway release `size-probe` (never `cloud.firestore`)
// with the service account in GOOGLE_APPLICATION_CREDENTIALS, and deletes them again.
// See docs/DEPLOY.md "Rules size".
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  RULES_COMPILED_BUDGET,
  RULES_COMPILED_LIMIT,
  measureCompiledSize,
  parseCompiledSize,
  rulesSizeVerdict,
} from './rules-size-lib.mjs';

const API = 'https://firebaserules.googleapis.com/v1';
export const PROBE_RELEASE = process.env.RULES_SIZE_PROBE_RELEASE || 'size-probe';

async function accessToken() {
  const key = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000,
  })}`;
  const sig = createSign('RSA-SHA256').update(head).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * Upload `source` as a throwaway ruleset and try the throwaway release; delete both.
 * @returns {Promise<number|null>} the compiled size when refused for size, null when it fit
 */
async function tryRelease(project, token, source) {
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `${API}/projects/${project}`;
  const relName = `projects/${project}/releases/${PROBE_RELEASE}`;
  const del = (name) => fetch(`${API}/${name}`, { method: 'DELETE', headers: H });
  let rs;
  for (let attempt = 0; ; attempt++) {
    rs = await fetch(`${base}/rulesets`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: source }] } }),
    });
    if (rs.status < 500 || attempt >= 6) break;
    await new Promise((res) => setTimeout(res, 5000 * (attempt + 1))); // Google hiccup
  }
  const set = await rs.json().catch(() => ({}));
  if (!rs.ok || !set.name) {
    throw new Error(`rules size probe: ruleset upload failed: ${rs.status} ${set.error?.message ?? ''}`);
  }
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${base}/releases`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name: relName, rulesetName: set.name }),
      });
      const text = await r.text();
      if (r.ok) {
        await del(relName);
        return null;
      }
      const size = parseCompiledSize(text);
      if (size != null) return size;
      if (r.status === 409 && attempt < 2) {
        await del(relName); // left over from an interrupted probe
        continue;
      }
      if (r.status >= 500 && attempt < 6) {
        await new Promise((res) => setTimeout(res, 5000 * (attempt + 1))); // Google hiccup
        continue;
      }
      throw new Error(`rules size probe: release failed: ${r.status} ${text.slice(0, 300)}`);
    }
  } finally {
    await del(set.name);
  }
}

/** The compiled size of `source` as Google counts it (see rules-size-lib.mjs). */
export async function measureRulesSize({ project, source }) {
  const token = await accessToken();
  return measureCompiledSize(source, (s) => tryRelease(project, token, s));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'firestore.rules';
  const project = process.env.HIVENOD_FIREBASE_PROJECT || 'hive-board-43be';
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('rules-size: GOOGLE_APPLICATION_CREDENTIALS is not set');
    process.exit(2);
  }
  const size = await measureRulesSize({ project, source: readFileSync(file, 'utf8') });
  console.log(rulesSizeVerdict(size));
  if (size >= RULES_COMPILED_LIMIT) process.exit(1);
  if (size > RULES_COMPILED_BUDGET) {
    console.error(`over the budget of ${RULES_COMPILED_BUDGET} bytes (docs/DEPLOY.md "Rules size")`);
    process.exit(1);
  }
}
