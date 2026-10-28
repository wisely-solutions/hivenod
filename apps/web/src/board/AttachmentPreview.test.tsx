import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Attachment } from '@hive/shared';
import { AttachmentPreview } from './AttachmentPreview';

const base = {
  name: 'Spec.html',
  url: null,
  bytes: 5,
  runId: null,
  by: { type: 'agent', id: 'a' },
  at: { toMillis: () => 0 },
  lastEventId: 'e',
} as unknown as Attachment;

describe('AttachmentPreview', () => {
  it('runs HTML in a sandboxed frame page without same-origin', () => {
    render(<AttachmentPreview attachment={{ ...base, kind: 'html', content: '<h1>Hi</h1>' }} />);
    const frame = screen.getByTitle('Preview of Spec.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('src')).toBe('/viewer-frame.html');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  });

  it('refuses links that are not http(s)', () => {
    render(
      <AttachmentPreview
        attachment={{ ...base, kind: 'link', content: null, url: 'javascript:alert(1)' }}
      />,
    );
    expect(screen.getByText('No preview for this file.')).toBeTruthy();
  });
});
