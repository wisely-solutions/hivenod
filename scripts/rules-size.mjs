#!/usr/bin/env node
// Usage: node scripts/rules-size.mjs [rules file]   (default: firestore.rules)
// Prints the compiled size Google computes for the rules, against the 256000-byte release limit,
// and exits 1 when it is over the budget (RULES_COMPILED_BUDGET) or the limit.
// It uploads throwaway rulesets and a throwaway release `size-probe` (never `cloud.firestore`)
// with the service account in GOOGLE_APPLICATION_CREDENTIALS, and deletes them again.
// See docs/DEPLOY.md "Rules size and compile time".
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

const pause = (ms) => new Promise((res) => setTimeout(res, ms));
// Google's rules API answers 503 and 429 (quota) now and then: retry those with a growing pause.
const transient = (status) => status === 429 || status >= 500;

/**
 * Upload `source` as a throwaway ruleset and try the throwaway release; delete both.
 * @returns {Promise<number|null>} the compiled size when refused for size, null when it fit
 */
async function tryRelease(project, token, source) {
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `${API}/projects/${project}`;
  const relName = `projects/${project}/releases/${PROBE_RELEASE}`;
  const send = async (method, url, body) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
      } catch (e) {
        if (attempt >= 6) throw e; // the network itself: try again
      }
      if (r && (!transient(r.status) || attempt >= 6)) return r;
      await pause(5000 * (attempt + 1));
    }
  };
  const del = async (name) => {
    const r = await send('DELETE', `${API}/${name}`).catch((e) => ({ status: e.message }));
    if (!r.ok && r.status !== 404)
      console.warn(`rules size probe: could not delete ${name} (${r.status}); delete it by hand`);
  };
  const rs = await send('POST', `${base}/rulesets`, {
    source: { files: [{ name: 'firestore.rules', content: source }] },
  });
  const set = await rs.json().catch(() => ({}));
  if (!rs.ok || !set.name) {
    throw new Error(
      `rules size probe: ruleset upload failed: ${rs.status} ${set.error?.message ?? ''}`,
    );
  }
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await send('POST', `${base}/releases`, { name: relName, rulesetName: set.name });
      const text = await r.text();
      if (r.ok) return null;
      const size = parseCompiledSize(text);
      if (size != null) return size;
      // 409: a probe release left over (an interrupted run, or a 503 that did create it);
      // 429/5xx: a Google hiccup. Either way: drop the probe release and try again.
      if ((r.status === 409 || transient(r.status)) && attempt < 6) {
        await del(relName);
        await pause(r.status === 409 ? 0 : 5000 * (attempt + 1));
        continue;
      }
      throw new Error(`rules size probe: release failed: ${r.status} ${text.slice(0, 300)}`);
    }
  } finally {
    await del(relName);
    await del(set.name);
  }
}

/**
 * A 503 on the ruleset upload can still create the ruleset (seen in practice), and its name
 * never reaches us; an interrupted probe leaves its padded rulesets too. Afterwards, delete the
 * rulesets of the last 24 hours that no release uses and whose source is one this probe uploaded
 * or carries the probe's pad functions.
 */
async function sweepProbeRulesets(project, token, since, uploaded) {
  const H = { authorization: `Bearer ${token}` };
  const get = async (url) => {
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
    return r.json();
  };
  const base = `${API}/projects/${project}`;
  const inUse = new Set();
  let recent = [];
  for (let page = ''; ;) {
    const j = await get(`${base}/releases?pageSize=100${page ? `&pageToken=${page}` : ''}`);
    for (const r of j.releases ?? []) inUse.add(r.rulesetName);
    if (!(page = j.nextPageToken)) break;
  }
  for (let page = ''; ;) {
    const j = await get(`${base}/rulesets?pageSize=100${page ? `&pageToken=${page}` : ''}`);
    recent = recent.concat((j.rulesets ?? []).filter((r) => r.createTime >= since));
    if (!(page = j.nextPageToken)) break;
  }
  for (const r of recent) {
    if (inUse.has(r.name)) continue;
    const content = (await get(`${API}/${r.name}`)).source?.files?.[0]?.content;
    if (!uploaded.has(content) && !String(content).includes('function zzSizePad')) continue;
    const d = await fetch(`${API}/${r.name}`, { method: 'DELETE', headers: H });
    if (!d.ok && d.status !== 404)
      console.warn(`rules size probe: could not delete ${r.name} (${d.status}); delete it by hand`);
  }
}

/** The compiled size of `source` as Google counts it (see rules-size-lib.mjs). */
export async function measureRulesSize({ project, source, getToken = accessToken }) {
  const token = await getToken();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const uploaded = new Set();
  try {
    return await measureCompiledSize(source, (s) => {
      uploaded.add(s);
      return tryRelease(project, token, s);
    });
  } finally {
    await sweepProbeRulesets(project, token, since, uploaded).catch((e) =>
      console.warn(`rules size probe: cleanup check failed (${e.message})`),
    );
  }
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
    console.error(
      `over the budget of ${RULES_COMPILED_BUDGET} bytes (docs/DEPLOY.md "Rules size and compile time")`,
    );
    process.exit(1);
  }
}
