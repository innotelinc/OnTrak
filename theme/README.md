# Unity — the OnTrak family theme

**Unity** is the one theme every OnTrak product shares. It is not a look that each
product interprets; it is a small, fixed contract about two facts on a document, and a
stylesheet that turns those two facts into a palette.

This directory holds the canonical copy. A product does not import it across a repo
boundary — it **vendors** it, byte-identical, and `npm run theme:verify` fails if a copy
has drifted.

---

## The two axes

Unity deliberately separates *how bright* from *what kind of work this is*, because they
are different questions asked by different people at different times.

| Axis | Attribute | Values | Absent means |
| --- | --- | --- | --- |
| **Mode** | `data-mode` on `<html>` | `light` · `dark` · *(absent)* | follow the machine |
| **Scheme** | `data-scheme` on `<html>` | `desk` · `operations` · *(absent)* | the product's default |

**Mode** is the personal, per-browser preference: light, dark, or no preference at all
(absent), in which case `prefers-color-scheme` decides. It is stored because a person who
prefers dark on the machine in front of them prefers dark there — as an administrator and
as a student at a shared bench alike. It is deliberately not an account setting.

**Scheme** is the professional register: `desk` is the service-desk voice (calm, warm,
human) and `operations` is the network-operations voice (denser, cooler, more
instrumented). A product declares which one it opens in; a person may switch. Every
product ships both, which is what makes the family look like one family when the desk and
the provider are on screen side by side.

The two combine freely: four rendered states, from `light + desk` to `dark + operations`.

## The files

| File | What it is |
| --- | --- |
| `ontrak-theme.js` | The switch. Four functions and a `localStorage` key. No framework, no bundler, no network. |
| `ontrak-theme.css` | The tokens and the `ot-*` component layer they drive. |

`ontrak-theme.js` exposes `window.OntrakTheme`:

```js
OntrakTheme.mode()            // "system" | "light" | "dark"
OntrakTheme.scheme()          // "desk" | "operations"
OntrakTheme.isDark()          // whether the page is dark *right now*, machine included
OntrakTheme.setMode("dark")   // persist and repaint
OntrakTheme.setScheme("operations")
OntrakTheme.cycle()           // light → dark → system → light
OntrakTheme.start()           // apply the stored values; safe to call again after hydration
```

It also dispatches `ontrak:theme` on `window` with `{ mode, scheme }` after any change, so
a React toggle can stay in sync without owning the state.

## Why the bootstrap is inline

A theme applied by a component runs *after* the first paint, which is a visible white
flash on a dark screen — the single most complained-about detail of every "we added dark
mode" change. So the **decision** is made by a tiny inline snippet in the document
`<head>`, before any paint, and `ontrak-theme.js` holds only the logic that snippet and
the toggle both call.

The head snippet a product injects:

```html
<script>window.ONTRAK_DEFAULT_SCHEME = "operations";</script>
<script src="/ontrak-theme.js"></script>
```

`ONTRAK_DEFAULT_SCHEME` is the product's register: `desk` for Tix and Training,
`operations` for Sentinel and Unity itself.

## Vendoring it

1. Copy `ontrak-theme.js` and `ontrak-theme.css` into the product, **unchanged**.
2. Serve `ontrak-theme.js` at `/ontrak-theme.js` (Next.js: `public/`).
3. Put the two `<script>` tags in the document head, before the first paint.
4. Theme the product's own CSS against the tokens, not against literal colours.

Do not edit a copy to fix something. Fix this file and re-vendor, or the verifier will
( correctly ) fail.

## Tokens

The palette is the contract; the `ot-*` classes are convenience on top of it.

```
--canvas  --surface  --surface-muted  --surface-sunken
--line    --line-strong
--ink     --ink-soft  --ink-faint
--brand   --brand-soft  --brand-ink  --brand-ring
--ok  --info  --bad  --attention  --unknown        (each with a -soft tint)
--tone-its  --tone-tix  --tone-sentinel  --tone-sync
--shadow-card  --shadow-pop
--radius-sm  --radius  --radius-lg  --radius-pill
--font-sans  --font-display  --mono
--space-1 … --space-6
```

`--tone-*` are the per-product accents, and they are what make a family page legible at a
glance: Training, Tix, Sentinel and Sync each keep their own hue against the same
neutral ground.

## Verifying the copies

```bash
npm run theme:verify
```

Walks every product that vendors the theme and fails on any byte difference, in either
file. The `--update` form re-vendors from this directory instead of complaining, which is
the intended way to roll a theme change out:

```bash
npm run theme:verify -- --update
```

## Provenance, stated plainly

The copies in this directory were recovered from the **deployed** Unity build at
`ontrak.innotel.us` (`/ontrak-theme.js` and its bundled stylesheet), because the repo the
Unity front door is deployed from was not reachable when this directory was created.

Two consequences worth knowing:

- `ontrak-theme.css` here is the **built** stylesheet, so it also carries the Unity
  front-door pages' own classes (`.gate`, `.masthead`, `.tile--*`, `.sso-button`). The
  pure token-and-component layer is the `:root`, `.dark`-free, `[data-scheme]` and `.ot-*`
  parts; the page-specific rules are harmless to a product that does not use those class
  names.
- When the Unity source repo is located, this directory should be replaced from it and
  the verifier re-run, so the canonical copy is the authored one rather than a build
  artifact.
