# Multi-tenancy — the organisation model and scoping rules

**Status:** the model and the access rules are in place; the 3.0 exit is not.
This document is the design contract the remaining work is held to, and it
describes what exists rather than what a future version might do. Roadmap
context is [ROADMAP.md §3.0](../ROADMAP.md) and the portfolio line is
[docs/portfolio-roadmap-v2.md](portfolio-roadmap-v2.md) §3.1.

## 1. The rule, in three parts

One deployment carries more than one organisation. Every read that can return a
tenant-owned row has to say which organisation it means, and `src/lib/tenancy.ts`
is the one place that answers:

1. **An ordinary person sees their own tenancy and nothing else.** A person with
   no tenancy yet sees the shared catalogue only — never everything. The filter
   for an unplaced account matches nothing (`__none__`) rather than being empty,
   because an empty filter is how a bug becomes a data breach.
2. **The platform operator sees every tenancy.** `platformAdmin` is a flag on
   the account, not a fourth role: it answers *which tenancies may I create and
   inspect*, while the role still answers *what may I do inside the one I belong
   to*. An operator who teaches is still an instructor there.
3. **A row with no organisation is the shared catalogue.** The built-in
   scenarios (`Scenario.organizationId = null`) are visible to and assignable by
   every tenancy, and editable by none of them. A tenancy's own scenario is
   visible to that tenancy alone.

**A cross-org request answers `404`, not `403`.** The record must not disclose
that it exists in somebody else's tenancy. This is a rule about the response,
not only about the query: a page that loads a row and then refuses it has
already leaked the distinction through timing and error copy.

## 2. Where the tenancy comes from

`SessionUser.organizationId` and `.platformAdmin` are read from the database on
every request (`src/lib/auth.ts`), deliberately **not** carried in the session
token. A person moved between organisations, or made an operator, would
otherwise keep the old answer until their cookie expired — the one staleness a
multi-tenant deployment cannot afford.

The session is the only source. A URL parameter, a form field or a filter may
*narrow* the tenancy (an operator inspecting a tenant, an export naming one),
but none of them may *widen* it, and every widening is an operator-only action
that is audited.

There is no tenant slug in the hostname and no second sign-in. One deployment,
one provider, one session.

## 3. The schema

A tenant-owned row carries `organizationId`; the shared catalogue carries
`null`; a global row has no such column at all.

| Model | Column | Meaning |
| --- | --- | --- |
| `Organization` | — | the tenancy itself: name, slug, kind, branding, program facts |
| `Program` | `organizationId` | a funded program inside one tenancy |
| `Course` | `organizationId` | a course belonging to a program |
| `Cohort` | `organizationId` | a class, and (where funded) its sponsor and provider |
| `Enrollment` | `organizationId` | a person's place in a class |
| `Attendance` | `organizationId` | a session's attendance record |
| `User` | `organizationId?` | the tenancy a person belongs to; `null` until placed |
| `Scenario` | `organizationId?` | the owning tenancy, or `null` for the shared built-ins |
| `Attempt`, `Assignment`, `CheckResult` | via their scenario and user | tenancy is derived, and is checked through it |
| `AuditLog`, `Setting` | — | global by design; the actor names the tenancy |

`Organization.slug` is the stable key for URLs, exports and filenames; the
display name changes and must never be the identifier. Branding (`displayName`,
`accent`, `logoUrl`) is a property of the tenancy, so one deployment can carry
more than one organisation's face without a second theme.

## 4. The scoping functions

All four live in `src/lib/tenancy.ts`, are pure, and take the session user:

- `tenantFilter(user)` — the `where` for a tenant-owned table. The operator gets
  `{}`; everyone else gets an equality on their own id; an unplaced account gets
  a filter that matches nothing.
- `catalogFilter(user)` — the scenario catalogue: the shared rows plus this
  tenancy's own. The operator sees the union of everything.
- `canManageTenant(user, organizationId)` — an `ADMIN` or `INSTRUCTOR` in that
  tenancy, or the operator. `null` (the shared catalogue) is never manageable
  through this function.
- `canAdministerTenant(user, organizationId)` — that tenancy's `ADMIN`, or the
  operator. Narrower than `canManageTenant` on purpose: pricing and people are
  an administrator's, while the person who teaches builds the classroom.
- `canCreateTenants(user)` — the operator alone.

**A helper returning a filter is not a check.** Every surface that writes does
both: it scopes the query it reads through, and it asks the permission question
again before the write, because a hidden row is not a refused one. The server
actions in `src/app/actions/tenants.ts` are the pattern — `requireOperator`,
`requireTenantAdmin` and `requireTenantStaff` start from the session, not from
the form.

## 5. Surfaces that must be scoped

The 3.0 exit is met when each of these is scoped in code and pinned by a test:

| Surface | Scope | State |
| --- | --- | --- |
| Scenario catalogue, authoring and review | `catalogFilter`; publishing a shared row is operator-only | in place |
| Programs, courses, cohorts and enrolments | `tenantFilter`; mutations through `requireTenantAdmin`/`Staff` | in place |
| Tenant admin pages, directory export and report | `canAdministerTenant`; the operator may inspect any | in place |
| Tenant branding and the report's header | the tenancy's own fields | in place |
| Attempt lists, analytics, skills matrix and re-grade | `attemptScopeFor` — **an org rung is still missing** | open |
| Certificates, `/verify` and cohort packets | the attempt's tenancy, with the public verifier deliberately tenancy-blind | open |
| Results/roster API, CSV export and webhooks | the token's tenancy; an operator token names one explicitly | open |
| AI tutor (3.0) | the attempt's tenancy; never reads another attempt | not started |
| Retention and read auditing (3.0) | per-org policy over the rows above | not started |

`attemptScopeFor` (`src/lib/attempt-scope.ts`) is the first open item: it
resolves the viewer's students, authored scenarios and assignments, but it does
not yet add `tenantFilter(viewer)` above them. An administrator of one tenancy
would therefore see another tenancy's attempts through the list, the analytics
dashboard and the skills matrix. The fix is an org rung applied before the role
rung, not a second filter applied afterwards.

## 6. The shared catalogue

A shared scenario is read-only to a tenancy, which creates two problems a
column alone does not solve:

- **Pinning.** A tenancy that assigns a shared scenario must keep grading
  against the definition it adopted. The bundle hash
  (`src/lib/scenario-bundle.ts`) is the identity; a later edit to the shared row
  is a new version, not a silent change under an in-flight attempt.
- **Adoption.** A tenancy that wants to edit a shared scenario imports it as a
  draft it owns. It does not edit the shared row in place, and it does not fork
  by copying the grading contract into a second, unversioned place.

## 7. The operator, and what is audited

- Creating a tenancy, moving a person between tenancies, granting
  `platformAdmin`, and changing a tenancy's branding are audited with the actor
  and the tenancy.
- An operator **inspecting** another tenancy is a read, and 3.0 makes reads of
  personal records auditable too (certificate and packet views, exports, tutor
  use). Today only writes are audited.
- There is no super-user account that bypasses the role checks: the operator
  bypasses the *tenancy* check, not the *permission* check, except where the
  action is expressly an operator action.

## 8. What remains before 3.0 closes

1. Add the org rung to `attemptScopeFor` and use it on the attempts list,
   analytics, skills matrix and re-grade.
2. Scope certificates, `/verify` and cohort packets; keep the public verifier
   able to check a code without revealing whose tenancy it belongs to.
3. Scope the API, CSV export and webhook deliveries to the token's tenancy, with
   an operator token required to name one.
4. Add the tests the current suite lacks: a two-tenant fixture proving that a
   list, a detail read, a re-grade, an export and a certificate view from
   tenancy B are refused by tenancy A's administrator, and that an unplaced
   account sees the shared catalogue and nothing else.
5. Audit reads of personal records, under the tenancy's retention policy.
6. Only then the tutor and the per-org retention/export work, which are the
   rest of the 3.0 line.

## 9. Tests to write

- Pure: `tenantFilter`, `catalogFilter`, `canManageTenant`,
  `canAdministerTenant` and `canCreateTenants` for an operator, an `ADMIN`, an
  `INSTRUCTOR`, a `STUDENT` and an unplaced account.
- Database-backed: two organisations, one shared scenario and one private
  scenario each; the matrix of list/detail/write/export/certificate access; the
  404-not-403 rule; a user moved between organisations losing the old tenancy's
  visibility on the next request without a new cookie.
- Regression: a shared scenario edited after an attempt started does not change
  what that attempt is graded against.
