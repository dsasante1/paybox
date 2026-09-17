# site

The landing page for paybox: one static HTML document, a favicon and a short
script. No framework, no build step, no dependencies — the same trade the
dashboard makes in `apps/api/src/dashboard.ts`, for the same reason: nothing
here should need compiling before it can be served.

## The drawing

The page is laid out as a technical sheet rather than a marketing page: a title
plate, a numbered index, sections `§00`–`§06`, and two figures drawn as
patent-style line art.

| | light | dark |
|---|---|---|
| Paper | `#f8f9fa` | `#0f1216` |
| Ink | `#121212` | `#e9ecf1` |
| Prose | `#4a5058` | `#a7b0bb` |
| Mono lettering | `#666d75` | `#828b96` |
| Hairlines | `#c9ced4` | `#2c3239` |
| Construction grid | `#e4e7ea` | `#191e24` |
| Accent | `#1b44e0` | `#7aa2ff` |

Every text pair above is at least 4.5:1 on its own ground, in both themes;
`scripts/` has no checker for it, so the numbers were computed by hand when the
palette was chosen. The hairline is deliberately ~1.5:1 in both — it is a
drawn line, not a control boundary, and the frames that *are* boundaries use
ink.

| | |
|---|---|
| Type | JetBrains Mono / system mono for lettering, Inter / system sans for prose — both from the system, so the page still loads no external asset |
| Accent | used **only** on the highlighted step of a process, and as the link colour |
| Absent | gradients as shading, shadows, filled shapes, rounded corners |

### The two themes, and the switch

Each colour is defined **once**, as `light-dark(<light>, <dark>)`, resolved by
the computed `color-scheme`. Every token carries the plain light value on the
line above as a fallback, so a browser too old for `light-dark()` keeps that
declaration, drops the next as invalid, and renders the light sheet rather than
an unstyled one.

Nothing below the palette block knows which theme it is in. The switch is one
line per mode:

```css
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
```

`theme.js` sets that attribute and stores the choice under `paybox-theme`.
It is loaded from `<head>` **without `defer`**, on purpose: a visitor who chose
dark must not be shown a white page first. That is also why it is separate from
`main.js`, which runs at the end of the body.

- `auto` removes the attribute, so `color-scheme: light dark` stands and the
  operating system decides — including for a visitor with no JavaScript.
- The control is a real `<select>` covering its whole plate cell, so the target
  is the cell (56px) rather than the 14px text box, and the phone gets its
  native picker. The cell prints the current value.
- The control is **hidden until `theme.js` runs** (`[data-theme-ready]`).
  Without the script it could not do anything, and a dead switch is worse than
  none.

One deliberate asymmetry: the opening notice is the sheet's only inverted
element, and inverting it again in the dark theme would put a glaring white
band across the top of a dark page. There it is a raised panel (`--band-bg`)
instead — same emphasis, none of the glare.

`favicon.svg` carries its own `prefers-color-scheme` block, so the tab icon
follows the browser too.

Both figures are hand-plotted SVG, on the same 4px grid, using one line
vocabulary: `.s-thin` for geometry, `.s-rule` for dimension and extension
lines, `.s-acc` for the highlighted step. Strokes carry
`vector-effect: non-scaling-stroke`, so a hairline stays a hairline when the
figure scales. Each figure has a `<title>` and a `<desc>` that describes the
whole drawing in words, and a caption that repeats the substance in prose —
the diagrams are not the only way to read the page.

Text on the figures is knocked out over its own rules with a paper-coloured
rectangle rather than a background fill, which is how a dimension line is
lettered on a real drawing.

**One accent, one job.** Blue marks the step of a process that is the point of
the figure: `time advance` in FIG. 1, the exhausted delivery in FIG. 2. It is
also the link colour, and nothing else uses it.

### On a phone

The sheet itself never scrolls sideways — every grid track between a figure and
the page has a zero minimum, or the 640px drawings would push the whole layout
across. What is deliberately different at 620px and below:

- **The index becomes a menu.** One 44px row under the title plate, closed
  until tapped, opening into a panel bounded at 62vh that scrolls on its own.
  It is the same list in the same place in the DOM -- `main.js` syncs the
  `<details>` element's `open` attribute to the width instead of the markup
  carrying two copies, and the page ships it open, so with no JavaScript the
  index degrades to the plain column of links it is. Choosing from it closes
  it. It was below the sheet before, where it could not be used to reach
  anything without scrolling past everything first.
- **The coverage schedule stops being a table.** Four columns of one fact each
  become one block per adapter, so it needs no sideways scroll. The endpoint
  count grows the word `endpoints`, because the column heading it used to sit
  under is hidden.
- **Both figures still scroll inside their frames**, because shrinking them to
  fit makes the lettering unreadable. Their frames say `SWIPE →` — set from
  `main.js` by a `ResizeObserver` against the real widths, so it appears only
  when the drawing genuinely does not fit and disappears the moment it does.
- **Targets and lettering are bigger**: 44px minimum on every control (the
  index links were 22px), and the smallest mono labels go from 10.5px to
  11.5px.

### Verifying a change

There is no test for the visual design, so check it in a browser before
deploying — in **both themes** and at a phone width. Chromium can emulate the
preference over CDP (`Emulation.setEmulatedMedia` with
`prefers-color-scheme`), which is how the palette above was checked; the paths
worth re-checking after a change are: auto under a light OS, auto under a dark
OS, each explicit choice surviving a reload, a choice returning to auto, and
the control's absence with scripts disabled.

```bash
python3 -m http.server 8099 --directory site
chromium --headless --window-size=430,3000 --screenshot=/tmp/m.png http://127.0.0.1:8099/
```

The interactive parts are the tabbed data panel in `§02` and the copy buttons.
The tablist implements arrow-key navigation with a roving `tabindex`; the code
panels number their lines with CSS generated content, which browsers leave out
of a copy, so the copy button rejoins the `.l` elements with newlines rather
than reading `textContent`.

## Deploying it on Vercel

Production is **https://paybox-emulator.vercel.app** — project
`paybox-emulator` in the `verbsghs-projects` scope.

### On merge, automatically

The project is configured for git deployments: **Root Directory `site`**, with
no install or build command, because this directory holds no `package.json` and
nothing to compile. A push to `main` deploys production; a pull request gets its
own preview URL. `vercel.json` carries the rest, including an `ignoreCommand`
that skips a deployment when the push changed nothing under `site/` — so an
unrelated commit to the monorepo does not redeploy the page.

The repository root's `.vercelignore` applies to **both** deploy paths, not
just to `vercel deploy`, and it runs *before* the ignore command — so it has to
keep `.git`, or `git diff` has nothing to read and the deployment fails rather
than deciding. The command answers `exit 1` (build) for anything other than a
clean "nothing under `site/` changed", so a git invocation that cannot run is
never mistaken for a skip. Both branches are worth keeping straight: this cost
one failed production deployment to learn.

Root Directory is the one setting `vercel.json` cannot express, so it lives in
the project rather than in this repository. It must stay `site`: at the
repository root Vercel would find the monorepo's `package.json` and run the
package bundler.

**One manual step is outstanding.** The Vercel GitHub App is installed on the
`dsasante1` account but scoped to selected repositories, and `paybox` is not
among them, so Vercel cannot yet watch this repo. Granting it needs a click
that no token can make on the app's behalf:

1. <https://github.com/settings/installations> → **Vercel** → **Configure**
2. Under *Repository access*, add `dsasante1/paybox`
3. Then, from the repository root:
   ```bash
   npx vercel git connect
   ```

Until that is done, git deployments do not fire and the manual path below is
the only one.

### By hand

```bash
npx vercel            # preview deployment
npx vercel --prod     # production
```

Run these **from the repository root**, not from `site/` — the project's Root
Directory is `site`, so a deploy launched inside `site/` looks for `site/site`
and fails. `.vercelignore` keeps the upload to `site/` and `.git`; the rest of
the monorepo is source for the npm package and the container image, including
`idea.txt`, which is deliberately unpublished. Verified: the deployed page
answers 200 while `/package.json`, `/README.md` and `/.env.local` all answer
404.

`vercel link` writes `.vercel` and an `.env.local` holding a short-lived OIDC
token into the repository root. Both are gitignored, and `.vercelignore`
excludes them from an upload.

### The canonical URL

`index.html` carries `<link rel="canonical">` and `og:url` pointing at
`https://paybox-emulator.vercel.app/`, which is where it is deployed. On a
custom domain or a renamed project, change both, or search engines and link
previews will point at a URL that does not resolve.

## The generated blocks

Two things on this page are **generated**. Do not edit either by hand:

```bash
npm run generate
```

- The provider table, between `<!-- coverage:start -->` and
  `<!-- coverage:end -->`, rendered from each adapter's coverage manifest by
  `renderSiteTable` (`packages/shared/src/coverage-report.ts`). Contract links
  are absolutised against the repository, since the deployed page cannot
  resolve `docs/*.md`.
- The version in the title plate, between `<!-- version:start -->` and
  `<!-- version:end -->`, read from `apps/paybox/package.json` — the one field
  that decides what `npx paybox-emulator` installs.

`tests/coverage-drift.test.ts` fails if either is stale, so the page cannot
claim an endpoint the router does not serve, and cannot name a version that is
not the published one. `scripts/generated-blocks.ts` owns both.

Everything else on the page is prose, written by hand, and should stay in step
with the README it paraphrases. The page makes no claim the README does not:
every adapter reads **Partial**, and the safety guarantees are stated in the
same terms as `SECURITY.md`.
