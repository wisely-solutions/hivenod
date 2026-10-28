// Serves dist/ the way Firebase Hosting does for the speed check: gzip-compressed text, the SPA
// fallback to index.html, no-cache headers except for the hashed /assets/ (immutable, as in
// firebase.json, so a preloaded font is reused instead of fetched twice). `vite preview` sends everything uncompressed, which
// would make a throttled-network measurement several times worse than production.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

const root = new URL(`../${process.argv[3] ?? 'dist'}/`, import.meta.url).pathname;
const port = Number(process.argv[2] ?? 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const cache = new Map();

function load(file) {
  let hit = cache.get(file);
  if (!hit) {
    const body = readFileSync(file);
    const ext = extname(file);
    const text = ['.html', '.js', '.css', '.json', '.webmanifest', '.svg'].includes(ext);
    hit = {
      body,
      gz: text ? gzipSync(body, { level: 9 }) : null,
      type: TYPES[ext] ?? 'application/octet-stream',
    };
    cache.set(file, hit);
  }
  return hit;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = join(root, normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  const { body, gz, type } = load(file);
  const useGz = gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  res.writeHead(200, {
    'content-type': type,
    'cache-control': file.startsWith(join(root, 'assets/'))
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    ...(useGz ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } : {}),
  });
  res.end(useGz ? gz : body);
}).listen(port, '127.0.0.1');
