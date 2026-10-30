#!/usr/bin/env node
// Usage: node scripts/rules-compile-time.mjs [rules file] [tries]   (default: firestore.rules, 5)
// Exits 1 when the rules never compile within Google's deadline or do not compile at all.
// Times how long Google's Rules API takes to compile the rules: POST projects/<p>:test with the
// source only (no test cases). Read-only: it creates no ruleset and no release. Prints the HTTP
// status and milliseconds of each try. Uses the service account in GOOGLE_APPLICATION_CREDENTIALS.
// See docs/DEPLOY.md "Rules size and compile time".
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { probeCompile } from './rules-compile-lib.mjs';

const API = 'https://firebaserules.googleapis.com/v1';

export async function accessToken() {
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

/** One compile of `source`: { status, ms, message }. */
export async function compileOnce({ project, source, token, fetchImpl = fetch }) {
  const t0 = Date.now();
  const r = await fetchImpl(`${API}/projects/${project}:test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: source }] } }),
  });
  const text = await r.text();
  const ms = Date.now() - t0;
  let message;
  let errors = 0;
  try {
    const j = JSON.parse(text);
    const issues = j.issues ?? [];
    errors = issues.filter((i) => i.severity === 'ERROR').length;
    // Errors first: rules with an error compile fast and would look healthy.
    const sorted = [...issues].sort((a, b) => (b.severity === 'ERROR') - (a.severity === 'ERROR'));
    message = j.error?.message ?? sorted.map((i) => `${i.severity}: ${i.description}`).join('; ');
  } catch {
    message = text.slice(0, 200);
  }
  return { status: r.status, ms, message, errors };
}

/** Probe `source` (see rules-compile-lib.mjs): `tries` compiles, plus a tiny ruleset if none passes. */
export async function measureCompileTime({ project, source, tries = 3, getToken = accessToken }) {
  const token = await getToken();
  return probeCompile({
    source,
    tries,
    compile: (s) => compileOnce({ project, source: s, token }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2] || 'firestore.rules';
  const tries = Number(process.argv[3] || 5);
  const project = process.env.HIVENOD_FIREBASE_PROJECT || 'hive-board-43be';
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('rules-compile-time: GOOGLE_APPLICATION_CREDENTIALS is not set');
    process.exit(2);
  }
  const v = await measureCompileTime({ project, source: readFileSync(file, 'utf8'), tries });
  v.ours.forEach((r, i) =>
    console.log(
      `${i + 1}/${tries}: ${r.status} ${r.ms} ms${r.message ? ` ${r.message.slice(0, 160)}` : ''}`,
    ),
  );
  for (const r of v.tiny) console.log(`tiny ruleset: ${r.status} ${r.ms} ms`);
  const ok = v.ours.filter((r) => r.status === 200).map((r) => r.ms);
  console.log(
    `${file}: ${ok.length}/${tries} compiled` +
      (ok.length ? `, min ${Math.min(...ok)} ms, max ${Math.max(...ok)} ms` : ''),
  );
  console.log(v.message);
  if (!['ok', 'borderline'].includes(v.verdict)) process.exit(1);
}
