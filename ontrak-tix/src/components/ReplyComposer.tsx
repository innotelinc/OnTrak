"use client";

import { useRef, useState } from "react";

import { applyCannedTemplate, type CannedResponse } from "../lib/canned-rules";

/**
 * Reply composer (M1): the reply box, with canned responses as one-click fills.
 *
 * Client-side because filling a template has to write into the textarea the
 * agent is looking at. The values substituted into `{{ref}}` etc. are passed in,
 * never fetched, so the composer stays a pure renderer of its props and the
 * server action still owns every access decision.
 *
 * The M7 assistant's draft is offered the same way a canned response is — one button
 * that fills the box — and with the same guarantee: it *fills*, it never sends. The
 * draft is a string prop, so the composer cannot fetch, and the agent still has to
 * read it, edit it if it is wrong, and press Send.
 */
export function ReplyComposer({
  action,
  ticketId,
  ticketRef,
  requester,
  agent,
  canned,
  suggestedReply,
}: {
  action: (formData: FormData) => Promise<void>;
  ticketId: string;
  ticketRef: string;
  requester: string;
  agent: string;
  canned: CannedResponse[];
  /** The assistant's draft, when one has been asked for (M7). */
  suggestedReply?: string;
}) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const values = { ref: ticketRef, requester, agent };

  function insert(response: CannedResponse) {
    const next = applyCannedTemplate(response.body, values);
    // Replace rather than append: a fill is "start from this template", and an
    // append would silently stack two greetings in one reply.
    setBody(next);
    textareaRef.current?.focus();
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="ticketId" value={ticketId} />
      {suggestedReply ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-ink-faint">Assistant:</span>
          <button
            type="button"
            onClick={() => {
              // Assigned, not substituted: the draft is prose, and a `{{...}}` an agent
              // typed into their own template has no business being rewritten here.
              setBody(suggestedReply);
              textareaRef.current?.focus();
            }}
            className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand hover:bg-brand/20"
          >
            Use suggested reply
          </button>
          <span className="text-xs text-ink-faint">edit before sending</span>
        </div>
      ) : null}
      {canned.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-ink-faint">Canned:</span>
          {canned.map((response) => (
            <button
              key={response.id}
              type="button"
              onClick={() => insert(response)}
              title={response.body}
              className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand hover:bg-brand/20"
            >
              {response.shortcut ? `/${response.shortcut}` : response.title}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        name="body"
        required
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Reply to the requester, or add an internal note"
        className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-ink-soft">
          <input type="radio" name="kind" value="PUBLIC_REPLY" defaultChecked /> Public reply
        </label>
        <label className="text-xs text-ink-soft">
          <input type="radio" name="kind" value="INTERNAL_NOTE" /> Internal note
        </label>
        <button type="submit" className="ml-auto rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
          Send
        </button>
      </div>
    </form>
  );
}
