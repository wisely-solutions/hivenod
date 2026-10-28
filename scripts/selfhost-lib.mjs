// `pnpm selfhost:init` (item 07W4gCboOicS0lM1bqwZ): one command that turns a Firebase project of
// your own into a working Hivenod. Every step looks first and only creates what is missing, so the
// command can run again at any time (it is also how a self-hosted install is updated).
// The pure parts live here (tested in selfhost-lib.test.mjs); scripts/selfhost-init.mjs wires them
// to the real firebase CLI, the build and the terminal.

/** Files the command writes at the repo root (git-ignored): your settings and the deploy config. */
export const SETTINGS_FILE = 'hivenod.selfhost.json';
export const FIREBASE_CONFIG_FILE = 'firebase.selfhost.json';
export const DEFAULT_LOCATION = 'eur3';
export const WEB_APP_NAME = 'Hivenod';

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const HELP = `pnpm selfhost:init [options]: run Hivenod in a Firebase project of your own.

It uses or creates the project, its web app, the Firestore database and Auth (email and Google
sign-in), builds Hivenod, deploys hosting, rules and indexes, and checks the site. Every step looks
first and only creates what is missing: run it again to update your install.

  --project <id>          your Firebase project id (asked when not given)
  --location <id>         Firestore location for a new database (default ${DEFAULT_LOCATION})
  --support-email <mail>  shown on Google's sign-in screen (required for Google sign-in)
  --domain <host>         your own domain for the site, once set up in Hosting (optional)
  --yes, -y               no questions: use the flags and the saved settings
  --dry-run               only print the steps, call nothing (no Google, no build)
  --skip-build            deploy the build already in apps/web/dist
  --help, -h              this text

Settings are saved in ${SETTINGS_FILE} and the deploy config in ${FIREBASE_CONFIG_FILE}
(both git-ignored). Credentials: \`firebase login\`, or GOOGLE_APPLICATION_CREDENTIALS.`;

/** Parses the command line; throws a plain message on a mistake. */
export function parseArgs(argv) {
  const o = { yes: false, dryRun: false, skipBuild: false, help: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a];
    const take = () => (inline !== undefined ? inline : value(i++, flag));
    switch (flag) {
      case '--project':
        o.project = take();
        break;
      case '--location':
        o.location = take();
        break;
      case '--support-email':
        o.supportEmail = take();
        break;
      case '--domain':
        o.domain = take();
        break;
      case '--yes':
      case '-y':
        o.yes = true;
        break;
      case '--dry-run':
        o.dryRun = true;
        break;
      case '--skip-build':
        o.skipBuild = true;
        break;
      case '--help':
      case '-h':
        o.help = true;
        break;
      default:
        throw new Error(`unknown option ${a} (see --help)`);
    }
  }
  return o;
}

/** A plain message for each value that is not usable, or [] when all are fine. */
export function settingsProblems(s) {
  const bad = [];
  if (!s.project) bad.push('a project id is needed (--project)');
  else if (!PROJECT_ID.test(s.project))
    bad.push(`"${s.project}" is not a Firebase project id (6-30 lower-case letters, digits, -)`);
  if (s.project === 'hive-board-43be')
    bad.push('that is the hosted service at https://hivenod.com; use a project of your own');
  if (s.location && !/^[a-z0-9-]{2,40}$/.test(s.location))
    bad.push(`"${s.location}" is not a Firestore location (e.g. eur3, nam5, europe-west1)`);
  if (!s.supportEmail) bad.push('a support email is needed for Google sign-in (--support-email)');
  else if (!EMAIL.test(s.supportEmail)) bad.push(`"${s.supportEmail}" is not an email address`);
  if (s.domain) {
    const d = normalizeDomain(s.domain);
    if (!DOMAIN.test(d)) bad.push(`"${s.domain}" is not a domain name (like hivenod.example.org)`);
    if (d === 'hivenod.com') bad.push('hivenod.com is the hosted service; use your own domain');
  }
  return bad;
}

/** "https://Board.Example.org/" -> "board.example.org". */
export function normalizeDomain(d) {
  return String(d ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/** The flags win over the saved settings, which win over the defaults. */
export function mergeSettings(flags, saved = {}) {
  const pick = (k) => flags[k] ?? saved[k];
  const out = {
    project: pick('project'),
    location: pick('location') ?? DEFAULT_LOCATION,
    supportEmail: pick('supportEmail'),
    domain: pick('domain') ? normalizeDomain(pick('domain')) : undefined,
  };
  // A saved site belongs to its project: another project starts afresh.
  if (saved.project && saved.project === out.project) {
    if (saved.site) out.site = saved.site;
    if (saved.appId) out.appId = saved.appId;
    if (saved.firebase) out.firebase = saved.firebase;
  }
  return out;
}

/** The web address people use: your domain, else the project's default Hosting address. */
export function siteUrlFor(settings, defaultSiteUrl) {
  if (settings.domain) return `https://${settings.domain}`;
  return defaultSiteUrl ?? `https://${settings.project}.web.app`;
}

/**
 * The deploy config for your project, made from the repo's firebase.json: only the app's hosting
 * entry (the hosted service's old address is not yours), your own sign-in hosts in the CSP, and
 * Auth with email and Google sign-in.
 */
export function selfhostFirebaseConfig(repoConfig, s) {
  const app = (repoConfig.hosting ?? []).find((h) => h.target === 'app');
  if (!app) throw new Error('firebase.json has no hosting entry with target "app"');
  const hosting = structuredClone(app);
  delete hosting.target;
  hosting.site = s.siteId ?? s.project;
  const own = [
    ...(s.domain ? [`https://${s.domain}`] : []),
    `https://${s.project}.firebaseapp.com`,
  ].join(' ');
  for (const block of hosting.headers ?? [])
    for (const h of block.headers ?? [])
      if (h.key === 'Content-Security-Policy' && h.value.includes('frame-src'))
        h.value = h.value.replace(/frame-src ([^;]*)/, (_m, list) => {
          const kept = list
            .split(/\s+/)
            .filter((src) => src && !/^https:\/\/(hivenod\.com|hive-board-43be\.)/.test(src));
          // Your own sign-in hosts go right after 'self' and blob:, before Google's accounts page.
          const at = kept.findIndex((src) => src.startsWith('https://'));
          kept.splice(at < 0 ? kept.length : at, 0, own);
          return `frame-src ${kept.join(' ')}`;
        });
  return {
    firestore: { ...repoConfig.firestore },
    hosting,
    auth: {
      providers: {
        emailPassword: true,
        googleSignIn: { oAuthBrandDisplayName: 'Hivenod', supportEmail: s.supportEmail },
      },
    },
  };
}

/** VITE_* variables for the web build, from the web app's config. */
export function viteEnv(firebase) {
  return {
    VITE_FIREBASE_API_KEY: firebase.apiKey,
    VITE_FIREBASE_AUTH_DOMAIN: firebase.authDomain,
    VITE_FIREBASE_PROJECT_ID: firebase.projectId,
    VITE_FIREBASE_APP_ID: firebase.appId ?? '',
    VITE_FIREBASE_MESSAGING_SENDER_ID: firebase.messagingSenderId ?? '',
  };
}

/** The firebase CLI's --json answer: its result, or an Error with its message. */
export function fbResult(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`unexpected answer from the firebase CLI: ${String(text).slice(0, 200)}`);
  }
  if (j?.status === 'error') throw new Error(j.error ?? 'the firebase CLI reported an error');
  return j?.result;
}

/** The commands the firebase CLI runs, by step (also what --dry-run prints). */
export function firebaseArgs(step, s) {
  const p = ['--project', s.project];
  switch (step) {
    case 'projects:list':
      return ['projects:list', '--json'];
    case 'projects:create':
      return ['projects:create', s.project, '--display-name', 'Hivenod', '--json'];
    case 'apps:list':
      return ['apps:list', 'WEB', ...p, '--json'];
    case 'apps:create':
      return ['apps:create', 'WEB', WEB_APP_NAME, ...p, '--json'];
    case 'apps:sdkconfig':
      return ['apps:sdkconfig', 'WEB', s.appId ?? '<app id>', ...p, '--json'];
    case 'databases:list':
      return ['firestore:databases:list', ...p, '--json'];
    case 'databases:create':
      return ['firestore:databases:create', '(default)', '--location', s.location, ...p, '--json'];
    case 'sites:list':
      return ['hosting:sites:list', ...p, '--json'];
    case 'deploy':
      return [
        'deploy',
        '--only',
        'hosting,firestore,auth',
        '--config',
        FIREBASE_CONFIG_FILE,
        ...p,
        '--non-interactive',
      ];
  }
  throw new Error(`unknown step ${step}`);
}

/** The steps in order, as people read them (--dry-run, and the plan shown before asking). */
export function planLines(s, { skipBuild = false } = {}) {
  const fb = (step) => `firebase ${firebaseArgs(step, s).join(' ')}`;
  return [
    `1. Project ${s.project}: look it up (${fb('projects:list')}); if it is missing, create it (${fb('projects:create')}).`,
    `2. Web app "${WEB_APP_NAME}": look it up (${fb('apps:list')}); if there is none, create it (${fb('apps:create')}); read its config (${fb('apps:sdkconfig')}).`,
    `3. Firestore database: look it up (${fb('databases:list')}); if there is none, create it in ${s.location} (${fb('databases:create')}).`,
    `4. Hosting site: read the default site and its address (${fb('sites:list')}).`,
    `5. Write ${SETTINGS_FILE} (your settings) and ${FIREBASE_CONFIG_FILE} (hosting for your site, rules, indexes, Auth with email and Google sign-in${s.domain ? `, sign-in frames from https://${s.domain}` : ''}).`,
    skipBuild
      ? '6. Build: skipped (--skip-build), apps/web/dist is deployed as it is.'
      : '6. Build Hivenod with your web config (pnpm build with VITE_FIREBASE_*), the CLI downloads (Go, when installed) and /version.json; the build publishes /.well-known/hivenod.json.',
    `7. Deploy hosting, Firestore rules and indexes, and the Auth providers (${fb('deploy')}).`,
    `8. Check that the project's Hosting address serves /.well-known/hivenod.json naming ${s.project}.`,
  ];
}

/** What to do next, once the site is up. */
export function nextSteps(site, s) {
  const lines = [
    `Hivenod is live at ${site}`,
    '',
    'Next:',
    `  1. Open ${site}, sign up (email or Google) and create your workspace.`,
    `  2. On each agent machine: install the CLI (curl -fsSL ${site}/install.sh | sh), then`,
    `     hivenod connect --server ${site}`,
    '  3. Optional: push and Telegram notifications, see docs/NOTIFIER.md.',
  ];
  if (s.domain)
    lines.push(
      '',
      `Your domain ${s.domain}: add it in the Firebase console (Hosting > Add custom domain, and`,
      'Authentication > Settings > Authorized domains) if you have not yet.',
    );
  return lines;
}

/**
 * Runs the steps against `io` (the real firebase CLI, build and network in selfhost-init.mjs; fakes
 * in the tests). Returns the final settings. Looks before it creates, so a second run changes
 * nothing that is already there.
 *   io.firebase(args) -> stdout of `firebase <args>` (JSON)
 *   io.say(line), io.confirm(question) -> boolean, io.writeJson(file, obj), io.readRepoConfig()
 *   io.build(env), io.fetchJson(url)
 */
export async function runInit(s, io, { skipBuild = false } = {}) {
  const fb = async (step, extra = {}) =>
    fbResult(await io.firebase(firebaseArgs(step, { ...s, ...extra })));

  // 1. Project
  const projects = (await fb('projects:list')) ?? [];
  if (projects.some((p) => p.projectId === s.project)) io.say(`✓ Project ${s.project} found.`);
  else {
    if (!(await io.confirm(`Project ${s.project} does not exist. Create it now?`)))
      throw new Error('Stopped: the project does not exist.');
    await fb('projects:create');
    io.say(`✓ Project ${s.project} created.`);
  }

  // 2. Web app and its config
  const apps = (await fb('apps:list')) ?? [];
  let app =
    apps.find((a) => a.appId === s.appId) ??
    apps.find((a) => a.displayName === WEB_APP_NAME) ??
    apps[0];
  if (app) io.say(`✓ Web app ${app.displayName ?? app.appId} found.`);
  else {
    app = await fb('apps:create');
    io.say(`✓ Web app ${WEB_APP_NAME} created.`);
  }
  const sdk = (await fb('apps:sdkconfig', { appId: app.appId }))?.sdkConfig;
  if (!sdk?.apiKey || !sdk?.projectId) throw new Error('Could not read the web app config.');
  const firebase = {
    apiKey: sdk.apiKey,
    authDomain: sdk.authDomain ?? `${s.project}.firebaseapp.com`,
    projectId: sdk.projectId,
    appId: sdk.appId ?? app.appId,
    messagingSenderId: sdk.messagingSenderId ?? '',
  };

  // 3. Firestore
  const dbs = (await fb('databases:list')) ?? [];
  const list = Array.isArray(dbs) ? dbs : (dbs.databases ?? []);
  if (list.some((d) => String(d.name ?? d).endsWith('/databases/(default)')))
    io.say('✓ Firestore database found.');
  else {
    await fb('databases:create');
    io.say(`✓ Firestore database created in ${s.location}.`);
  }

  // 4. Hosting site
  const sites = (await fb('sites:list'))?.sites ?? [];
  const def = sites.find((x) => x.type === 'DEFAULT_SITE') ?? sites[0];
  const siteId = def?.name?.split('/').pop() ?? s.project;
  const site = siteUrlFor(s, def?.defaultUrl);
  // The check reads the project's own Hosting address: your domain may not point here yet.
  const hostingUrl = def?.defaultUrl ?? siteUrlFor({ project: s.project });
  io.say(`✓ Hosting site ${siteId} (${site}).`);

  // 5. Config files
  const final = { ...s, appId: app.appId, firebase, site, siteId };
  io.writeJson(SETTINGS_FILE, {
    project: final.project,
    location: final.location,
    supportEmail: final.supportEmail,
    ...(final.domain ? { domain: final.domain } : {}),
    site,
    siteId,
    appId: final.appId,
    firebase,
  });
  io.writeJson(FIREBASE_CONFIG_FILE, selfhostFirebaseConfig(io.readRepoConfig(), final));
  io.say(`✓ Wrote ${SETTINGS_FILE} and ${FIREBASE_CONFIG_FILE}.`);

  // 6. Build
  if (skipBuild) io.say('• Build skipped (--skip-build).');
  else {
    await io.build(viteEnv(firebase), site);
    io.say('✓ Built.');
  }

  // 7. Deploy
  await io.firebase(firebaseArgs('deploy', final), { inherit: true });
  io.say('✓ Deployed hosting, rules, indexes and Auth.');

  // 8. Check
  const found = await io.fetchJson(`${hostingUrl}/.well-known/hivenod.json`);
  if (found?.firebase?.projectId !== final.project)
    throw new Error(
      `${hostingUrl}/.well-known/hivenod.json does not name ${final.project} yet (Hosting can take a minute; run the command again).`,
    );
  io.say(`✓ ${hostingUrl}/.well-known/hivenod.json is live.`);
  return final;
}
