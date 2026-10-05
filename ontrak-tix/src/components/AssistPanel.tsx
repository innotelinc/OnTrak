/**
 * Assist panel (M7): what the assistant proposed, and what the agent thinks of it.
 *
 * Presentational. It renders four suggestions, a pair of buttons that record a decision on
 * each, and — on the classification only — a button that applies it to the ticket. It has
 * no control that sends a reply, reassigns or resolves: those stay the desk's own controls,
 * which re-check every permission server-side. The "use the draft" affordance lives in the
 * reply composer, where the textarea is, so filling it is a client-side edit that the agent
 * still has to send.
 *
 * The decision buttons are opt-in by permission: a reader who cannot update the ticket is
 * shown the panel without the accept/dismiss pair, because recording a decision needs to be
 * able to act, not merely to read. The Apply button is the same: it is shown only where the
 * caller could have edited those three fields by hand, and the server checks again.
 */

import type { AssistResult } from "../lib/assist-rules";
import type { AssistKind } from "../lib/assist-service";

export function AssistPanel({
  ticketId,
  result,
  canDecide,
  decisionAction,
  applyAction,
}: {
  ticketId: string;
  result: AssistResult;
  canDecide: boolean;
  decisionAction?: (formData: FormData) => Promise<void>;
  applyAction?: (formData: FormData) => Promise<void>;
}) {
  const { classification } = result;

  return (
    <section aria-label="Assistant suggestions" className="rounded-xl2 border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="font-display text-sm font-semibold text-ink">Assistant</h2>
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
          {result.source === "model" ? "a language model" : "the desk's own rules"}
        </span>
        <a href={`/inbox/${ticketId}`} className="ml-auto text-xs font-semibold text-ink-faint hover:text-ink">
          Hide
        </a>
      </header>

      {result.note ? (
        <p className="border-b border-line bg-surface-muted px-5 py-2 text-xs text-ink-soft">
          The model was not used: {result.note}. Everything below is the desk&rsquo;s own rules.
        </p>
      ) : null}

      <div className="space-y-4 px-5 py-4">
        <p className="text-xs text-ink-faint">
          Suggestions only. Nothing here has been sent — apply the classification if it is right, accept what is
          useful and carry on.
        </p>

        <Block
          title="Classification"
          ticketId={ticketId}
          kind="CLASSIFICATION"
          source={result.source}
          canDecide={canDecide}
          decisionAction={decisionAction}
          extra={
            canDecide && applyAction ? (
              <ApplyForm ticketId={ticketId} result={result} action={applyAction} />
            ) : null
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <Chip label="Type" value={classification.type} />
            <Chip label="Priority" value={classification.priority} />
            <Chip label="Queue" value={classification.queueName ?? "none suggested"} />
          </div>
          <Reasons reasons={classification.reasons} />
        </Block>

        <Block
          title="Summary"
          ticketId={ticketId}
          kind="SUMMARY"
          source={result.source}
          canDecide={canDecide}
          decisionAction={decisionAction}
        >
          <p className="whitespace-pre-wrap text-sm text-ink-soft">{result.summary}</p>
        </Block>

        <Block
          title="Draft reply"
          ticketId={ticketId}
          kind="DRAFT_REPLY"
          source={result.source}
          canDecide={canDecide}
          decisionAction={decisionAction}
        >
          <pre className="whitespace-pre-wrap rounded-xl2 border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
            {result.draftReply}
          </pre>
          <p className="text-xs text-ink-faint">Use it from the reply box below, then edit before sending.</p>
        </Block>

        {result.similar.length > 0 ? (
          <Block
            title="Similar tickets"
            ticketId={ticketId}
            kind="SIMILAR"
            source={result.source}
            canDecide={canDecide}
            decisionAction={decisionAction}
          >
            <ul className="space-y-1.5">
              {result.similar.map((hit) => (
                <li key={hit.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <a href={`/inbox/${hit.id}`} className="font-mono text-[11px] font-semibold text-brand">
                    {hit.ref}
                  </a>
                  <span className="truncate text-ink-soft">{hit.subject}</span>
                  <span className="text-[11px] text-ink-faint">
                    {Math.round(hit.score * 100)}% shared words{hit.shared.length > 0 ? `: ${hit.shared.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
      </div>
    </section>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
      {label}: <span className="text-ink">{value}</span>
    </span>
  );
}

function Reasons({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-ink-faint">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

/** One suggestion, its prose, and the pair of buttons that record what was done with it. */
function Block({
  title,
  ticketId,
  kind,
  source,
  canDecide,
  decisionAction,
  extra,
  children,
}: {
  title: string;
  ticketId: string;
  kind: AssistKind;
  source: AssistResult["source"];
  canDecide: boolean;
  decisionAction?: (formData: FormData) => Promise<void>;
  /** A control that belongs to this suggestion specifically, beside the decision pair. */
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{title}</h3>
        {canDecide && decisionAction ? (
          <div className="flex items-center gap-1.5">
            <Decision ticketId={ticketId} kind={kind} source={source} accepted action={decisionAction} />
            <Decision ticketId={ticketId} kind={kind} source={source} accepted={false} action={decisionAction} />
          </div>
        ) : null}
        {extra}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * The Apply control, on the classification only.
 *
 * It posts the three fields the panel is showing. Those are the only values it can carry:
 * the service refuses a type or priority outside its closed sets and a queue that is not
 * this desk's, and the ticket service checks `ticket:update` before writing anything.
 */
function ApplyForm({
  ticketId,
  result,
  action,
}: {
  ticketId: string;
  result: AssistResult;
  action: (formData: FormData) => Promise<void>;
}) {
  const { classification } = result;
  return (
    <form action={action} className="ml-auto">
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="type" value={classification.type} />
      <input type="hidden" name="priority" value={classification.priority} />
      <input type="hidden" name="queueId" value={classification.queueId ?? ""} />
      <input type="hidden" name="source" value={result.source} />
      <button
        type="submit"
        className="rounded-full bg-brand/12 px-2 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/20"
      >
        Apply to ticket
      </button>
    </form>
  );
}

function Decision({
  ticketId,
  kind,
  source,
  accepted,
  action,
}: {
  ticketId: string;
  kind: AssistKind;
  source: AssistResult["source"];
  accepted: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="accepted" value={accepted ? "1" : "0"} />
      <button
        type="submit"
        className={
          accepted
            ? "rounded-full bg-brand/12 px-2 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/20"
            : "rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft hover:bg-line"
        }
      >
        {accepted ? "Accept" : "Dismiss"}
      </button>
    </form>
  );
}
