# Contributing to OnTrak IT Support Training

Thanks for helping make hands-on IT practice accessible. This is an Innotel Labs
product. This guide covers the
setup, the ground rules that keep the project maintainable, and how to get a
change merged.

## Getting set up

```bash
cp .env.example .env      # set AUTH_SECRET to a long random value
npm install
npm run docker:db         # Postgres 16, or point DATABASE_URL at your own
npm run setup             # prisma generate + migrate deploy + reset attempts + seed
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. The build matters because parts of this app fail only under
server rendering (see *Server-only boundaries* below).

## Project layout

```
src/app/            routes and server actions
src/components/     UI (ui.tsx is the design system)
src/lib/sim/        the simulator — pure TypeScript
src/lib/            availability, validation, scenarios, auth
prisma/             schema and seed
tests/              engine + grading + validator tests
docs/               scenario authoring guide
```

## Ground rules

### 1. Keep the simulator pure

Everything under `src/lib/sim/` must stay **dependency-free TypeScript**: no
React, no Prisma, no `server-only`, no DOM, no `node:*` imports. This is what
lets the identical code run in three places:

- in the browser, driving the live console;
- on the server, re-grading a submission;
- in `npm test`, with no browser or database.

If you need a capability that only exists in one environment, pass it in as a
parameter rather than importing it.

### 2. Never trust the client

Grading is deterministic and re-runs on the server from the sanitised submitted
snapshot (`coerceSubmittedState` → `gradeAttempt`). A client-side score is a
convenience for the UI, never the record. Changes that would let the browser
influence a stored score will be rejected.

### 3. Respect the driver seam

Every console implements the `ShellDriver` interface (`prompt`, `banner`,
`runCommand`, optional `completions`). The current drivers are in-browser
simulations; a future container-backed driver must be able to slot in behind the
same interface without touching the UI, the scenario format or the grader. Don't
leak driver-specific types into components.

The clickable Windows desktop obeys the same rule. It holds no machine logic of
its own: every button emits the cmdlet a technician would have typed and hands it
to the same driver the terminal uses, so grading never learns which surface the
student worked on. Keep those command builders in `src/lib/sim/desktop.ts`
rather than inline in JSX — the test that solves a desktop scenario then runs
exactly what the buttons send.

### 4. Server-only boundaries

`src/lib/availability.ts`, `src/lib/scenarios.ts` and `src/lib/auth.ts` import
`server-only`. Keep them out of client components and out of scripts that run
outside Next — that is why password hashing lives in the framework-free
`src/lib/auth-hash.ts`, which the seed script imports instead.

`xterm.js` reads the browser-only `self` global at module scope, so it must never
be evaluated during server rendering. It is loaded through `next/dynamic` with
`ssr: false` in `AttemptRunner`. Keep it that way; a static import will break SSR
with `ReferenceError: self is not defined`.

### 5. Read form fields through the pure rule modules

Server actions receive raw `FormData`, so form parsing lives in pure `*-rules.ts`
modules rather than inline in the action: `form-rules.ts` holds the shared
units/dates/ids, and `assignment-rules.ts`, `software-rules.ts`,
`scenario-rules.ts` and `auth-rules.ts` parse one form each. Use those helpers
instead of reading fields inline.

- **Units.** If a label says *minutes*, the action must convert to the seconds
the column stores — and the view must convert back. The assignment time-limit
bug was exactly this mismatch; `assignmentTimeLimitSec` now owns it.
- **Dates.** `parseDateInput` reads a `type="date"` value as the *end* of that
day (UTC) and `parseDateTimeInput` reads a `type="datetime-local"` value as UTC.
Both return a `{ ok }` result: blank is a legitimate "no date", malformed is an
error to flash — never pass `new Date(...)` straight to Prisma, where an
`Invalid Date` throws.
- **Disabled controls submit nothing.** An action can't tell a `disabled`
checkbox from an unchecked one, so resolve those fields explicitly (see
`resolveUserEdit`) rather than reading the absent value as real.

Keep each new coercion a pure function in one of those modules and cover it in
`tests/lib.test.ts`; the action should stay thin enough that the parsing needs
no database to test.

### 6. Database changes go through the schema

Edit `prisma/schema.prisma`, then `npm run db:migrate` to produce a versioned
migration under `prisma/migrations/` for the pull request.

Every environment applies those migrations, so a deploy is never a guess about
what a `db push` happened to do: `npm run setup` uses `prisma migrate deploy`, and
a deployment runs `npm run db:deploy` before starting the app. `npm run db:push`
is still there for throwaway iteration on a database you are happy to drop — do
not use it on one you intend to migrate later.

If you meet a database that predates the migrations (it was created by `db push`),
baseline it once rather than recreating it:

```bash
npx prisma migrate resolve --applied 20260927000000_init
npx prisma migrate resolve --applied 20260927000100_add_attempt_certificate
```

Keep `prisma/seed.ts` idempotent — it is re-run by contributors constantly.

### 7. Know who owns what

Two ownership models coexist, deliberately:

- **Scenarios are a shared staff catalog.** Any instructor or administrator may
  edit, publish, duplicate and — while nothing has been attempted — delete any
  scenario. Once a scenario has recorded attempts only an administrator may
  delete it (`canDeleteScenario`). Do not add author-only checks to the scenario
  or grading actions; the catalog is meant to be collaborative.
- **Classes and assignments are owner-scoped.** A class belongs to the
  instructor who created it. Only that instructor (or an administrator) may
  update it, manage its roster, or assign work into it, using the same
  owner-or-admin check the cohort actions share.

When unsure, mirror the neighbouring action rather than inventing a policy.

### 8. Authoring stays validated

New check kinds, fields or definition options must be added to the validator
(`src/lib/validate.ts`: `CHECK_KINDS` and `REQUIRED_FIELDS`), typed in
`src/lib/sim/types.ts`, implemented in `grade.ts`, documented in
`docs/scenario-authoring.md`, and covered by a test. A check kind the validator
does not know about is a bug.

> Remember: JavaScript regexes have no inline flags. `"(?i)foo"` is invalid —
> use a `flags: "i"` field. The validator compiles every pattern so this fails
> loudly at authoring time.

## Style

- TypeScript strict mode; the project typechecks with `tsc --noEmit`.
- Comments explain **why**, not what. Keep them for real decisions and traps.
- Reuse the primitives in `src/components/ui.tsx` rather than inventing new
  buttons and cards; the visual identity is intentionally consistent.
- Accessibility and mobile matter — students take these scenarios on phones.
  Test the console on a narrow viewport before shipping UI work.
- Keep pull requests focused. A bug fix should not carry unrelated refactors.

## Tests

`npm test` runs `tsx --test tests/*.test.ts`, using `tests/tsconfig.json` so a
test can render a component with JSX. Add cases to `tests/sim.test.ts` (or a
sibling file) for:

- new commands and cmdlets;
- new check kinds and grading edge cases (full, partial, hint penalties);
- validator errors and warnings;
- regressions — every bug fix gets a test that would have caught it.

## Pull requests

A good pull request:

1. describes the **problem** and the chosen approach, not just the diff;
2. passes `typecheck`, `test` and `build`;
3. includes tests for behavior changes;
4. updates the docs it invalidates — the README, the authoring guide, or both.

Small, well-explained changes merge fastest. If you are proposing something
large — a new platform, a real container backend, a grading model change — open
an issue first so we can agree on the seam before you write the code.

## License

By contributing you agree that your work is released under the project's
[MIT license](LICENSE).
