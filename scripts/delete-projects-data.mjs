// Usage: node scripts/delete-projects-data.mjs --org <workspaceId> --export <file> [--dry-run] [--yes]
//        [--emulator host:port] [--project id]
// Deletes the removed Projects and Calendar data of one organization (item OE8Fm, slice 11):
// projects with their items, attachments, messages, decisions and step proposals; runs and their
// log lines; calendar events; the members' busy blocks of this organization; its agentHomes; and
// its project events. Nothing else (Inbox, members, groups, agents, workspace events) is touched.
//
// It refuses unless --export is this organization's operator export (scripts/export-org.mjs)
// and its counts match the database now. Without --yes it is a dry run: it prints the counts and
// deletes nothing. Deletes go in commits of 400 documents, children first, so a stopped run is
// resumed by running it again (with a fresh export: the counts must match again).
// Production needs the service account (GOOGLE_APPLICATION_CREDENTIALS) and the owner's OK at run
// time; see docs/DEPLOY.md "Deleting the Projects data". With --emulator it talks to the Firestore
// emulator (token "owner", project demo-hive). Tested against the emulator only.
import { readFileSync } from 'node:fs';
import { accessToken } from './rules-compile-time.mjs';
import {
  countsTable,
  deletePaths,
  inventory,
  mismatches,
  readExport,
  restClient,
} from './delete-projects-lib.mjs';

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const wid = val('--org');
const file = val('--export');
const emulator = val('--emulator');
const yes = args.includes('--yes') && !args.includes('--dry-run');
if (!wid || !file) {
  console.error(
    'Usage: node scripts/delete-projects-data.mjs --org <workspaceId> --export <file> [--dry-run] [--yes] [--emulator host:port]',
  );
  process.exit(2);
}

try {
  const exported = readExport(readFileSync(file, 'utf8'), wid);
  const rest = restClient({
    project: val('--project') ?? (emulator ? 'demo-hive' : 'hive-board-43be'),
    token: emulator ? 'owner' : await accessToken(),
    base: emulator ? `http://${emulator}` : undefined,
  });
  const live = await inventory(rest, wid);
  console.log(countsTable(exported, live.counts));
  const bad = mismatches(exported, live.counts);
  if (bad.length) {
    console.error(
      `\nRefused: the export does not match the database (${bad.map((b) => b.name).join(', ')}). Export again, then retry.`,
    );
    process.exit(1);
  }
  if (!yes) {
    console.log(`\nDry run: ${live.paths.length} documents would be deleted. Add --yes to delete.`);
    process.exit(0);
  }
  const n = await deletePaths(rest, live.paths, (s) => process.stderr.write(`\r${s}   `));
  console.log(`\nDeleted ${n} documents of organization ${wid}.`);
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
}
