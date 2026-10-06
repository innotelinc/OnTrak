# Registering the training app in Moodle — an operator's runbook

This is the **Moodle administrator's** half of
[docs/integrations.md](integrations.md#launching-a-scenario-from-an-lms). That
document is the tool's own contract — the routes, the claims, the score body.
This one is the walkthrough for the person with *Site administration* rights and a
shell on the deployment, going from "we have Moodle" to "a learner clicks
**Fix a broken NIC** in their course and the grade appears in the gradebook".

Moodle 3.10 and later implement LTI 1.3 (LTI Advantage) in the core **External
tool** module, so there is no plugin to install. This runbook is written against
Moodle 4.x, where the labels below come from.

Keep two tabs open: Moodle's **Manage tools** page and the deployment. The
exchange goes both ways and is easy to do in the wrong order — see the next
section.

## The two directions, and why the keypair goes one way

A launch and a grade passback are secured in opposite directions:

```
launch     Moodle ──  /api/lti/login  ─▶  the app   (Moodle signs, the app verifies
           Moodle ──  /api/lti/launch ─▶            against Moodle's own JWKS)

passback   the app ──  Moodle's /mod/lti/token.php ─▶  Moodle   (the app signs, Moodle
           the app ──  the line item's /scores     ─▶           verifies against the
                                                                 tool's public key)
```

The first direction needs **Moodle's** public key here — that is
`ONTRAK_LTI_JWKS_URI`. The second needs **this tool's** public key in Moodle —
that is the PEM you paste in step 2. A registration that does only the first is a
launch that works and a grade that never leaves. `make lti-key` produces the pair
once and both halves are registered together, under one key id.

## Before you start

* **Moodle 3.10+**, with site-administrator access. Check *Site administration →
  Plugins → Activity modules → External tool* exists.
* The deployment's public address, `ONTRAK_TRAINING_BASE_URL` — the family's
  training host is `https://its.ontrak.innotel.us` (see
  [docs/family-operations.md](family-operations.md)).
* A shell on the deployment, to run `make lti-key` and edit `.env`.
* A course you can add an activity to, with a learner account to test with.

## Step 1 — mint the tool's keypair, once

In the checkout on the deployment:

```bash
cd /usr/src/ontrak
make lti-key
```

It writes nothing to disk and prints everything you need. Two parts matter here:

* the **two `.env` lines** (`ONTRAK_LTI_KEY_ID` and the escaped one-line
  `ONTRAK_LTI_PRIVATE_KEY`), which go in the deployment in step 3;
* the **public key in PEM form** (`-----BEGIN PUBLIC KEY----- …`), which goes
  into Moodle in step 2.

Most platforms take a JWKS instead; Moodle has a field for each
(`Public key type`), and this app ships no JWKS URL, so use the PEM. If the
keypair already exists and only the public half needs reprinting:

```bash
make lti-key ARGS="--from-env --pem"     # the PEM for Moodle
make lti-key ARGS=--from-env             # the JWKS, for other platforms
```

Do not mint a second keypair for the same registration — two halves under one
`kid` are a signature Moodle cannot verify, and the failure looks exactly like a
wrong key.

## Step 2 — register the tool in Moodle

*Site administration → Plugins → Activity modules → External tool → Manage tools*,
then **configure a tool manually**. Fill in:

| Moodle field | What to put there |
| --- | --- |
| **Tool name** | `OnTrak IT Support Training` (any label your learners will recognise) |
| **Tool URL** | `https://its.ontrak.innotel.us/api/lti/launch` |
| **LTI version** | **LTI 1.3** |
| **Public key type** | **RSA key** — *not* Keyset URL; this app does not host a JWKS URL |
| **Public key** | the `-----BEGIN PUBLIC KEY----- …` block from step 1 |
| **Initiate login URL** | `https://its.ontrak.innotel.us/api/lti/login` |
| **Redirection URI(s)** | `https://its.ontrak.innotel.us/api/lti/launch` |
| **Default launch container** | **New window** |
| **Tool configuration usage** | *Show as preconfigured tool when adding an external tool* |

Under **Services**, the defaults matter:

* **IMS LTI Assignment and Grade Services** → *Use this service for grade sync
  and column management*. Without this the launch carries no AGS line item and the
  score stays here, by design.
* **IMS LTI Names and Role Provisioning** → *Use this service to retrieve
  members' information as per privacy settings*. Optional here — the app reads the
  person from the launch, not from a roster call — but harmless.

Under **Privacy**, *Share the launcher's name with the tool*, *Share the
launcher's email with the tool* and *Accept grades from the tool* should all be on.
The app refuses a launch that carries no email (it would otherwise have to invent
an address nobody could look up), so the email is not optional.

Save, then find the tool in the list and click **View configuration details**.

## Step 3 — copy Moodle's identifiers back into the deployment

The configuration-details panel shows Moodle's side of the exchange. Each field
maps to one environment variable:

| Moodle's configuration details | Deployment `.env` |
| --- | --- |
| **Platform ID** | `ONTRAK_LTI_ISSUER` |
| **Client ID** | `ONTRAK_LTI_CLIENT_ID` |
| **Deployment ID** | `ONTRAK_LTI_DEPLOYMENT_IDS` (comma-separate several) |
| **Authentication request URL** | `ONTRAK_LTI_AUTHORIZATION_ENDPOINT` |
| **Public keyset URL** | `ONTRAK_LTI_JWKS_URI` |
| **Access token URL** | `ONTRAK_LTI_TOKEN_ENDPOINT` |
| *(from step 1)* | `ONTRAK_LTI_KEY_ID`, `ONTRAK_LTI_PRIVATE_KEY` |
| *(optional)* | `ONTRAK_LTI_DEFAULT_ROLE` — `STUDENT` unless a role this site does not recognise should land differently |

A full block, with this site's Moodle as `<your-moodle>`:

```dotenv
ONTRAK_LTI_ISSUER="https://<your-moodle>"
ONTRAK_LTI_CLIENT_ID="a1b2c3d4"
ONTRAK_LTI_DEPLOYMENT_IDS="3"
ONTRAK_LTI_AUTHORIZATION_ENDPOINT="https://<your-moodle>/mod/lti/auth.php"
ONTRAK_LTI_JWKS_URI="https://<your-moodle>/mod/lti/certs.php"
ONTRAK_LTI_TOKEN_ENDPOINT="https://<your-moodle>/mod/lti/token.php"
ONTRAK_LTI_KEY_ID="ontrak-training-1"
ONTRAK_LTI_PRIVATE_KEY="<the escaped one-line PEM printed by make lti-key>"
```

Then recreate the app so it reads the new environment:

```bash
cd /usr/src/ontrak
docker compose up -d --force-recreate app
```

**Read the boot log.** If the block is half-wired — an endpoint missing, a key
with no id, a token endpoint with nothing to sign with — the app prints one
warning at startup naming the variables at fault:

```
[lti] This deployment has a learning platform configured, but it cannot be used,
so /api/lti/* answers 503: ONTRAK_LTI_JWKS_URI must be an absolute http(s) URL.
```

A registration that is correct, or absent altogether, prints nothing. If you see
that line, fix what it names before going further: with LTI 503ing, the only
person who would otherwise find out is a learner who clicked a link.

## Step 4 — prove the handshake before you involve a learner

Two probes, from anywhere that can reach the deployment:

```bash
BASE=https://its.ontrak.innotel.us

# A login naming a platform this deployment did not register is refused:
curl -s -o /dev/null -w '%{http_code}\n' \
  "$BASE/api/lti/login?iss=https://somewhere-else.example.edu&login_hint=1"
# 400

# A login naming the platform in .env is a redirect to Moodle's auth endpoint:
curl -s -o /dev/null -w '%{http_code}\n' \
  "$BASE/api/lti/login?iss=https://moodle.example.edu&login_hint=42&deployment_id=3"
# 303
```

Then in Moodle: turn editing on in the test course, **Add an activity or
resource → External tool**, pick the preconfigured tool, give it a **Maximum
grade** (without one there is no line item to write a score to), and save. Launch
it as a learner. A launch that lands the person on `/student` is a working
handshake; the same tool's activity appearing in their course is the whole
integration.

## Step 5 — the role mapping

Moodle sends LIS roles; the app maps them to its own three:

| Moodle's LIS role | Role here |
| --- | --- |
| `Administrator`, `SysAdmin` | `ADMIN` |
| `Instructor`, `ContentDeveloper`, `TeachingAssistant`, `Faculty`, `Staff`, `Mentor` | `INSTRUCTOR` |
| `Learner`, `Member`, `Student`, `User`, `None` | `STUDENT` |
| anything else | `ONTRAK_LTI_DEFAULT_ROLE` (`STUDENT` unless set) |

Two rules worth knowing. **A person who is also an instructor is an instructor** —
the more capable role wins, because it is the one the platform actually granted.
And **an unrecognised role is the default, not a refusal**: Moodle adds role
values over time, and a product that refused a launch on somebody else's release
would be broken by it.

Moodle decides the role from the **enrolment** the person launched with — a
teacher enrolled as *Teacher* launches as `Instructor`, a student as *Learner*.
So the role here follows the course, not the site.

## Step 6 — the account, and the custom claims

The launch finds or creates an account by the platform subject, namespaced
`lti:<issuer>#<sub>`; on a first launch it matches by email. A launch-created
account has **no local password**, exactly like one provisioned by a directory or
a roster: Moodle says who the person is, not what their secret is.

Moodle can pass two optional custom parameters on the activity, which the app
reads from the launch:

| Custom parameter | Effect |
| --- | --- |
| `ontrak_assignment` | names the assignment (a scenario) the activity opens |
| `ontrak_cohort` | names the cohort the attempt is recorded against |

Set them on the activity's **Custom parameters** field (`ontrak_assignment=fix-a-broken-nic`)
when one Moodle activity should map to a specific scenario or class. Left blank,
the launch opens the learner's own home, which is the right default for a course
that lets them choose.

## Step 7 — the grade goes back

When the learner's attempt is graded, the score is written to the line item the
launch named, using a `client_credentials` token the app signs with the key from
step 1. This happens only when all three hold:

1. the activity has a **Maximum grade** (so Moodle put a line item in the launch),
2. **Assignment and Grade Services** is set to grade sync in the tool (step 2), so
   the launch carried the score scope, and
3. `ONTRAK_LTI_TOKEN_ENDPOINT` and `ONTRAK_LTI_PRIVATE_KEY` are both set.

A passback that cannot happen **never fails a grading** — the score here is real
whether or not Moodle took a copy. The app records *which* of the three reasons
applies, so a missing grade is a fact you can look up rather than a mystery.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `503` from `/api/lti/login`, and the boot log names `ONTRAK_LTI_*` | The registration is half-wired. The startup warning names the variable. |
| `400` "That platform is not the one this deployment registered with" | `ONTRAK_LTI_ISSUER` does not match Moodle's **Platform ID** (a trailing slash is ignored; anything else is not). |
| `400` "Deployment … is not registered here" | `ONTRAK_LTI_DEPLOYMENT_IDS` does not include the **Deployment ID** from Moodle's configuration details. |
| `400` "…did not match the request this deployment started" | The `state`/`nonce` cookie did not survive the round trip — usually the browser blocking a cross-site cookie, or a proxy stripping `Set-Cookie`. A launch begins in Moodle's frame, so the cookie is `SameSite=None` and needs HTTPS. |
| Launch works, no grade in the gradebook | Assignment and Grade Services is off, the activity has no **Maximum grade**, or the token endpoint/key is missing. Check the app's audit and log for the passback reason. |
| A second account appeared | The first launch matched by email; Moodle's `email` for that person differs from the address the account was created with. Match them, or provision by directory so the identity is stable. |
| "Invalid client" from Moodle's token endpoint | The public key in Moodle does not match `ONTRAK_LTI_PRIVATE_KEY`, or the `kid` differs. Re-register the public half with `make lti-key ARGS="--from-env --pem"`. |

## Rotating the key

Both halves move together, and the order matters:

1. `make lti-key` (a new keypair, a new **or the same** `kid`).
2. Register the new **PEM** in Moodle's tool configuration and **save first** —
   Moodle will briefly hold a key for a deployment that has not switched yet,
   which only affects passbacks, not launches.
3. Update `ONTRAK_LTI_KEY_ID` and `ONTRAK_LTI_PRIVATE_KEY` in `.env` and
   `docker compose up -d --force-recreate app`.

An old key left registered alongside the new one is harmless for launches and is
the safe way to roll over without a window where passbacks fail.

## See also

* [docs/integrations.md](integrations.md#the-grade-goes-back) — the tool's side:
  the routes, the AGS score body, and `make lti-key`.
* [docs/family-operations.md](family-operations.md) — the family's hostnames, and
  where the training app's machine credentials live and how to rotate them.
