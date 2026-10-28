/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { discoveryDocument, HOSTED_FIREBASE } from '@hive/shared/discovery';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The site's discovery file (item 07W4gCboOicS0lM1bqwZ): the CLIs read /.well-known/hivenod.json
 * to find this deployment's Firebase config, so an agent needs only the site's address. Hosting
 * skips dot folders, so it is written to /well-known/hivenod.json and firebase.json rewrites the
 * public path to it. Same values as the app's own config (src/lib/app.ts).
 */
function discoveryFile(mode: string): Plugin {
  return {
    name: 'hive-discovery',
    apply: 'build',
    generateBundle() {
      const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
      const emulators =
        env.VITE_USE_EMULATOR === '1'
          ? {
              auth: `127.0.0.1:${env.VITE_AUTH_EMULATOR_PORT ?? 9099}`,
              firestore: `127.0.0.1:${env.VITE_FIRESTORE_EMULATOR_PORT ?? 8080}`,
            }
          : undefined;
      const doc = discoveryDocument(
        {
          apiKey: env.VITE_FIREBASE_API_KEY || HOSTED_FIREBASE.apiKey,
          authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || HOSTED_FIREBASE.authDomain,
          projectId: env.VITE_FIREBASE_PROJECT_ID || HOSTED_FIREBASE.projectId,
          appId: env.VITE_FIREBASE_APP_ID || HOSTED_FIREBASE.appId,
          messagingSenderId:
            env.VITE_FIREBASE_MESSAGING_SENDER_ID || HOSTED_FIREBASE.messagingSenderId,
        },
        { emulators },
      );
      this.emitFile({
        type: 'asset',
        fileName: 'well-known/hivenod.json',
        source: `${JSON.stringify(doc, null, 2)}\n`,
      });
    },
  };
}

/**
 * Starts fetching the signed-in code (Firebase and the first screen) in parallel with the entry
 * script instead of after it (card CGPynEQY). Chunks that dynamic imports reveal only once the
 * entry has run are listed in /preload.js, which adds the modulepreload links when the browser
 * looks signed in. Signed-out visitors and invites fetch nothing extra: the sign-in page stays
 * light. (An external file, not inline: the CSP allows no inline scripts.)
 */
function preloadSignedIn(): Plugin {
  const closure = (bundle: Record<string, { type: string; imports?: string[] }>, file: string) => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      const c = bundle[f];
      if (!c || c.type !== 'chunk' || seen.has(f)) return;
      seen.add(f);
      c.imports?.forEach(walk);
    };
    walk(file);
    return seen;
  };
  return {
    name: 'hive-preload-signed-in',
    apply: 'build',
    enforce: 'post',
    generateBundle(_o, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      const entry = chunks.find((c) => c.isEntry);
      const find = (suffix: string) =>
        chunks.find((c) => c.facadeModuleId?.replace(/\\/g, '/').endsWith(suffix));
      const signedIn = find('/auth/SignedIn.tsx');
      const inbox = find('/inbox/InboxPage.tsx');
      const prewarm = find('/lib/prewarm.ts');
      const landing = find('/landing/LandingPage.tsx');
      if (!entry || !signedIn || !inbox || !prewarm || !landing)
        throw new Error('preload: signed-in chunks not found');
      const skip = closure(bundle, entry.fileName);
      const list = (c: { fileName: string }) =>
        [...closure(bundle, c.fileName)].filter((f) => !skip.has(f)).map((f) => `/${f}`);
      // Signed-out visitors at "/" get the landing page (item g17GWUkfKRFh4mgn0ciQ): fetch its code
      // and styles alongside the entry instead of after it.
      const landingJs = list(landing);
      const landingCss = [
        ...((landing as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata
          ?.importedCss ?? []),
      ].map((f) => `/${f}`);
      // The early listeners (lib/prewarm.ts) count as part of the session start.
      const all = [...new Set([...list(prewarm), ...list(signedIn)])];
      // What the session needs to start (Firebase) is fetched first. The shell and the first
      // screen only render once the first data is in, so they queue until that has arrived and
      // then download while the data requests are in flight, instead of sharing a slow link
      // with it.
      const early = /\/(SignedIn|db|app|tslib\.es6|prewarm|queries)-/;
      const first = all.filter((f) => early.test(f));
      const home = list(inbox).filter((f) => !all.includes(f));
      const rest = all.filter((f) => !early.test(f));
      // Production talks to Google's Auth and Firestore hosts: open those connections (DNS, TLS)
      // while the code downloads, not after it.
      const hosts =
        process.env.VITE_USE_EMULATOR === '1'
          ? []
          : [
              'https://identitytoolkit.googleapis.com',
              'https://securetoken.googleapis.com',
              'https://firestore.googleapis.com',
            ];
      this.emitFile({
        type: 'asset',
        fileName: 'preload.js',
        source:
          `(function(){try{function link(rel,u){var l=document.createElement('link');l.rel=rel;l.href=u;return l;}` +
          `if(localStorage.getItem('hive-auth')!=='1'){if(location.pathname==='/'){` +
          `${JSON.stringify(landingJs)}.forEach(function(u){document.head.appendChild(link('modulepreload',u));});` +
          `${JSON.stringify(landingCss)}.forEach(function(u){var l=link('preload',u);l.as='style';document.head.appendChild(l);});}` +
          `return;}` +
          `var first=${JSON.stringify(first)};` +
          `var rest=${JSON.stringify(rest)};` +
          `if(location.pathname==='/')rest=rest.concat(${JSON.stringify(home)});` +
          `function add(u,cb){var l=link('modulepreload',u);` +
          `if(cb){l.onload=cb;l.onerror=cb;}document.head.appendChild(l);}` +
          `${JSON.stringify(hosts)}.forEach(function(h){var l=link('preconnect',h);` +
          `l.crossOrigin='anonymous';document.head.appendChild(l);});` +
          `var left=first.length;` +
          `function more(){if(--left>0)return;rest.forEach(function(u){add(u);});}` +
          `first.forEach(function(u){add(u,more);});}catch(e){}})();\n`,
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        { tag: 'script', attrs: { src: '/preload.js' }, injectTo: 'head-prepend' as const },
      ],
    },
  };
}
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    discoveryFile(mode),
    tailwindcss(),
    preloadSignedIn(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered by main.tsx once the first screen is up (card CGPynEQY).
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      includeAssets: ['favicon.svg', 'theme-init.js'],
      manifest: {
        name: 'Hivenod',
        short_name: 'Hivenod',
        description: 'Agents do the work. You make the decisions.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // The page itself switches between light and dark with media-queried meta tags.
        theme_color: '#f4f5f7',
        background_color: '#f4f5f7',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app shell: hashed scripts, styles and the icons. index.html is deliberately NOT
        // precached: it carries the Hosting headers (CSP) and the asset hashes, so a returning
        // visitor must always get it from the network. Navigations are NetworkFirst below and
        // fall back to the last good copy only when offline.
        globPatterns: ['**/*.{js,css,svg}', 'icons/*.png'],
        // Web Push handlers (card rN5Q12W2): the generated worker imports them.
        importScripts: ['host-sw.js', 'push-sw.js'],
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Firebase Auth's handler pages (/__/...) are served by Hosting, never by the app.
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' && !url.pathname.startsWith('/__/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-v2',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 10 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
