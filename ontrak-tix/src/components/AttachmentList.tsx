/**
 * Attachment list (M1): the files on a ticket, plus an upload form.
 *
 * Presentational. The server action re-derives the actor and re-validates every
 * file, so this component hiding or showing a form is convenience, not access
 * control.
 */

import { formatBytes, type AttachmentRecord } from "../lib/attachment-rules";

export function AttachmentList({
  attachments,
  ticketId,
  action,
}: {
  attachments: AttachmentRecord[];
  ticketId: string;
  action?: (formData: FormData) => Promise<void>;
}) {
  return (
    <section aria-label="Attachments" className="rounded-xl2 border border-line bg-surface p-5">
      <h2 className="font-display text-sm font-semibold text-ink">Attachments</h2>

      {attachments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">No files attached.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-2 py-2">
              <span className="truncate text-sm text-ink">{attachment.filename}</span>
              <span className="ml-auto shrink-0 text-xs text-ink-faint">{formatBytes(attachment.byteSize)}</span>
              <time className="shrink-0 text-[11px] text-ink-faint" dateTime={attachment.createdAt}>
                {attachment.createdAt.slice(0, 10)}
              </time>
            </li>
          ))}
        </ul>
      )}

      {action ? (
        <form action={action} className="mt-4 space-y-2 border-t border-line pt-4">
          <input type="hidden" name="ticketId" value={ticketId} />
          <label className="block text-xs text-ink-soft">
            Add files
            <input
              type="file"
              name="attachments"
              multiple
              className="mt-1 block w-full text-xs text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink-soft"
            />
          </label>
          <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
            Upload
          </button>
        </form>
      ) : null}
    </section>
  );
}
