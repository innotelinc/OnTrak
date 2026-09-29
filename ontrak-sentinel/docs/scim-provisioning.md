# Provisioning OnTrak Sentinel from a directory (SCIM 2.0)

Sentinel serves SCIM 2.0 at `<issuer>/scim/v2`, so an organization's roster can be
driven by the directory that already holds it instead of by somebody typing
identities into the console. This is the operator's side of it: how to mint the
credential, what to put in Entra or Okta, and — the part that saves an afternoon —
exactly how much of RFC 7644 is implemented.

For the design and the reasoning, see S2 in [../ROADMAP.md](../ROADMAP.md) and the
`scim-*` modules described in [../README.md](../README.md).

## Before you start

- **The issuer must be the name clients reach, over HTTPS.** It is the prefix on
  every advertised endpoint and on every `meta.location` this surface returns, so
  a connector pointed at a provider advertising `127.0.0.1` will accept the
  configuration and then fail on the first write. Set `SENTINEL_ISSUER` to the
  public name; in a container stack that is
  [../docker-compose.yml](../docker-compose.yml)'s `SENTINEL_ISSUER`, not the
  loopback default.
- **You need an administrator session in the console.** Connector tokens cannot be
  minted over SCIM. A machine-facing API that could widen its own access is one
  with no ceiling, so minting, listing and revoking are all console actions taken
  by a person.
- **The bootstrap administrator should exist already.** The first admin cannot
  arrive over SCIM, because a connector has nothing to authenticate as until one
  does. `npm run serve` creates one; a deployment sets `SENTINEL_ADMIN_EMAIL`.

## 1. Mint a connector token

Open `/console/provisioning` in the console as an administrator and mint a token
with a label that says which directory it belongs to — `entra-production` rather
than `scim`, because the moment there are two, the label is the only thing that
tells them apart.

The token is shown **once**, in the response to the mint, and only its hash is
stored. If it is lost, revoke it and mint another; there is no way to read it
back, which is the point. Two facts about it are worth knowing:

- It is scoped to the organization it was minted in. The token *is* the tenant,
  so a connector cannot reach another organization's people even if it is handed
  an id that belongs to one.
- Revoking it takes effect on the next request. The console's provisioning page
  lists every token with when it was last used, so an unused credential is
  visible rather than merely present.

## 2. Point the connector at the surface

Use the issuer plus `/scim/v2` as the base URL, and the minted token as the
bearer credential:

| Setting | Value |
| --- | --- |
| Tenant / SCIM base URL | `https://id.example.test/scim/v2` |
| Authentication | Bearer token (header token) |
| Token | the `sc1_…` value shown once at mint |

Discovery is readable without a token, which is deliberate — a connector that
authenticates before it can read what the provider supports cannot report a
useful error when the credential is wrong:

```bash
curl -sS https://id.example.test/scim/v2/ServiceProviderConfig | jq
curl -sS https://id.example.test/scim/v2/ResourceTypes | jq
```

Everything else answers `401` with `WWW-Authenticate: Bearer` when the token is
missing or no longer valid.

## 3. Microsoft Entra ID (non-gallery enterprise application)

1. **Entra admin center → Enterprise applications → New application → Create your
   own application.** Name it after this provider, choose "Integrate any other
   application you don't find in the gallery (Non-gallery)", and create it.
2. **Provisioning → Get started → Provisioning Mode: Automatic.**
3. Under **Admin Credentials**, set **Tenant URL** to the base URL above and
   **Secret Token** to the minted token, then **Test Connection**. Entra reports
   the failure it received, so a `401` here means the token; a `400` means the
   URL.
4. **Mappings.** Entra's defaults are close to what this provider serves, with one
   exception worth knowing before you save (see
   [Attribute mapping](#attribute-mapping)): `userName` ← `userPrincipalName`
   matches this provider's `userName` exactly, and Entra maps `mailNickname` to
   `externalId`, which is what makes a second sync update the identity it already
   created rather than making a twin. Keep that mapping.
5. **Settings.** Set the scope to the groups that should be provisioned rather
   than "all users" — this provider has no way to tell a test push from a real
   one, and a first sync against all users is a real sync.
6. Enable provisioning. The first cycle can take up to 40 minutes.

## 4. Okta

1. **Admin Console → Applications → Create App Integration → SCIM 2.0 Test App
   (Header Auth).** The "Header Auth" variant is the right one: this provider
   authenticates with a bearer token, not Basic auth or OAuth.
2. On the **Provisioning** tab, choose **Configure API Integration**, tick
   **Enable API Integration**, and enter the base URL and the minted token.
3. **Test API Credentials**, then **Save**. Okta then offers **To App** settings —
   enable **Create Users**, **Update User Attributes** and **Deactivate Users**.
4. If you want group memberships pushed, map them under **Push Groups**.

Okta's own requirements list is a useful checklist for what a connector will
insist on, and this surface meets the parts that matter: it supports `eq` on
`GET /Users?filter=userName eq "…"`, the boolean `active` soft-deactivation Okta
uses instead of `DELETE`, and `startIndex`/`count` pagination. Okta does not use
`/ServiceProviderConfig`, `POST` search, `/Bulk`, `/Me` or `meta.lastModified`
filtering, so the gaps listed below do not affect it.

## Attribute mapping

This provider serves an allowlist of attributes rather than an echo of whatever a
connector sends. What it returns for a user is:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "…",
  "externalId": "…",
  "userName": "ada@acme.test",
  "name": { "formatted": "Ada Lovelace" },
  "displayName": "Ada Lovelace",
  "active": true,
  "roles": [{ "value": "ADMIN", "primary": true }],
  "meta": { "resourceType": "User", "created": "…", "lastModified": "…", "location": "…" }
}
```

**`name` carries only `formatted`.** Okta's default profile mapping references
`name.givenName` and `name.familyName`, which this provider does not emit, and
Entra's default mapping includes them too. Either adjust the mapping to use
`displayName` — which is derived from the identity's full name and is what the
console shows — or leave the sub-attributes unmapped; a connector that is told to
push a value the provider does not accept reports it as an attribute error rather
than silently dropping it. There is no `emails` array: the address *is*
`userName`, and duplicating it would create two sources for one fact.

Group resources return `displayName` and a `members` array of
`{ value, display, type: "User" }`, which is enough for a connector to read
membership back.

## What the surface supports, exactly

| Endpoint | Methods |
| --- | --- |
| `/scim/v2/Users` | `GET` (list, filtered, paged), `POST` |
| `/scim/v2/Users/{id}` | `GET`, `PUT` (replace), `PATCH`, `DELETE` |
| `/scim/v2/Groups` | `GET`, `POST` |
| `/scim/v2/Groups/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/scim/v2/ServiceProviderConfig` | `GET` (no token) |
| `/scim/v2/ResourceTypes` | `GET` (no token) |
| `/scim/v2/Schemas` | `GET` (no token) |

**Filters are narrower than RFC 7644, on purpose.** The only accepted form is
`attribute eq "value"` on one of `userName`, `externalId`, `displayName` or `id`.
Anything else — `and`, `or`, parentheses, `co`, `sw`, `pr`, a second attribute —
is refused with `400 invalidFilter` rather than answered. That is a deliberate
choice: honouring just the first clause of an `and` would answer a narrower
question than was asked while looking like a success, and a connector acting on
that answer is how duplicates get created. Every filter a connector actually needs
for matching is a single `eq`, including the one Okta documents.

**Pagination** takes 1-based `startIndex` (default 1) and `count` (default 100,
maximum 200). `count=0` returns the totals alone, which is how a connector asks
"how many are there" without pulling the list. Responses carry
`totalResults`, `itemsPerPage` and `startIndex`.

**Sorting is not implemented.** `sortBy`/`sortOrder` are not honoured, and a
connector that depends on ordering should sort on its own side. Nothing in the
Entra or Okta flows above requires it.

## Lifecycle: what deactivation actually does

This is the part worth reading twice, because it is where this provider is
stricter than the letter of the spec and where a departure is either handled or
quietly not.

Setting `active` to `false` — by `PATCH`, by `PUT`, or by `DELETE`, which is a
soft delete — does **all** of the following before the row is written:

1. ends every session the identity holds, and
2. revokes the access tokens those sessions minted, then
3. marks the identity inactive.

Step 2 is the one nobody expects. Ending a session alone leaves a token the client
already holds working until it expires, and an offboarded person who can still call
the API is not offboarded.

`DELETE` returns `204` and does **not** remove the row: the identity is
deactivated and kept, so the audit chain stays intact and a connector that
re-creates the same user name later gets the same identity back, switched on
again, with its history rather than a duplicate.

Two refusals to expect, both deliberate:

- **The last administrator cannot be deprovisioned.** A directory that removes the
  final admin leaves a tenant nobody can administer, so the request fails and says
  so. Provision a second admin first, or use the console.
- **Only `HUMAN` identities are SCIM users.** Service identities are not part of a
  directory's roster, and putting them on this surface would let a sync delete the
  thing the CLI authenticates as.

`externalId` is what makes a second push an update rather than a duplicate. Set it
to the directory's own immutable identifier — Entra's `mailNickname`, Okta's
`externalId` — and not to an email address, which changes.

## Verifying by hand

With a token in `$TOKEN` and the base URL in `$BASE`:

```bash
# Read what the provider supports, unauthenticated.
curl -sS "$BASE/ServiceProviderConfig" | jq '.patch, .filter'

# Is this person here yet? The query every connector matches with.
curl -sS -H "Authorization: Bearer $TOKEN" \
  --get --data-urlencode 'filter=userName eq "ada@acme.test"' "$BASE/Users" | jq '.totalResults, .Resources[0].id'

# Create, then read back the id the Location header named.
curl -sS -i -X POST "$BASE/Users" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/scim+json' \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
       "userName":"ada@acme.test","externalId":"entra-9f21","displayName":"Ada Lovelace","active":true}'

# A departure. The response is 204 and the identity is still here, inactive.
curl -sS -i -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/Users/<id>"
```

A filter the provider refuses says which attributes it does accept, so a
misconfigured connector reports the reason rather than an empty list:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  --get --data-urlencode 'filter=userName co "ada"' "$BASE/Users" | jq '.detail'
```

## What is deliberately absent

- **No directory sync.** This is a SCIM *server*: the connector in Entra or Okta
  drives it. Sentinel never reaches out to Active Directory, Entra or Google.
- **No password, and no `password` in a push.** Sentinel federates; it does not
  hold a directory's credentials, and a password arriving over SCIM is ignored
  rather than stored.
- **No `/Bulk`, no `POST` search, no `/Me`.** None of them is used by the Entra or
  Okta flows above.
- **No sorting** (see above).
- **No token minting over SCIM** (see step 1).
- **No partial-attribute `attributes`/`excludedAttributes` projection.** Responses
  are the allowlist documented above, always.
