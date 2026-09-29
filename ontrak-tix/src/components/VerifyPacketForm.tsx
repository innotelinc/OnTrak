"use client";

/**
 * The verifier's form (M3).
 *
 * A third party holds two things: a packet file and a key. This takes both, posts
 * them to `/api/verify/packet`, and shows what came back — the digest, the
 * incident it names, and what is still missing from the record. The failure
 * messages are the server's, verbatim, because the wording of "the signature does
 * not match this deployment's key" is the whole point of the screen.
 */

import { useState } from "react";

interface Report {
  ok: boolean;
  headline: string;
  lines: string[];
  missing: string[];
}

interface Outcome {
  ok: boolean;
  reason: string | null;
  report: Report | null;
}

const inputClass = "mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

export function VerifyPacketForm() {
  const [packet, setPacket] = useState("");
  const [key, setKey] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setPacket(await file.text());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch("/api/verify/packet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packet, key }),
      });
      const body = (await response.json()) as Outcome & { error?: string };
      if (body.error) setError(body.error);
      else setOutcome(body);
    } catch {
      setError("The verifier could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm font-medium text-ink">
        Packet file
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void loadFile(event.target.files?.[0])}
          className={inputClass}
        />
      </label>

      <label className="block text-sm font-medium text-ink">
        …or paste it
        <textarea
          value={packet}
          onChange={(event) => setPacket(event.target.value)}
          rows={8}
          placeholder='{"version":"1.1","incident":{…},"signature":"…"}'
          className={`font-mono text-xs ${inputClass}`}
        />
      </label>

      <label className="block text-sm font-medium text-ink">
        Signing key
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          placeholder="the deployment's ONTRAK_TIX_ASSURANCE_SECRET"
          className={inputClass}
        />
      </label>

      <button type="submit" disabled={busy} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
        {busy ? "Verifying…" : "Verify packet"}
      </button>

      <div aria-live="polite" className="space-y-2">
        {error ? (
          <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {error}
          </p>
        ) : null}

        {outcome ? (
          <div
            className={`space-y-2 rounded-xl2 border px-4 py-3 text-sm ${
              outcome.ok ? "border-ok/40 bg-ok/10 text-ink" : "border-bad/40 bg-bad/10 text-ink"
            }`}
          >
            <p className="font-semibold text-ink">{outcome.report?.headline ?? outcome.reason}</p>
            {outcome.report ? (
              <ul className="space-y-0.5 font-mono text-[11px] text-ink-soft">
                {outcome.report.lines.map((line) => (
                  <li key={line} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
            {outcome.report && outcome.report.missing.length > 0 ? (
              <div className="text-xs text-ink-soft">
                <p className="font-semibold text-ink">Still missing from the record</p>
                <ul className="list-disc pl-4">
                  {outcome.report.missing.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}
