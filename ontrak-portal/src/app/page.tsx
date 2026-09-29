import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/SignOutButton";
import { portalConfig, ssoConfigured } from "@/lib/config";
import { emptyStateFor, PRODUCTS, tilesFor, urlFor } from "@/lib/portal-rules";
import { readSession } from "@/lib/session";
import { probeProduct, syncHealth, type Reachability } from "@/lib/sync-client";

/**
 * The dashboard — one sign-in, then the products this person belongs in.
 *
 * THE RULE THIS PAGE EXISTS TO KEEP
 * ---------------------------------
 * A tile is drawn for a product the person's role belongs in, and for nothing
 * else. The products themselves are the authority on what a person may *do*; the
 * portal only decides where to send them. That division is why a role change in
 * Cerulean takes effect immediately everywhere instead of in four places.
 *
 * A tile's status light has three values and the third is not a bug:
 *
 *   up      — the product answered
 *   down    — the product did not
 *   unknown — nothing here could ask
 *
 * `unknown` is drawn in the same grey as "we could not look" on OnTrak Sync's own
 * dashboard, on purpose. A fleet of products that all read green because the
 * prober was broken is the exact failure the family was built to avoid.
 */

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  const config = portalConfig();
  const tiles = tilesFor(session.role, {
    baseDomain: config.baseDomain,
    secure: config.secureLinks,
  });

  // Probe the products this person can see, in parallel, with a short deadline.
  // The health check is unauthenticated and always has been — asking the Network
  // "are you there" must not require a credential the portal would have to hold.
  const statuses = new Map<string, { reachability: Reachability; detail: string }>();
  await Promise.all(
    tiles.map(async (tile) => {
      const entry = PRODUCTS.find((product) => product.key === tile.key);
      if (!entry) return;
      const internal = process.env[`ONTRAK_${entry.key.toUpperCase()}_INTERNAL_URL`];
      statuses.set(tile.key, await probeProduct(
        { key: entry.key, url: tile.url, health: entry.health }, internal));
    }),
  );

  const health = await syncHealth();
  const defaultedRole = session.source === "cerulean" && session.matched_group === null;

  return (
    <>
      <div className="head">
        <div>
          <h1>
            {session.role === "STUDENT" || session.role === "INSTRUCTOR"
              ? "Your training"
              : "Your products"}
          </h1>
          <p>
            Signed in as <strong>{session.name}</strong>. The tiles below are the
            products your role ({session.role}) belongs in.
          </p>
        </div>
        <div className="who">
          <span className="chip chip--role">{session.role}</span>
          <span className="chip" title={`Signed in via ${describeSource(session.source)}`}>
            {describeSource(session.source)}
          </span>
          {session.role === "ADMIN" ? (
            <a className="chip" href="/admin/people" title="Change somebody's role">
              People &amp; roles
            </a>
          ) : null}
          <SignOutButton />
        </div>
      </div>

      {defaultedRole ? (
        <div className="note note--warn" role="status">
          None of your {config.providerName} groups maps to an OnTrak role, so you
          have the default (<strong>{session.role}</strong>). An administrator can add
          you to one of the role groups in {config.providerName}.
        </div>
      ) : null}
      {session.source === "password" ? (
        <div className="note note--warn" role="alert">
          This is the portal&apos;s break-glass account, which exists so that a
          provider outage does not take the portal with it. Sign in through{" "}
          {config.providerName} for a real role.
        </div>
      ) : null}

      {tiles.length === 0 ? (
        <div className="panel">
          <div className="empty">{emptyStateFor(session.role)}</div>
        </div>
      ) : (
        <div className="tiles">
          {tiles.map((tile) => {
            const status = statuses.get(tile.key);
            return (
              <a
                key={tile.key}
                className={`tile tile--${tile.tone}${tile.primary ? " tile--primary" : ""}`}
                href={tile.url}
              >
                <div className="tile__top">
                  <div>
                    <h2>{tile.name}</h2>
                    <p>{tile.tagline}</p>
                  </div>
                  {tile.primary ? <span className="badge">start here</span> : null}
                </div>
                <div className="tile__foot">
                  <StatusLight status={status} />
                  <span className="tile__open">Open →</span>
                </div>
                <span className="tile__url">{tile.url.replace(/^https?:\/\//, "")}</span>
              </a>
            );
          })}
        </div>
      )}

      <section className="panel">
        <header>
          <h2>The family</h2>
          <span className="faint">
            {ssoConfigured(config)
              ? `one sign-in, through ${config.providerName}`
              : "single sign-on is not configured"}
          </span>
        </header>
        <div className="body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Who it is for</th>
                <th>Address</th>
                <th>Your access</th>
              </tr>
            </thead>
            <tbody>
              {PRODUCTS.map((entry) => {
                const allowed = entry.roles.includes(session.role);
                return (
                  <tr key={entry.key}>
                    <td><strong>{entry.name}</strong></td>
                    <td className="dim">{entry.audience}</td>
                    <td className="faint mono" style={{ fontSize: 11.5 }}>
                      {urlFor(entry, config.baseDomain, config.secureLinks).replace(/^https?:\/\//, "")}
                    </td>
                    <td>
                      {allowed
                        ? <span className="status status--up"><span className="status__dot" />included in your role</span>
                        : <span className="status status--unknown"><span className="status__dot" />not for {session.role}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>The Network</h2>
          <span className="faint">
            {health
              ? `scheduler ${health.scheduler ? "running" : "stopped"} · ${health.hosts_configured} machines configured`
              : "OnTrak Sync did not answer"}
          </span>
        </header>
        <div className="body">
          {health ? (
            <p className="dim" style={{ margin: 0 }}>
              OnTrak Sync is answering. What is pending and what could not be read are
              counted on its own dashboard, because a number repeated in a second
              place is a number that will eventually disagree. A machine there is not
              "a container" — physical, virtual, VMware, Proxmox, LXC, QEMU and bare
              metal are all the same kind of entry.
            </p>
          ) : (
            <p className="dim" style={{ margin: 0 }}>
              OnTrak Sync could not be reached from the portal, so the Network&apos;s
              state is unknown from here. {config.providerName} sign-in is unaffected.
            </p>
          )}
        </div>
      </section>

      {session.groups.length > 0 ? (
        <section className="panel">
          <header>
            <h2>Your groups</h2>
            <span className="faint">read-only, from {config.providerName}</span>
          </header>
          <div className="body">
            <p className="dim" style={{ marginTop: 0 }}>
              Group membership is managed in {config.providerName} and is what decides
              your role. Nothing here changes it.
            </p>
            <div className="who">
              {session.groups.map((group) => (
                <span key={group}
                      className={`chip${group === session.matched_group ? " chip--role" : ""}`}>
                  {group}
                  {group === session.matched_group ? <strong> → {session.role}</strong> : null}
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

function describeSource(source: string): string {
  if (source === "cerulean") return "Cerulean sign-in";
  if (source === "sync") return "OnTrak Sync account";
  return "break-glass account";
}

/** The three-state light. A product that was not checked is never green. */
function StatusLight({ status }: { status?: { reachability: Reachability; detail: string } }) {
  if (!status) {
    return (
      <span className="status status--unknown" title="nothing here could ask">
        <span className="status__dot" />not checked
      </span>
    );
  }
  const label = status.reachability === "up"
    ? "answering"
    : status.reachability === "down"
      ? "not answering"
      : "not checked";
  return (
    <span className={`status status--${status.reachability}`} title={status.detail}>
      <span className="status__dot" />{label}
    </span>
  );
}
