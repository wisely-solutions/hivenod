/**
 * Hivenod notifier: the sender behind "reach me outside the app" (card rN5Q12W2). One small process,
 * run on any machine that stays on (the Hive VM). It needs no paid service: Web Push is free, the
 * Telegram bot is free, Firestore stays on the Spark plan.
 *
 *   notifier init     create the Web Push (VAPID) keys once and save them to the secrets file
 *   notifier          run (default)
 *
 * Secrets are read from files, never from code: see docs/NOTIFIER.md.
 */
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from './engine';
import { appendEnv, notifyEnvPath, readEnvFile, secretsDir } from './env';
import { makePushSender, newVapidKeys } from './push';
import { firestorePorts, watchAll } from './store';
import { TelegramApi, TelegramBot } from './telegram';
import { notifyPath } from '@hive/shared';

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

function init() {
  const path = notifyEnvPath();
  const env = readEnvFile(path);
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    log(`VAPID keys already in ${path}; nothing to do.`);
    return;
  }
  const k = newVapidKeys();
  appendEnv(path, {
    VAPID_PUBLIC_KEY: k.publicKey,
    VAPID_PRIVATE_KEY: k.privateKey,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com', // edit: your contact
  });
  log(`Wrote new VAPID keys to ${path} (mode 600). The private key is not printed.`);
}

async function run() {
  const env = { ...readEnvFile(join(secretsDir(), 'gcp.env')), ...readEnvFile(notifyEnvPath()) };
  const get = (k: string) => process.env[k] ?? env[k];
  const cred = get('GOOGLE_APPLICATION_CREDENTIALS');
  if (cred && !process.env.GOOGLE_APPLICATION_CREDENTIALS)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = cred;
  if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error(
      'No Google credentials: set GOOGLE_APPLICATION_CREDENTIALS (see docs/NOTIFIER.md)',
    );
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    !existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  )
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS points at a missing file');

  const projectId = get('GCLOUD_PROJECT') ?? 'hive-board-43be';
  initializeApp(
    process.env.FIRESTORE_EMULATOR_HOST
      ? { projectId }
      : { projectId, credential: applicationDefault() },
  );
  const db = getFirestore();
  const appUrl = (get('APP_URL') ?? 'https://hivenod.com').replace(/\/$/, '');

  const pub = get('VAPID_PUBLIC_KEY');
  const priv = get('VAPID_PRIVATE_KEY');
  const tgToken = get('TELEGRAM_BOT_TOKEN');
  if (!pub || !priv) log('No VAPID keys: push is off. Run "notifier init".');
  if (!tgToken) log('No TELEGRAM_BOT_TOKEN: Telegram is off.');

  const sendPush =
    pub && priv
      ? makePushSender({
          publicKey: pub,
          privateKey: priv,
          subject: get('VAPID_SUBJECT') ?? 'mailto:privacy@hivenod.com',
        })
      : async () => ({ result: 'error' as const, detail: 'no VAPID keys', attempts: 0 });

  let bot: TelegramBot | null = null;
  let botName: string | null = null;
  if (tgToken) {
    bot = new TelegramBot(new TelegramApi(tgToken), db, appUrl, () => Date.now(), log);
    botName = await bot.botName();
  }
  // Public settings only: the app shows the Connect buttons when these exist.
  await db.doc(notifyPath.config).set({ vapidPublicKey: pub ?? null, telegramBot: botName });

  const ports = firestorePorts(db, {
    sendPush,
    sendTelegram: async (chatId, notice, action) =>
      bot ? bot.send(chatId, notice, action) : false,
    log,
  });
  const engine = new Engine(ports);

  let running = false;
  let again = false;
  const sweep = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await engine.sweep();
    } catch (e) {
      log(`sweep: ${String(e)}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        void sweep();
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void sweep(), 2000);
  };
  const stopWatch = watchAll(db, engine, kick, log);
  const every = setInterval(() => void sweep(), 60_000);
  void bot?.poll();
  log(
    `Notifier running (push ${pub ? 'on' : 'off'}, telegram ${botName ? `@${botName}` : 'off'}).`,
  );

  const stop = () => {
    clearInterval(every);
    bot?.stop();
    stopWatch();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[2] === 'init') init();
else
  run().catch((e) => {
    log(`fatal: ${String(e)}`);
    process.exit(1);
  });
