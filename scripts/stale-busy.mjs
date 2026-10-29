// Usage: node scripts/stale-busy.mjs [--apply] [--emulator host:port] [--project id]
// Dry run unless --apply. With --emulator it talks to the Firestore emulator (token "owner").
// Production runs need the owner's OK at run time (service account GOOGLE_APPLICATION_CREDENTIALS).
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { cleanStaleBusy } from './stale-busy-lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const apply = flag('--apply');
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

const r = await cleanStaleBusy({
  project: val('--project') ?? (emulator ? 'demo-hive' : 'hive-board-43be'),
  token: emulator ? 'owner' : await accessToken(),
  base: emulator ? `http://${emulator}` : undefined,
  apply,
});
console.log(apply ? 'APPLY run' : 'DRY RUN (nothing deleted; pass --apply to delete)');
console.log(`scanned ${r.scanned} busy blocks, ${r.stale} stale, deleted ${r.deleted}`);
console.log('stale per organization:', r.perOrg);
console.log('stale per user:', r.perUser);
