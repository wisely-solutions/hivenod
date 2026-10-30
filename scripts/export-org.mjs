// Usage: node scripts/export-org.mjs --org <workspaceId> --out <file> [--emulator host:port] [--project id]
// Complete JSON export of one organization with admin rights (Projects, Calendar and the rest), the
// operator's counterpart of Settings > Organization > Export organization data. Read-only.
// Production needs the service account (GOOGLE_APPLICATION_CREDENTIALS) and the owner's OK at run time.
// With --emulator it talks to the Firestore emulator (token "owner", project demo-hive).
import { createWriteStream, readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { once } from 'node:events';
import { exportOrganization } from './export-org-lib.mjs';

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const wid = val('--org');
const out = val('--out');
const emulator = val('--emulator');
if (!wid || !out) {
  console.error(
    'Usage: node scripts/export-org.mjs --org <workspaceId> --out <file> [--emulator host:port]',
  );
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

const stream = createWriteStream(out);
const write = async (s) => {
  if (!stream.write(s)) await once(stream, 'drain');
};
try {
  const r = await exportOrganization({
    project: val('--project') ?? (emulator ? 'demo-hive' : 'hive-board-43be'),
    token: emulator ? 'owner' : await accessToken(),
    base: emulator ? `http://${emulator}` : undefined,
    wid,
    write,
    log: (s) => process.stderr.write(`\r${s}   `),
  });
  stream.end();
  await once(stream, 'finish');
  console.log(`\nWrote ${out}: ${r.total} documents`);
  console.log(JSON.stringify(r.counts));
} catch (e) {
  stream.destroy();
  console.error(`\nExport failed: ${e.message}`);
  process.exit(1);
}
