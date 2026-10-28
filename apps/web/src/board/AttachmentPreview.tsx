import type { Attachment } from '@hive/shared';
import { Markdown } from '../process/markdown';
import { SandboxedHtml } from '../review/SandboxedHtml';

/** Inline preview of one attachment. HTML runs in a sandbox without same-origin access. */
export function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const a = attachment;
  if (a.kind === 'html') {
    return (
      <SandboxedHtml
        title={`Preview of ${a.name}`}
        html={a.content ?? ''}
        className="h-96 w-full rounded-card border border-line bg-white"
      />
    );
  }
  if (a.kind === 'markdown') {
    return (
      <div className="max-h-96 overflow-auto rounded-card border border-line bg-surface p-3.5">
        <Markdown source={a.content ?? ''} />
      </div>
    );
  }
  if (a.kind === 'text') {
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-line bg-surface p-3.5 font-mono text-13">
        {a.content}
      </pre>
    );
  }
  if (a.kind === 'image' && a.content?.startsWith('data:image/')) {
    return (
      <img src={a.content} alt={a.name} className="max-h-96 rounded-card border border-line" />
    );
  }
  if (a.kind === 'pdf' && a.content?.startsWith('data:application/pdf')) {
    return (
      <a
        href={a.content}
        download={a.name}
        className="text-14 font-medium underline underline-offset-4"
      >
        Download {a.name}
      </a>
    );
  }
  if (a.kind === 'link' && a.url && /^https?:\/\//.test(a.url)) {
    return (
      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-14 font-medium underline underline-offset-4"
      >
        {a.url}
      </a>
    );
  }
  return <p className="text-14 text-text-2">No preview for this file.</p>;
}
