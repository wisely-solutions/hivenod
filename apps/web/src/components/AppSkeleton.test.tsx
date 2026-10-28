import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSkeleton } from './AppSkeleton';
import { LoadingMark } from './Loading';

const classes = (html: string) =>
  new Set([...html.matchAll(/class="(hv-[a-z]+)/g)].map((m) => m[1]));

describe('app shell skeleton', () => {
  afterEach(() => localStorage.clear());

  it('uses the same pieces as the skeleton painted by index.html', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const { container } = render(<AppSkeleton />);
    const react = classes(container.innerHTML);
    const staticOnes = classes(html.slice(html.indexOf('<div id="hv-boot">')));
    for (const c of react) expect(staticOnes.has(c), c).toBe(true);
    for (const c of staticOnes) expect(react.has(c), c).toBe(true);
  });

  it('shows the shell skeleton for someone who looks signed in, the mark otherwise', () => {
    const plain = render(<LoadingMark />);
    expect(plain.container.querySelector('.hv-sk')).toBeNull();
    plain.unmount();
    localStorage.setItem('hive-auth', '1');
    const hinted = render(<LoadingMark />);
    expect(hinted.container.querySelector('.hv-sk')).not.toBeNull();
  });
});
