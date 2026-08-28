/**
 * The shell every provider's hosted payment page shares.
 *
 * Each provider's page is genuinely different -- Paystack's offers mobile
 * money, bank and card; Stripe's is card-only -- so the *fields* are not
 * shared and should not be. What is shared is the chrome: the document, the
 * styling, and above all the §29 banner saying no real money moves here.
 *
 * That banner is the reason this exists. Two hand-written pages drift, and a
 * hosted checkout that stops announcing it is an emulator is exactly the
 * mistake that gets a test card typed into a real form.
 *
 * Pure string templating, no runtime dependencies, like everything else here.
 */

/** Escape text for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#14161a; --card:#fff;
          --muted:#606875; --line:#e3e6ea; --accent:#0b7285; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e8eaed; --card:#171a20; --muted:#9aa4b2;
            --line:#272b33; --accent:#3bc9db; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5
         ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:24px 16px 48px; }
  .banner { background:#fff4e5; color:#7a4a00; border:1px solid #ffd8a8;
            border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:16px; }
  @media (prefers-color-scheme: dark) {
    .banner { background:#2b2113; color:#ffd8a8; border-color:#5c4413; }
  }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:20px; }
  .amount { font-size:30px; font-weight:650; letter-spacing:-0.02em; }
  .ref { color:var(--muted); font-size:13px; margin-top:2px; }
  label { display:block; font-size:13px; color:var(--muted); margin:14px 0 4px; }
  input, select { width:100%; padding:10px 12px; font-size:15px; border-radius:8px;
                  border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  fieldset { border:0; padding:0; margin:0; }
  .tabs { display:flex; gap:6px; margin-top:16px; }
  .tabs button { flex:1; padding:9px 8px; font-size:13px; border-radius:8px; cursor:pointer;
                 border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  .tabs button[aria-selected="true"] { border-color:var(--accent); color:var(--accent); }
  .pay { width:100%; margin-top:20px; padding:12px; font-size:15px; font-weight:600;
         border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .err { background:#ffe3e3; color:#a61e1e; border:1px solid #ffc9c9; border-radius:8px;
         padding:10px 12px; font-size:13px; margin-bottom:12px; }
  @media (prefers-color-scheme: dark) {
    .err { background:#2b1517; color:#ffc9c9; border-color:#5c1f22; }
  }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:12.5px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  details { margin-top:18px; }
  summary { cursor:pointer; color:var(--muted); font-size:13px; }
  .hide { display:none; }
  .msg { font-size:15px; margin-top:8px; }
  .muted { color:var(--muted); font-size:13px; margin-top:14px; }
  a { color:var(--accent); }
`;

/** The §29 notice. One string, so it cannot differ between providers. */
export const EMULATOR_BANNER =
  '⚠ paybox emulator — no real money moves here. Test instruments only.';

export interface HostedPageOptions {
  title: string;
  /** Already-escaped HTML for the page body, inside the card. */
  body: string;
  /** Shown above the card, escaped for you. */
  error?: string | null;
  /** Appended before </body>; used for the tab switcher. */
  script?: string;
}

/** Wrap page content in the shared document, styling and safety banner. */
export function renderHostedPage(options: HostedPageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style></head><body>
<div class="wrap">
  <div class="banner">${EMULATOR_BANNER}</div>
  ${options.error ? `<div class="err">${escapeHtml(options.error)}</div>` : ''}
  ${options.body}
</div>
${options.script ? `<script>${options.script}</script>` : ''}
</body></html>`;
}

export interface HostedResultOptions {
  title: string;
  heading: string;
  message: string;
  /** Where the payer is sent next, if the integration supplied somewhere. */
  redirectUrl?: string | null;
  /** Seconds before an automatic redirect. Omit for no redirect. */
  redirectAfterSeconds?: number;
}

/**
 * The page shown once a hosted checkout has been submitted.
 *
 * Redirects only when the integration gave a URL to redirect to; otherwise it
 * says plainly that no return URL was configured, rather than stranding the
 * payer on a blank page.
 */
export function renderHostedResult(options: HostedResultOptions): string {
  const redirect = options.redirectUrl;
  const seconds = options.redirectAfterSeconds ?? 2;
  return renderHostedPage({
    title: options.title,
    body: `<div class="card">
    <div class="amount">${escapeHtml(options.heading)}</div>
    <div class="msg">${escapeHtml(options.message)}</div>
    ${
      redirect
        ? `<div class="muted">Returning to <a href="${escapeHtml(redirect)}">${escapeHtml(
            redirect,
          )}</a>…</div>`
        : '<div class="muted">No return URL was configured for this payment.</div>'
    }
  </div>`,
    ...(redirect
      ? {
          script: `setTimeout(function(){location.href=${JSON.stringify(redirect)};}, ${
            seconds * 1000
          });`,
        }
      : {}),
  });
}
