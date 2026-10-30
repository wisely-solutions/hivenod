// Usage: node scripts/fix-thread-states.mjs [--dry-run | --apply] [--emulator host:port] [--project id]
// Moves Inbox threads stuck at Your call while the agent carries out an approved outcome or plan
// step to "waiting on the agent" (item OE8FmrTaIxFVGcaeGG3N). Dry run unless --apply.
// With --emulator it talks to the Firestore emulator (token "owner").
// Production runs need the owner's OK at run time (service account GOOGLE_APPLICATION_CREDENTIALS).
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fixThreadStates } from './fix-thread-states-lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const apply = flag('--apply') && !flag('--dry-run');
const emulator = val('--emulator');

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

const r = await fixThreadStates({
  project: val('--project') ?? (emulator ? 'demo-hive' : 'hive-board-43be'),
  token: emulator ? 'owner' : await accessToken(),
  base: emulator ? `http://${emulator}` : undefined,
  apply,
});
console.log(apply ? 'APPLY run' : 'DRY RUN (nothing written; pass --apply to repair)');
console.log(
  `scanned ${r.scanned} threads at Your call, ${r.repair.length} to repair, repaired ${r.repaired}`,
);
for (const p of r.repair) console.log(`  ${p}`);
for (const p of r.skipped) console.log(`  not written: ${p}`);
