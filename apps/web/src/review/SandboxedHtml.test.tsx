import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SandboxedHtml, FRAME_URL } from './SandboxedHtml';

describe('SandboxedHtml', () => {
  it('uses a sandboxed frame page without same-origin and hands over the document on ready', () => {
    const { container } = render(<SandboxedHtml html="<p>x</p>" title="Doc" />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(FRAME_URL);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post } });
    // A message from anyone else is ignored; from the frame it sends the document.
    window.dispatchEvent(new MessageEvent('message', { data: { hive: 'ready' }, source: window }));
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { hive: 'ready' },
        source: frame.contentWindow as unknown as MessageEventSource,
      }),
    );
    expect(post).toHaveBeenCalledWith({ hive: 'doc', html: '<p>x</p>', title: 'Doc' }, '*');
  });
});
