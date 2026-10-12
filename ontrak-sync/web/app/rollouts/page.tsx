"use client";

/**
 * Rollouts — the containers this deployment has been *given*.
 *
 * The Findings page is the clicked path: a scan says an image is behind and a person
 * decides. This page is the other half, and it is the only one in this product where
 * something moves without anybody watching, so the page is built around one question a
 * reader has to be able to answer in a glance: **what is this deployment allowed to
 * restart, and what happened the last time it did?**
 *
 * Three sections, in that order:
 *
 *  1. **The remit** — the `(host, container, image ref)` triples somebody claimed, with
 *     the hold and the cooldown showing on the row they apply to. Claiming is here rather
 *     than hidden behind a settings page because it is a decision about one container,
 *     and the note field is where the next person finds out who decided it.
 *  2. **What the Network runs** — every docker image the scans have seen on every
 *     configured host, with whether this deployment owns it. This is the whole point of
 *     the section: an empty remit is the shipped posture, and a page that only lists
 *     claims makes "we have not covered that one" look exactly like "there is no such
 *     container". A row here is not an invitation to claim everything — it is the
 *     missing-row half of the same statement.
 *  3. **The rolls** — every attempt, with the state and the daemon's own words. A roll
 *     that had to be undone is a fact somebody needs to see, not a line in a log.
 *
 * THE PAGE DOES NOT HIDE THE KILL SWITCH. `enabled: false` with a full remit is a
 * deployment somebody prepared and did not switch on, and it must not read as a Network
 * that is simply up to date — every decision the timer makes right now is
 * `rollout-disabled`, and the banner says so in the operator's own vocabulary
 * (`ONTRAK_ROLLOUT`), because that is the string they will search for.
 */

import { useMemo, useState } from "react";

import { Empty, LoadError, RollStatePill, StatusPill, When } from "@/components/bits";
import { api } from "@/lib/api";
import { can, useSession } from "@/lib/session";
import type {
  Finding, FindingStatus, Meta, RollDecision, Rollouts, RollPassResult,
} from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/** The claim form's blank state, and the defaults a person gets without editing anything. */
const BLANK = {
  host: "",
  container: "",
  ref: "",
  service: "",
  auto: true,
  note: "",
};

/** One image a scan has seen, folded to the triple a remit is keyed on. */
interface Discovered {
  host: string;
  container: string;
  ref: string;
  /** The newest finding status behind this triple, for the "why is it here" column. */
  status: FindingStatus;
  last_seen: string | null;
}

export default function RolloutsPage() {
  const { identity } = useSession();
  const allowed = can(identity, "sync:view");
  const mayClaim = can(identity, "sync:configure");
  const mayApply = can(identity, "sync:apply");

  const rollouts = useAsync<Rollouts>(() => api.rollouts(100), []);
  // `/api/meta` and not `/api/hosts`: the claim form has to name a *configured* host,
  // because that is the list the roll resolves a remit against (`settings.hosts`), and a
  // scanned-but-now-unconfigured machine would be a remit that is refused as
  // `host-not-configured`. It is also the only one of the two that answers on a deployment
  // nobody has scanned yet — which is exactly when a remit gets written.
  const meta = useAsync<Meta>(() => api.meta(), []);
  // Held at the page level rather than inside the "what the Network runs" table: the claim
  // form is what consumes it, and a table that owned its own copy could not fill it in.
  const docker = useAsync<{ findings: Finding[] }>(
    () => api.findings({ manager: "docker", limit: 5000 }),
    [],
  );

  const [draft, setDraft] = useState(BLANK);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pass, setPass] = useState<RollPassResult | null>(null);

  const targets = rollouts.data?.targets ?? [];
  const rolls = rollouts.data?.rolls ?? [];
  const limits = rollouts.data?.limits;
  // Who fills the remit. `off` is the shipped posture and the page says nothing extra
  // about it; the other two change what an empty remit *means*, so they are stated.
  const adopt = rollouts.data?.adopt ?? "off";
  const optouts = rollouts.data?.optouts ?? [];

  const owned = useMemo(
    () => new Set(targets.map((row) => key(row.host, row.container, row.ref))),
    [targets],
  );
  /**
   * The containers taken out by hand, keyed the same way the remit is.
   *
   * Kept as a map rather than a set because the row has to be able to say *who* and
   * *why*: on a deployment that adopts what the scans find, a release that did not
   * record a reason would be indistinguishable from one nobody meant.
   */
  const keptOut = useMemo(
    () => new Map(optouts.map((row) => [key(row.host, row.container, row.ref), row])),
    [optouts],
  );

  /**
   * The rolls an undo would actually mean something for.
   *
   * Only the newest attempt on a container can be put back — the image that was running
   * *before* it is the one on the host. A roll that a later row has already followed (an
   * undo, or the next night's roll) is history, and offering it a button that would either
   * fail or re-do a no-op is how a page teaches people to distrust its controls. The API
   * refuses those anyway (`undo_roll` checks the state); this keeps the page from asking.
   */
  const undoable = useMemo(() => {
    const ids = new Set<number>();
    const followed = new Set<string>();
    // Newest first, as the API returns them, so anything already seen is *later*.
    for (const roll of rolls) {
      const id = key(roll.host, roll.container, roll.ref);
      if (!followed.has(id) && roll.state === "rolled") ids.add(roll.id);
      followed.add(id);
    }
    return ids;
  }, [rolls]);

  /**
   * Every docker image the Network's scans have seen, one row per triple.
   *
   * A triple rather than one row per finding: a scan writes one finding per behind image
   * per target, so an image that has been behind for a week is a week of rows saying the
   * same thing. The newest is kept, because its status is what a reader is looking at.
   *
   * This is a *report* of what was seen, not of what is running: an image that was pulled
   * and never started has a finding too, which is why the remit rail has `not-running`
   * and why this table cannot be read as an inventory.
   */
  const discovered = useMemo<Discovered[]>(() => {
    const rows = new Map<string, Discovered>();
    for (const row of docker.data?.findings ?? []) {
      // `target` is the incus container Docker runs in, or the host's own name when the
      // daemon is on the host — the same mapping `applier._roll_targets` uses to line a
      // remit up with a scan, and the same reason the claim form asks for both fields.
      const container = row.kind === "host" ? "" : row.target;
      const id = key(row.host, container, row.package);
      const seen = rows.get(id);
      if (!seen || (row.last_seen ?? "") > (seen.last_seen ?? "")) {
        rows.set(id, {
          host: row.host, container, ref: row.package, status: row.status,
          last_seen: row.last_seen,
        });
      }
    }
    return [...rows.values()].sort(
      (a, b) =>
        a.host.localeCompare(b.host) ||
        a.container.localeCompare(b.container) ||
        a.ref.localeCompare(b.ref),
    );
  }, [docker.data]);

  async function act(label: string, action: () => Promise<string | null | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const said = await action();
      rollouts.reload();
      if (typeof said === "string") setNotice(said);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!allowed) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Rollouts</h1>
            <p>The containers this deployment has been given.</p>
          </div>
        </div>
        <div className="note note--warn" role="alert">
          Your role ({identity?.role}) cannot read the remit. Seeing what this deployment is
          allowed to restart is part of reading the Network; ask an administrator.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rollouts</h1>
          <p>
            Containers this deployment has been <em>given</em>, kept on their tag&apos;s
            current image at the end of each scheduled scan — and put back when the new
            image does not come up. The remit below is the entire list this service may
            restart, and a container that is not in it is still scanned and still raises
            findings; {adopt === "off"
              ? "nothing is claimed by default, so that list is the one a person wrote."
              : "on this deployment the scans fill that list themselves."}
          </p>
        </div>
        <div className="actions">
          <button onClick={() => rollouts.reload()}>Refresh</button>
          {mayApply ? (
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() =>
                act("run", async () => {
                  const result = await api.runRollouts();
                  setPass(result);
                  return null;
                })
              }
            >
              {busy === "run" ? "Rolling…" : "Run a pass now"}
            </button>
          ) : null}
        </div>
      </div>

      {rollouts.error ? <LoadError error={rollouts.error} /> : null}
      {rollouts.data && !rollouts.data.enabled ? (
        <div className="note note--warn" role="alert">
          Unattended rolls are switched off for this deployment, so every owned container
          below is left alone however far behind it is. Set <code>ONTRAK_ROLLOUT=1</code> on
          the API and restart it to let the timer roll them.
        </div>
      ) : null}
      {rollouts.data && adopt !== "off" ? (
        <div className={adopt === "unattended" ? "note note--warn" : "note note--ok"}>
          {adopt === "unattended" ? (
            <>
              This deployment <strong>fills its own remit and rolls it</strong>: every
              container a scan finds on a configured host is claimed unattended, and the
              next pass may restart it. A container taken out by hand stays out. Set{" "}
              <code>ONTRAK_ROLLOUT_ADOPT=off</code> to go back to claiming every row by
              hand.
            </>
          ) : (
            <>
              This deployment <strong>fills its own remit</strong>, watching everything
              the scans find and rolling none of it until a row is switched to
              unattended. Set <code>ONTRAK_ROLLOUT_ADOPT=off</code> to claim by hand
              again.
            </>
          )}
        </div>
      ) : null}
      {notice ? <div className="note note--ok">{notice}</div> : null}
      {error ? <div className="note note--bad" role="alert">{error}</div> : null}
      {pass ? <PassReport result={pass} /> : null}

      {mayClaim ? (
        <section className="panel">
          <header>
            <h2>Give a container to this deployment</h2>
            <span className="faint">the blast radius is this list</span>
          </header>
          <div className="body">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act("claim", async () => {
                  await api.claimRollout({
                    host: draft.host.trim(),
                    container: draft.container.trim(),
                    ref: draft.ref.trim(),
                    service: draft.service.trim(),
                    auto: draft.auto,
                    note: draft.note.trim(),
                  });
                  setDraft(BLANK);
                  return `Claimed ${draft.ref.trim()} on ${draft.host.trim()}.`;
                });
              }}
            >
              <div className="row-inline">
                <label className="checkline">
                  <span className="faint">host</span>
                  <select
                    value={draft.host}
                    onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                  >
                    <option value="">choose…</option>
                    {(meta.data?.hosts ?? []).map((host) => (
                      <option key={host.name} value={host.name}>
                        {host.address ? `${host.name} · ${host.address}` : host.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkline">
                  <span className="faint">incus container</span>
                  <input
                    type="text"
                    placeholder="blank = the host's own daemon"
                    value={draft.container}
                    onChange={(event) => setDraft({ ...draft, container: event.target.value })}
                    style={{ width: 230 }}
                  />
                </label>
                <label className="checkline">
                  <span className="faint">image ref</span>
                  <input
                    type="text"
                    placeholder="ghcr.io/innotelinc/monarch/api:1.4"
                    value={draft.ref}
                    onChange={(event) => setDraft({ ...draft, ref: event.target.value })}
                    style={{ width: 300 }}
                  />
                </label>
                <label className="checkline">
                  <span className="faint">service</span>
                  <input
                    type="text"
                    placeholder="api"
                    value={draft.service}
                    onChange={(event) => setDraft({ ...draft, service: event.target.value })}
                    style={{ width: 120 }}
                  />
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={draft.auto}
                    onChange={(event) => setDraft({ ...draft, auto: event.target.checked })}
                  />
                  roll it unattended
                </label>
              </div>
              <div className="row-inline" style={{ marginTop: 10 }}>
                <label className="checkline" style={{ flex: 1 }}>
                  <span className="faint">note</span>
                  <input
                    type="text"
                    placeholder="who gave it up, and why"
                    value={draft.note}
                    onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                    style={{ width: "100%" }}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy !== null || !draft.host.trim() || !draft.ref.trim()}
                >
                  {busy === "claim" ? "Claiming…" : "Claim"}
                </button>
              </div>
              <p className="faint" style={{ marginBottom: 0 }}>
                Leave <em>roll it unattended</em> off to watch a container without ever
                restarting it: findings are still raised and a person still clicks. The claim
                is recorded against your account, and rolling happens inside the policy&apos;s
                window and around its change freeze — {limitsText(limits)}.
              </p>
            </form>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <header>
          <h2>The remit</h2>
          <span className="faint">{targets.length} container(s)</span>
        </header>
        <div className="body body--flush">
          {targets.length === 0 ? (
            <Empty>
              {adopt === "off"
                ? "Nothing has been given to this deployment, so it restarts nothing. " +
                  "Claim a container above, or from the images below."
                : "The remit is empty and this deployment fills it itself, so no pass has " +
                  "run since the last scan. Run one now, or wait for the timer."}
            </Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Image</th>
                    <th>Service</th>
                    <th>Mode</th>
                    <th>Last rolled</th>
                    <th>Eligible again</th>
                    <th>Held</th>
                    <th>Who</th>
                    {mayClaim || mayApply ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {targets.map((row) => (
                    <tr key={key(row.host, row.container, row.ref)}>
                      <td className="tight">
                        {row.host}
                        <div className="faint mono">{row.container || "host daemon"}</div>
                      </td>
                      <td className="mono">{row.ref}</td>
                      <td className="mono dim">{row.service || <span className="faint">—</span>}</td>
                      <td className="tight">
                        {row.auto ? (
                          <span className="pill pill--approved">unattended</span>
                        ) : (
                          <span className="pill pill--absent">watched</span>
                        )}
                      </td>
                      <td className="tight"><When value={row.last_rolled_at} /></td>
                      <td className="tight dim">
                        <Eligible value={row.next_eligible_at} />
                      </td>
                      <td className="dim" style={{ maxWidth: 260 }} title={row.blocked_reason}>
                        {row.blocked_reason
                          ? <span className="pill pill--bad">blocked</span>
                          : <span className="faint">—</span>}
                        {row.blocked_reason ? (
                          <div className="faint" style={{ marginTop: 2 }}>{row.blocked_reason}</div>
                        ) : null}
                      </td>
                      <td className="tight faint" title={row.note}>
                        {row.created_by || "—"}
                        <div className="faint">{row.created_at?.slice(0, 10)}</div>
                      </td>
                      {mayClaim || mayApply ? (
                        <td className="tight">
                          <div className="actions">
                            {row.blocked_reason && mayApply ? (
                              <button
                                disabled={busy !== null}
                                title="Let the next pass try this container again."
                                onClick={() =>
                                  act("clear", async () => {
                                    await api.clearRollout({
                                      host: row.host, container: row.container, ref: row.ref,
                                    });
                                    return `Cleared the hold on ${row.ref} — the next pass may roll it.`;
                                  })
                                }
                              >
                                Clear hold
                              </button>
                            ) : null}
                            {mayClaim ? (
                              <button
                                className="danger"
                                disabled={busy !== null}
                                title="Stop rolling it. Nothing running is changed."
                                onClick={() =>
                                  act("release", async () => {
                                    await api.releaseRollout({
                                      host: row.host, container: row.container, ref: row.ref,
                                    });
                                    return `Released ${row.ref} — it is scanned, left alone, and kept out of the remit${adopt === "off" ? "" : " however the scans find it"}.`;
                                  })
                                }
                              >
                                Release
                              </button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>What the Network runs</h2>
          <span className="faint">
            {discovered.length} image(s) seen{owned.size ? `, ${owned.size} owned` : ""}
          </span>
        </header>
        <div className="body body--flush">
          {docker.error ? <LoadError error={docker.error} /> : null}
          {discovered.length === 0 ? (
            <Empty>
              No docker image has been seen yet. This table is what the scans found — a
              Network that has never been scanned has nothing to show here, and that is not
              the same as a Network with no containers.
            </Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Image</th>
                    <th>Last finding</th>
                    <th>Seen</th>
                    <th>Ownership</th>
                    {mayClaim ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {discovered.map((row) => {
                    const id = key(row.host, row.container, row.ref);
                    const isOwned = owned.has(id);
                    const out = keptOut.get(id);
                    return (
                      <tr key={id}>
                        <td className="tight">
                          {row.host}
                          <div className="faint mono">{row.container || "host daemon"}</div>
                        </td>
                        <td className="mono">{row.ref}</td>
                        <td className="tight"><StatusPill status={row.status} /></td>
                        <td className="tight"><When value={row.last_seen} /></td>
                        <td className="tight">
                          {isOwned ? (
                            <span className="pill pill--ok">in the remit</span>
                          ) : out ? (
                            <span className="pill pill--absent"
                                  title={`kept out by ${out.actor || "an operator"}` +
                                         `${out.created_at ? ` on ${out.created_at.slice(0, 10)}` : ""}` +
                                         `${out.reason ? ` — ${out.reason}` : ""}`}>
                              kept out
                            </span>
                          ) : (
                            <span className="pill pill--absent">not owned</span>
                          )}
                        </td>
                        {mayClaim ? (
                          <td className="tight">
                            {isOwned ? (
                              <span className="faint">—</span>
                            ) : (
                              <button
                                disabled={busy !== null}
                                title={out
                                  ? "Bring it back in: claiming clears the release."
                                  : "Load it into the claim form above, to be confirmed there."}
                                onClick={() => {
                                  setDraft({
                                    host: row.host,
                                    container: row.container,
                                    ref: row.ref,
                                    // The service name is not in the finding — a target
                                    // holds images, not compose services — so it is left
                                    // for whoever claims it to fill in.
                                    service: "",
                                    auto: true,
                                    note: "",
                                  });
                                  setNotice(
                                    out
                                      ? `Loaded ${row.ref} into the claim form — claiming clears the release.`
                                      : `Loaded ${row.ref} into the claim form — check the terms and claim it.`,
                                  );
                                }}
                              >
                                {out ? "Claim back…" : "Claim…"}
                              </button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Rolls</h2>
          <span className="faint">{rolls.length} attempt(s)</span>
        </header>
        <div className="body body--flush">
          {rolls.length === 0 ? (
            <Empty>
              Nothing has been rolled yet. A pass that finds every owned container current,
              outside its window, or unjudged writes no row here — the run log says which.
            </Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>When</th>
                    <th>Container</th>
                    <th>Image</th>
                    <th>From → to</th>
                    <th>State</th>
                    <th>Trigger</th>
                    <th>Took</th>
                    <th>Reason</th>
                    {mayApply ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {rolls.map((roll) => (
                    <tr key={roll.id}>
                      <td className="num">{roll.id}</td>
                      <td className="tight"><When value={roll.started_at} /></td>
                      <td className="tight">
                        {roll.host}
                        <div className="faint mono">{roll.name || roll.container || "—"}</div>
                      </td>
                      <td className="mono">{roll.ref}</td>
                      <td className="mono dim nowrap">
                        {shortId(roll.from_image_id)}
                        {" → "}
                        {shortId(roll.to_image_id)}
                      </td>
                      <td className="tight"><RollStatePill state={roll.state} /></td>
                      <td className="faint">{roll.trigger}{roll.actor ? ` · ${roll.actor}` : ""}</td>
                      <td className="tight faint">{millis(roll.duration_ms)}</td>
                      <td className="dim" style={{ maxWidth: 340 }}>{roll.reason}</td>
                      {mayApply ? (
                        <td className="tight">
                          {undoable.has(roll.id) ? (
                            <button
                              disabled={busy !== null}
                              title="Put the image that was running before back, and hold the container."
                              onClick={() =>
                                act("undo", async () => {
                                  const result = await api.undoRollout(roll.id);
                                  return `Undo of roll #${roll.id}: ${result.detail ?? "done"}${
                                    result.held ? ` — ${roll.ref} is held until you clear it` : ""
                                  }.`;
                                })
                              }
                            >
                              Undo
                            </button>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {optouts.length ? (
        <section className="panel">
          <header>
            <h2>Kept out of the remit</h2>
            <span className="faint">{optouts.length} container(s)</span>
          </header>
          <div className="body body--flush">
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Image</th>
                    <th>Who</th>
                    <th>When</th>
                    <th>Why</th>
                    {mayClaim ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {optouts.map((row) => (
                    <tr key={key(row.host, row.container, row.ref)}>
                      <td className="tight">
                        {row.host}
                        <div className="faint mono">{row.container || "host daemon"}</div>
                      </td>
                      <td className="mono">{row.ref}</td>
                      <td className="tight faint">{row.actor || "—"}</td>
                      <td className="tight faint">{row.created_at?.slice(0, 10) || "—"}</td>
                      <td className="dim" style={{ maxWidth: 320 }}>{row.reason || "—"}</td>
                      {mayClaim ? (
                        <td className="tight">
                          <button
                            disabled={busy !== null}
                            title="Put it back in the remit, as an explicit claim."
                            onClick={() => {
                              setDraft({
                                host: row.host,
                                container: row.container,
                                ref: row.ref,
                                service: "",
                                auto: true,
                                note: "",
                              });
                              setNotice(
                                `Loaded ${row.ref} into the claim form — claiming clears the release.`,
                              );
                            }}
                          >
                            Claim back…
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint" style={{ margin: "10px 14px 0" }}>
              A released container stays out however often the scans find it. Claiming it
              again is the way back in — that is a person overriding an earlier decision,
              not the timer doing it.
            </p>
          </div>
        </section>
      ) : null}

      {limits ? (
        <section className="panel">
          <header>
            <h2>The rails in force</h2>
            <span className="faint">ONTRAK_ROLLOUT_*</span>
          </header>
          <div className="body">
            <div className="row-inline">
              <Chip label="who fills the remit" value={ADOPT_LABEL[adopt]} />
              <Chip label="per pass, Network-wide" value={String(limits.max_per_run)} />
              <Chip label="per pass, per host" value={String(limits.max_per_host)} />
              <Chip label="cooldown" value={`${limits.cooldown_hours}h`} />
              <Chip label="health grace" value={`${limits.health_grace_seconds}s`} />
              <Chip
                label="protected refs"
                value={limits.protected_refs.length ? limits.protected_refs.join(", ") : "none"}
              />
            </div>
            <p className="faint" style={{ marginBottom: 0 }}>
              These bound every pass, whether it was the timer or the button above. A
              container that is not at its tag&apos;s current digest by an answer the registry
              actually gave is never rolled: “we could not ask” is not “up to date”, and it is
              not “roll it” either.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** A runs-style report of one pass, with the decisions a pass that did nothing still made. */
function PassReport({ result }: { result: RollPassResult }) {
  const decisions: RollDecision[] = result.decisions ?? [];
  const left = decisions.filter((entry) => entry.code !== "roll");
  return (
    <div className={`note ${result.rolled_back || result.failed ? "note--warn" : "note--ok"}`}>
      {result.summary}
      {result.messages.length ? <pre className="out">{result.messages.join("\n")}</pre> : null}
      {left.length ? (
        <details>
          <summary className="faint">
            what was left alone, and why ({left.length})
          </summary>
          <pre className="out">
            {left.map((entry) => `${entry.name} · ${entry.code}\n    ${entry.detail}`).join("\n")}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="checkline">
      <span className="faint">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

/**
 * When a cooled-down container becomes eligible again.
 *
 * Not `When`, which is an *age* and reads a future moment as "0s ago": this one is a wait,
 * so it counts down and says the clock time it ends at. A container with nothing on record
 * is eligible now, which is what "never rolled" means.
 */
function Eligible({ value }: { value: string | null }) {
  if (!value) return <span className="faint">now</span>;
  const then = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(then.getTime())) return <span className="faint">{value}</span>;
  const seconds = (then.getTime() - Date.now()) / 1000;
  if (seconds <= 0) return <span>now</span>;
  const clock = then.toISOString().slice(11, 16);
  const hours = Math.floor(seconds / 3600);
  const wait = hours >= 1 ? `${hours}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.ceil(seconds / 60)}m`;
  return (
    <span className="nowrap" title={then.toISOString()}>
      in {wait} <span className="faint">({clock})</span>
    </span>
  );
}

/** The remit's key, as one string — the same triple `rollout_targets` is keyed on. */
function key(host: string, container: string, ref: string): string {
  return `${host}\u0000${container}\u0000${ref}`;
}

/** A digest, short enough for a table cell. Empty ids are said, not drawn as blank. */
function shortId(id: string): string {
  if (!id) return "unknown";
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function millis(value: number | null): string {
  if (value === null || value === undefined) return "running";
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What `ONTRAK_ROLLOUT_ADOPT` is set to, in the operator's own words. */
const ADOPT_LABEL: Record<string, string> = {
  off: "a person claims every row",
  watched: "the scans fill it, watched",
  unattended: "the scans fill it, unattended",
};

/** The one line of the limits that fits under the form. */
function limitsText(limits: Rollouts["limits"] | undefined): string {
  if (!limits) return "at most a few per pass";
  return `${limits.max_per_run} per pass across the Network, ${limits.max_per_host} per host, ` +
    `and ${limits.cooldown_hours}h before the same container is rolled again`;
}

