import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cfg = readFileSync(new URL('../apps/web/vite.config.ts', import.meta.url), 'utf8');

describe('service worker config', () => {
  it('never precaches index.html (it carries the Hosting CSP)', () => {
    expect(cfg).toMatch(/globPatterns: \['\*\*\/\*\.\{js,css,svg\}'/);
    expect(cfg).toContain('navigateFallback: null');
  });
  it('serves navigations network-first and takes over immediately', () => {
    expect(cfg).toContain("handler: 'NetworkFirst'");
    expect(cfg).toContain('skipWaiting: true');
    expect(cfg).toContain('clientsClaim: true');
  });
});
