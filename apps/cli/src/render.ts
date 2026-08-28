import Table from 'cli-table3';
import pc from 'picocolors';

/** Terminal rendering helpers. Colour is applied by meaning, not decoration. */
export function statusColour(status: string): string {
  if (/^(success|successful|succeeded|processed)$/.test(status)) return pc.green(status);
  if (/^(failed|exhausted|cancelled|expired|reversed)$/.test(status)) return pc.red(status);
  if (/^(pending|processing|ongoing|requires_action|delivering|created|authorized|queued)$/.test(status)) {
    return pc.yellow(status);
  }
  if (/refunded/.test(status)) return pc.cyan(status);
  return status;
}

export function table(head: string[], rows: string[][]): string {
  const t = new Table({
    head: head.map((h) => pc.dim(h)),
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '─', 'mid-mid': ' ',
      right: '', 'right-mid': '', middle: '  ',
    },
  });
  for (const row of rows) t.push(row);
  return t.toString();
}

export function money(minorUnits: number, currency: string): string {
  return `${currency} ${(minorUnits / 100).toFixed(2)}`;
}

export function shortTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(11, 19);
}

/**
 * Date and time, for values that can be days or months apart.
 *
 * `shortTime` shows only the clock, which is right for a list of payments from
 * the last few minutes and actively misleading for billing periods a month
 * apart -- twelve renewals would all render identically.
 */
export function shortDateTime(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function keyValue(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${pc.dim(k.padEnd(width))}  ${v}`).join('\n');
}

export function heading(text: string): string {
  return `\n${pc.bold(text)}\n`;
}
