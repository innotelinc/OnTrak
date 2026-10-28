# Config as code

A desk's promotable configuration — its queues, SLA policies and their business
calendars, custom fields, and macros — as one JSON file that can be reviewed in a
pull request and applied to another environment.

The milestone's exit is **a staging configuration promotes byte-identically**:
export a tenant, import the file into another tenant, export again, and the two
files are the same bytes. Anything less would make every promotion review a
discussion about key order and whitespace rather than about the configuration.

## The file

```json
{
  "format": "ontrak.tix.config/v1",
  "tenant": "acme",
  "queues": [
    { "slug": "network", "name": "Network" },
    { "slug": "service-desk", "name": "Service desk" }
  ],
  "slaPolicies": [
    {
      "name": "Standard",
      "queue": "service-desk",
      "priority": "HIGH",
      "responseMinutes": 60,
      "resolutionMinutes": 240,
      "warningFraction": 0.2,
      "calendar": {
        "name": "Desk hours",
        "utcOffsetMinutes": -300,
        "week": [[], [{ "startMinute": 540, "endMinute": 1020 }], "…"],
        "holidays": ["2026-01-01", "2026-12-25"]
      }
    }
  ],
  "customFields": [
    {
      "key": "location",
      "label": "Location",
      "type": "SELECT",
      "options": ["HQ", "Branch"],
      "requiredByDefault": true,
      "placeholder": "",
      "helpText": "Where the ticket is.",
      "archived": false
    }
  ],
  "macros": [
    {
      "name": "Triage",
      "description": "Sort it out.",
      "actions": [
        { "kind": "set_priority", "value": "HIGH" },
        { "kind": "add_tag", "value": "triage" }
      ],
      "enabled": true
    }
  ]
}
```

Every section is present even when empty, and `format` pins the shape: a file
from a newer build is refused with one sentence rather than half-read, and an
unknown key inside a known version is refused rather than ignored — a file is
reviewed by a person, and a key this build silently drops is a change nobody
approved.

## Natural keys

A bundle never carries a row id or a timestamp. Those are exactly what differs
between environments, and carrying them would make every promotion a full-file
rewrite whose diff says nothing.

| Section | Key | What a rename means |
| --- | --- | --- |
| tenant | `slug` | — |
| queues | `slug` | the name is free to change; the slug is what policies point at |
| SLA policies | `name` | the row is updated in place |
| custom fields | `key` | the key is immutable, because answers are stored under it |
| macros | `name` | the row is updated in place |

If a bundle names two queues with one slug, two policies with one name (case
insensitively, matching the service), or a policy scoped to a queue the bundle
does not carry, the whole file is refused with every such problem named at once.

## Promoting staging to production

```sh
# On staging: write the file, then commit it for review.
npx tsx scripts/config-code.ts export --tenant acme-staging --out config/acme.json

# On production: see exactly what the file would do, and write nothing.
npx tsx scripts/config-code.ts import --file config/acme.json \
  --tenant acme --dry-run --allow-tenant-slug

# Apply it.
npx tsx scripts/config-code.ts import --file config/acme.json \
  --tenant acme --allow-tenant-slug
```

The dry run and the apply are the same comparison, so the review cannot disagree
with the write. The output lists each new and changed row, with the fields that
differ:

```
acme-staging → acme: 2 queues (1 new, 1 changed, 0 unchanged) · 1 SLA policy (0 new, 1 changed, 0 unchanged) · no custom fields · no macros — 2 changes.
  + queue identity
  ~ queue service-desk (name)
  ~ SLA policy Standard (responseMinutes)
```

`--allow-tenant-slug` is required whenever the file's `tenant` and the target
slug differ, because a promotion between environments is deliberate. Without it
the command stops before the first write and prints both slugs.

Import upserts by natural key and **never deletes**: a queue, policy, field or
macro that exists in the target but not in the file is left exactly as it is.
Removing one is a decision with its own consequences — a queue with open tickets,
a field holding answers — not a side effect of applying a file, so it is not
offered here. A re-import of the same file is a no-op, and only an import that
changed something appends a `config.import` entry to the tenant's audit chain.

The actor on that entry is `ONTRAK_TIX_ACTOR` when set, and `config-code`
otherwise; new custom fields and macros record it as `createdBy`.

## What is deliberately not carried

- **Tickets, users, clients, contacts.** Business data, not configuration. A
  promotion that created people would be a provisioning tool, and one that
  re-pointed their work would be worse.
- **Client-scoped SLA policies.** A client is a contract and a set of people who
  exist in one environment; a policy attached to one is not portable. The export
  counts them and says so on stderr rather than dropping them silently. Because
  policy names are unique per tenant, a bundle whose policy has the same name as
  a client-scoped one is refused — otherwise the import would quietly turn a
  client's promise into the whole desk's.
- **Queue forms (`QueueForm`).** They are a layout over custom-field keys; once a
  desk promotes forms too, the two must move together, so they will come as one
  change rather than two.
- **Automation rules.** Their conditions and `route_queue`/`assign_agent` actions
  name rows by id. Carrying them needs the same natural-key treatment this file
  gives queues, which is a following change, not a silent translation.
- **Ids, timestamps, `createdBy` of existing rows, secrets.** Everything in this
  list is either environment-local or not configuration.

## Where the bytes are guaranteed

`src/lib/config-bundle.ts` canonicalises before it serialises: strings trimmed,
sections sorted by their natural key, a calendar's closures normalised through the
same rules that accept a hand-typed date, fields in a fixed order, two-space
indent, trailing newline. `serializeBundle(buildBundle(state))` is therefore a
function of the configuration alone.

`tests/config-code.test.ts` asserts it as bytes:

- export → read → export is the same string;
- export → apply to an empty environment → export is the same string;
- reversing every array in the source produces the same string;
- a dry run writes nothing; an import writes queues before the policies that
  point at them; a second import changes nothing and appends no second audit
  entry.

The database write itself is exercised over a fake `ConfigCodeDb` in that suite,
by the same convention as the other services' tests: what the write decides is
pure and covered here, and the Prisma client is a thin adapter over the same
upsert shape.
