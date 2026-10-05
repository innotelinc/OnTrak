# Connectors

The M6 marketplace: **what can talk to this desk, and how a new one is added
without new plumbing.** A connector is a **manifest**; installing one is *data*.

## Why a manifest, not a class

M6 shipped four ways for the outside world to reach the desk — signed webhooks,
Slack/Teams, the RMM monitoring connector and the versioned REST API. Each was
built where it was needed, which is right for the connectors we ship and wrong for
the one after them: another connector meant another bespoke pipeline, and no single
answer to *what can talk to this desk?*.

The marketplace replaces that with one contract. A manifest declares everything the
catalog, the console and the install path must agree on:

| Field | Meaning |
| --- | --- |
| `id` | Stable machine key. Fixed once written — an installation names it forever. |
| `name`, `vendor` | What to call it and who wrote it. |
| `category` | `TELEMETRY` · `NOTIFY` · `MONITORING` · `IDENTITY` · `INTAKE` · `EXPORT`. |
| `summary` | One sentence, printed on the catalog card. |
| `capabilities` | The closed set of things it can be asked to do (see below). |
| `configFields` | The settings it needs, each `required` and/or `secret`. |
| `docsPath` | Where its own page lives. |
| `builtin` | Whether we ship it (and therefore configure it elsewhere). |
| `managePath` | For a built-in, the screen it is configured on. |

## Capabilities are the routing key

`CONNECTOR_CAPABILITIES` is a closed, small set — `alert.ingest`,
`ticket.notify`, `monitoring.check`, `identity.sync`, `email.intake`,
`ticket.export`. An event goes to **the enabled installations whose manifest
declares the capability, resolved every time** — so enabling a connector takes
effect on the next event, with nothing to re-register. "Who hears about a created
ticket?" is a query, not a list somebody maintains.

## First-party vs third-party

The connectors we ship are **catalogued but not installable here**. Each is
configured on its own console (`managePath`), and a row here would be a second
source of truth for the same endpoint. They appear in the catalog so the *directory*
is complete; installing one is refused with a pointer to where it actually lives.

A **third-party** connector is installed from `/admin/connectors` with its config.

## Adding a connector (the seam)

```ts
import { connectorRegistry } from "@/lib/db";

const problems = connectorRegistry.register(
  {
    id: "acme-assets",
    name: "Acme Asset Sync",
    vendor: "Acme",
    category: "EXPORT",
    summary: "Pushes ticket records to Acme's asset register.",
    capabilities: ["ticket.export"],
    configFields: [
      { key: "baseUrl", label: "Base URL", required: true, secret: false },
      { key: "apiKey", label: "API key", required: true, secret: true },
    ],
    docsPath: "docs/connectors.md",
    builtin: false,
    managePath: null,
  },
  async (payload, { tenantId, installation, at }) => {
    // Do the thing. Return an outcome; never throw to the caller.
    return { ok: true, detail: "pushed" };
  },
);
if (problems.length) throw new Error(problems.join(" "));
```

`register` validates the manifest with the *same* rules the built-ins pass, so a
malformed one is refused at the door. A built-in id cannot be shadowed: the
connectors we ship are the product's, and letting a plugin claim `signed-webhooks`
would make the catalog lie about what that id means.

Shipping a connector is therefore a **registration**, not a change to the install
path, the console, or the schema.

## Installing

Installing is `tenant:manage` — the same authority a webhook endpoint or a chat
channel needs, because a connector decides where a customer's ticket subject or a
desk's alert stream goes.

Config is validated **before** it is stored, in both directions:

- a **blank required field** is refused — a connector missing its endpoint fails
  silently at the first event;
- a **key the manifest does not declare** is refused, not dropped — a form that
  quietly discards a setting somebody typed lies about what the connector will do.

An installation is **disabled before it is removed**: disabling keeps the config for
the moment somebody turns it back on; removing is for a connector the desk is done
with. Both are audited, and removal keeps the trail.

## Secrets

A field declared `secret` is masked on screen (`maskConfig`) and **never written to
the audit trail**. `auditConfigSummary` records *which* fields were set and which of
them are secrets, and no value at all — a chain entry is a document that outlives the
deployment, and a credential inside the evidence is a liability, not a record.

Because the console never receives a secret back, an edit that leaves a secret field
blank **keeps** the stored value (`configure`); a secret cannot be cleared by
omission, and a required one cannot be emptied.

## Dispatch

```ts
const report = await connectorServicesFor().dispatch({
  tenantId,
  capability: "ticket.notify",
  payload: { event: "ticket.created", ref: "T-1" },
});
// report.delivered  — an outcome per installation that heard it
// report.unanswered — an installation whose connector has no handler (a bug, reported)
```

A handler that throws is caught and reported as a failed outcome: the thing that
raised the event — a ticket was created — has already happened, and a notification
failing must not undo it.

## Where the pieces live

| Concern | File |
| --- | --- |
| Manifest, catalog, validation, registry | `src/lib/connector-rules.ts` |
| Install lifecycle, dispatch, in-memory store | `src/lib/connector-service.ts` |
| Prisma adapter | `src/lib/connector-store-prisma.ts` |
| Wiring and the process-wide registry | `src/lib/db.ts` (`connectorServicesFor`, `connectorRegistry`) |
| Console | `src/app/(desk)/admin/connectors/page.tsx` |
| Tests | `tests/tix-m6-connectors.test.ts` |

## Honest gaps

- A registered connector's handler runs **in-process**, synchronously with the
  caller; a slow one slows the request that raised the event. A queue behind the
  same seam is the next step, not a rewrite.
- There is no **versioning or signing** of a registered manifest, so a marketplace
  of *untrusted* third-party code is not in scope — a connector is registered by the
  deployment that runs it.
- The catalog is per-process. A multi-process deployment registers the same
  connectors in each; nothing is stored that would let them disagree, because the
  manifests are code.
