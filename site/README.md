# site

The landing page for paybox: one static HTML document, a favicon and a short
script. No framework, no build step, no dependencies — the same trade the
dashboard makes in `apps/api/src/dashboard.ts`, for the same reason: nothing
here should need compiling before it can be served.

## The drawing

The page is laid out as a technical sheet rather than a marketing page: a title
plate, a numbered sheet index, sections `§00`–`§06`, and three figures drawn as
patent-style line art.

| | |
|---|---|
| Paper | `#f8f9fa`, with a 32px construction grid of 1px lines |
| Ink | `#121212`; `#4a5058` for prose, `#666d75` for the mono lettering |
| Rules | 1px throughout — `#c9ced4` for hairlines, ink for the frame |
| Accent | `#1b44e0`, and **only** on the highlighted step of a process |
| Type | JetBrains Mono / system mono for lettering, Inter / system sans for prose — both from the system, so the page still loads no external asset |
| Absent | gradients as shading, shadows, filled shapes, rounded corners |

The three figures are hand-plotted SVG, on the same 4px grid, using one line
vocabulary: `.s-thin` for geometry, `.s-rule` for dimension and extension
lines, `.s-dash` for axes, `.s-acc` for the highlighted step. Strokes carry
`vector-effect: non-scaling-stroke`, so a hairline stays a hairline when the
figure scales. Each figure has a `<title>` and a `<desc>` that describes the
whole drawing in words, and a caption that repeats the substance in prose —
the diagrams are not the only way to read the page.

Text on the figures is knocked out over its own rules with a paper-coloured
rectangle rather than a background fill, which is how a dimension line is
lettered on a real drawing.

**One accent, one job.** Blue marks the step of a process that is the point of
the figure: `time advance` in FIG. 1, the exhausted delivery in FIG. 2, the
provider layer in FIG. 3. It is also the link colour, and nothing else uses it.

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
- **FIG. 1 and FIG. 2 still scroll inside their frames**, because shrinking them
  to fit makes the lettering unreadable. Their frames say `SWIPE →` — set from
  `main.js` by a `ResizeObserver` against the real widths, so it appears only
  when the drawing genuinely does not fit and disappears the moment it does.
  FIG. 3's floor is 300px, which fits.
- **Targets and lettering are bigger**: 44px minimum on every control (the
  index links were 22px), and the smallest mono labels go from 10.5px to
  11.5px.

### Verifying a change

There is no test for the visual design, so check it in a browser before
deploying — including at a phone width:

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

This directory is the deployment root, so a Vercel project must be pointed at
it rather than at the repository root — the repository root is a TypeScript
monorepo and Vercel would try to build it.

**From the CLI**, once, from inside this directory:

```bash
npx vercel            # preview deployment
npx vercel --prod     # production
```

`vercel link` will ask which scope and project to use; answer once and the
answers are stored in `site/.vercel`, which is gitignored.

**From the dashboard**, importing `dsasante1/paybox`:

| Setting | Value |
|---|---|
| Framework Preset | Other |
| Root Directory | `site` |
| Build Command | *(empty)* |
| Output Directory | `.` |
| Install Command | *(empty — there is nothing to install)* |

`vercel.json` carries the rest: `cleanUrls`, a content-security policy that
allows only this page's own assets, and the usual hardening headers.

Preview it locally with any static server:

```bash
npx serve site        # or: python3 -m http.server --directory site
```

### Where it is deployed

Project `paybox-emulator` in the `verbsghs-projects` scope, aliased to
**https://paybox-emulator.vercel.app**. `vercel link` has already been run
here, so `npx vercel --prod` from this directory deploys to that project;
`site/.vercel` and the `.env.local` the link step writes are both local and
gitignored, and `.vercelignore` keeps them — and this file — out of the upload,
since a static deployment would otherwise serve the token file verbatim.

### The canonical URL

`index.html` carries `<link rel="canonical">` and `og:url` pointing at
`https://paybox-emulator.vercel.app/`, which assumes the Vercel project is
named `paybox-emulator`. If it ends up on a different hostname — a custom
domain, or a different project name — change both, or search engines and link
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
