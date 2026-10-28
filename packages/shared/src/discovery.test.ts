import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DiscoveryError,
  discoveryDocument,
  discoveryUrl,
  HOSTED_FIREBASE,
  isHostedSite,
  isLoopbackSite,
  normalizeSite,
  parseDiscovery,
} from './discovery';

// The same cases drive the Go parser (cli/internal/discovery/discovery_test.go).
const cases = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../cli/internal/discovery/testdata/cases.json'),
    'utf8',
  ),
) as {
  sites: { name: string; input: string; want?: string; error?: string }[];
  docs: { name: string; site: string; doc: unknown; want?: unknown; error?: string }[];
};

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(DiscoveryError);
    return (e as DiscoveryError).code;
  }
  return null;
};

describe('normalizeSite (shared cases)', () => {
  for (const c of cases.sites)
    it(c.name, () => {
      if (c.error) expect(codeOf(() => normalizeSite(c.input))).toBe(c.error);
      else expect(normalizeSite(c.input)).toBe(c.want);
    });
});

describe('parseDiscovery (shared cases)', () => {
  for (const c of cases.docs)
    it(c.name, () => {
      if (c.error) expect(codeOf(() => parseDiscovery(c.site, c.doc))).toBe(c.error);
      else expect(parseDiscovery(c.site, c.doc)).toEqual(c.want);
    });
});

describe('discovery helpers', () => {
  it('the document the build writes parses back to the same config', () => {
    const d = parseDiscovery('https://your.host', discoveryDocument(HOSTED_FIREBASE));
    expect(d.firebase).toEqual(HOSTED_FIREBASE);
    expect(d.cli).toBe('https://your.host/cli');
  });
  it('the hosted site is recognised in any spelling', () => {
    expect(isHostedSite('hivenod.com')).toBe(true);
    expect(isHostedSite('https://hivenod.com/')).toBe(true);
    expect(isHostedSite('https://your.host')).toBe(false);
    expect(isHostedSite('http://bad host')).toBe(false);
  });
  it('loopback and discovery url', () => {
    expect(isLoopbackSite('http://localhost:5000')).toBe(true);
    expect(isLoopbackSite('https://your.host')).toBe(false);
    expect(isLoopbackSite('::')).toBe(false);
    expect(discoveryUrl('your.host/')).toBe('https://your.host/.well-known/hivenod.json');
  });
});
