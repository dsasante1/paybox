# site

The landing page for paybox: one static HTML document, a favicon and a
thirteen-line script. No framework, no build step, no dependencies — the same
trade the dashboard makes in `apps/api/src/dashboard.ts`, for the same reason:
nothing here should need compiling before it can be served.

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

## The coverage table

The provider table between the `<!-- coverage:start -->` and
`<!-- coverage:end -->` markers in `index.html` is **generated**, exactly like
the README's. Do not edit it by hand:

```bash
npm run coverage:table
```

It is rendered from each adapter's coverage manifest by `renderSiteTable`
(`packages/shared/src/coverage-report.ts`), and `tests/coverage-drift.test.ts`
fails if the page is stale — so the counts on the landing page cannot claim an
endpoint the router does not serve. Contract links are absolutised against the
repository, since the deployed page cannot resolve `docs/*.md`.

Everything else on the page is prose, written by hand, and should stay in step
with the README it paraphrases. The page makes no claim the README does not:
every adapter reads **Partial**, and the safety guarantees are stated in the
same terms as `SECURITY.md`.
