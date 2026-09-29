# Unity

The one theme. Every Innotel project wears it — the OnTrak products, and anything
added after them. It exists because the alternative is what usually happens: five
apps that each started from a different dashboard template and now disagree about
what "attention" looks like, what a table row is, and whether dark mode is a
setting or a redesign.

Unity is not a component library. It is a vocabulary of **semantic tokens** plus a
handful of shared primitives, and a switch for the two axes a person actually
cares about.

- **Three schemes** — the palette family. A product picks one; the person can
  override it and the choice is remembered per browser.
- **Two modes** — `light` and `dark`, plus `system` to follow the machine.
- **One vocabulary** — `--surface`, `--ink-faint`, `--attention`. Never a raw
  colour, never a token that names a hue.

| scheme | family | who wears it |
| --- | --- | --- |
| `desk` | violet | the service desk (Tix) and the training range (ITS) |
| `operations` | graphite + blue | the operations consoles and the OnTrak Unity portal |
| `soc` | navy + cyan | the security-operations console (Sentinel) |

## The files

| file | what it is |
| --- | --- |
| `unity-theme.css` | the palette: every token, in all three schemes × both modes, then the shared primitives |
| `unity-theme.js` | the switch, framework-free. Owns `data-mode` and `data-scheme` on `<html>` |
| `unity-theme.tsx` | the switch as a React component — the same control, for apps that have React |
| `tests/test_theme_copies.py` | the drift guard. Fails if any product's copy differs by a byte |

## Adopting it in a new project

Three copies and two lines. The copies are not a suggestion about tidiness: each
app is built from its own directory, so a file outside the build context cannot be
imported, and a symlink breaks the moment the image is built. That is why the rule
is enforced by a test rather than by a README paragraph.

```bash
# 1. copy the three files into the app (paths vary by framework; these are Next.js)
cp theme/unity-theme.css myapp/src/theme/unity-theme.css
cp theme/unity-theme.js  myapp/public/unity-theme.js
cp theme/unity-theme.tsx myapp/src/components/ThemeToggle.tsx
```

```tsx
// 2. the app's own stylesheet imports the palette, and imports nothing visual itself
@import "../theme/unity-theme.css";
```

```tsx
// 3. the layout sets the scheme and loads the switch *before* the first paint
<html lang="en" data-scheme="operations">
  <head>
    <script dangerouslySetInnerHTML={{ __html: 'window.UNITY_DEFAULT_SCHEME = "operations";' }} />
    <script src="/unity-theme.js" />
  </head>
```

The `public/` asset loads by a **blocking** `<script src>`, deliberately. A theme
applied by a framework runs after the first paint, which is a white flash on a dark
screen — the one detail everybody notices about a dark mode that was added later.

Then add the app to `APPS` and `TOGGLES` in `tests/test_theme_copies.py`, and run it:

```bash
make theme          # or: python3 theme/tests/test_theme_copies.py
```

The guard skips a product that has not been converted yet, and enforces everything
once it has. A half-rolled-out estate passes; a converted app cannot drift.

## Using the tokens

```css
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
}
.card__note { color: var(--ink-faint); }
.card--overdue { border-color: var(--bad); background: var(--bad-soft); }
```

Every token, and what it means:

| token group | tokens | notes |
| --- | --- | --- |
| surfaces | `--canvas` `--surface` `--surface-muted` `--surface-sunken` | `canvas` is the page, `surface` is a card on it |
| lines | `--line` `--line-strong` | dividers, and the edge that needs to be seen |
| text | `--ink` `--ink-soft` `--ink-faint` | three levels, no more. A fourth means the hierarchy is wrong |
| brand | `--brand` `--brand-soft` `--brand-ink` `--brand-ring` | `--brand-ink` is the *text on* brand, which in dark mode is dark |
| status | `--ok` `--info` `--bad` `--attention` `--unknown` | each with a `-soft` for backgrounds |
| product tones | `--tone-its` `--tone-tix` `--tone-sentinel` `--tone-sync` | a label, never the only signal — always with the name in text |
| shape | `--radius-sm` `--radius` `--radius-lg` `--radius-pill` | |
| depth | `--shadow-card` `--shadow-pop` | |
| type | `--font-sans` `--font-display` `--mono` | |
| space | `--space-1` … `--space-6` | |

Two rules that matter more than the table:

1. **A token says what a thing *is*, not what colour it is.** `--attention`, never
   `--orange`. A class that names a colour cannot be re-themed, and the day the
   scheme changes it becomes a lie.
2. **`--unknown` is its own token on purpose.** A check that never ran must never be
   painted the same as a check that passed. Most dashboards get this wrong, and it
   is the failure that makes an operator stop trusting the whole page.

## The shared primitives

`unity-theme.css` also carries a small set of classes — `.ot-panel`, `.ot-btn`,
`.ot-field`, `.ot-pill`, `.ot-table`, `.ot-note`, `.ot-theme` — so that two products
cannot disagree about what a button is. Use them for the common cases and the tokens
for everything else. They are prefixed `.ot-` from the theme's earlier name; the
prefix is a namespace, not a product, and renaming it would churn every stylesheet
in the estate for nothing.

## Switching, from plain JavaScript

```js
window.UnityTheme.mode();          // "system" | "light" | "dark"
window.UnityTheme.setMode("dark");
window.UnityTheme.scheme();        // "desk" | "operations" | "soc"
window.UnityTheme.cycle();         // light -> dark -> system -> light
window.addEventListener("unity:theme", (event) => {
  console.log(event.detail.mode, event.detail.scheme);
});
```

`window.OntrakTheme` is kept as an alias so the products already calling it keep
working. New code should use `window.UnityTheme`.

## Changing the theme

Edit the canonical files in `theme/`, then copy them over every product's copy and
run `make theme`. Changing a token in one app is exactly the drift the guard exists
to catch, and the guard will say so in one line:

```
theme copies are not identical:
  ✗ ontrak-tix/src/theme/unity-theme.css has drifted from theme/unity-theme.css
```

Adding a **scheme** means three things: the token blocks in `unity-theme.css`
(light, explicit dark, and the `prefers-color-scheme` dark), `unity-theme.js`'s
`normaliseScheme`, and `unity-theme.tsx`'s `SCHEMES` list. `soc` was added for
Sentinel and is the worked example — a grep for it finds every place a scheme has to
be declared.
