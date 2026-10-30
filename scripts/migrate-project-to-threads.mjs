// Usage: node scripts/migrate-project-to-threads.mjs --org <wid> --project <pid> --member <uid>
//          --agent <agentId> [--dry-run] [--yes] [--in-flight] [--emulator host:port] [--firebase-project id]
//          [--subject "Hivenod development"] [--findings-subject "Hive findings"] [--app-url url]
// Turns the project's open items into Inbox threads with a Development plan (slice 8; see
// scripts/migrate-project-lib.mjs for the mapping). --dry-run prints the mapping table and checks
// every document it would write, writing nothing. On production (no --emulator) a real run also
// needs --yes, and the owner's OK at run time (service account GOOGLE_APPLICATION_CREDENTIALS).
// --in-flight also migrates items at agent steps (Shape, Build, Release, Test) as threads at the
// matching step, earlier steps done; without it they are skipped.
// Rerunning is safe: migrated items are skipped, a half-written one is finished.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
const { migrateProject, restClient, formatTable } = await import('./migrate-project-lib.mjs');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const need = (n) => {
  const v = val(n);
  if (!v || v.startsWith('--')) {
    console.error(
      `Missing ${n}. See the usage at the top of scripts/migrate-project-to-threads.mjs.`,
    );
    process.exit(2);
  }
  return v;
};
const wid = need('--org');
const pid = need('--project');
const memberUid = need('--member');
const agentUid = need('--agent');
const emulator = val('--emulator');
const dryRun = flag('--dry-run');
if (!dryRun && !emulator && !flag('--yes')) {
  console.error('A production run writes to Firestore: pass --yes (or --dry-run first).');
  process.exit(2);
}

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
  if (!res.ok) throw new Error(`token failed: ${res.status}`);
  return (await res.json()).access_token;
}

const rest = restClient({
  project: val('--firebase-project') ?? (emulator ? 'demo-hive' : 'hive-board-43be'),
  token: emulator ? 'owner' : await accessToken(),
  ...(emulator ? { base: `http://${emulator}` } : {}),
});
const r = await migrateProject({
  rest,
  wid,
  pid,
  memberUid,
  agentUid,
  dryRun,
  inFlight: flag('--in-flight'),
  ...(val('--subject') ? { subjectName: val('--subject') } : {}),
  ...(val('--findings-subject') ? { findingsSubjectName: val('--findings-subject') } : {}),
  ...(val('--app-url') ? { appUrl: val('--app-url') } : {}),
  log: (s) => console.error(s),
});
console.log(dryRun ? 'DRY RUN (nothing written)' : `RUN: ${r.writes} documents written`);
console.log(formatTable(r.rows));
const count = (a) => r.rows.filter((x) => x.action === a).length;
console.log(
  `${r.rows.length} items: ${count('create')} to create, ${count('resume')} to resume, ` +
    `${count('already migrated')} already migrated, ${count('skip')} skipped`,
);
