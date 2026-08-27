/**
 * Duration parsing for CLI arguments and scenario files: "30s", "5m", "1500ms".
 */
const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

const MULTIPLIER: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const trimmed = input.trim().toLowerCase();
  const match = PATTERN.exec(trimmed);
  if (!match) {
    throw new TypeError(
      `Invalid duration "${input}". Expected a number with a unit, e.g. 500ms, 30s, 5m, 2h, 1d.`,
    );
  }
  return Number(match[1]) * MULTIPLIER[match[2]!]!;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
