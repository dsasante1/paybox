import type { PayboxContext } from './context.js';

/**
 * Startup output (spec §38).
 *
 * Deliberately states what is and is not implemented per provider. A developer
 * who reads "✓ Paystack" and assumes full coverage will waste an afternoon;
 * "partial" plus a docs link costs one line and prevents that.
 */
export function printBanner(options: {
  context: PayboxContext;
  warnings: string[];
  sourcePath: string | null;
}): void {
  const { context, warnings, sourcePath } = options;
  const { config, baseUrl, keys } = context;
  const out = (line = '') => process.stdout.write(`${line}\n`);

  out();
  out('  paybox — local payment emulator');
  out('  ───────────────────────────────────────────────');
  out(`  API         ${baseUrl}`);
  out(`  Dashboard   ${baseUrl}/dashboard`);
  out(`  API docs    ${baseUrl}/docs`);
  out(`  Database    ${config.database.path}`);
  if (sourcePath) out(`  Config      ${sourcePath}`);
  out();
  out('  Providers');
  out(`    Paystack  ${baseUrl}/paystack   partial — see docs/paystack.md`);
  for (const id of ['stripe', 'flutterwave', 'kora']) {
    out(`    ${id.padEnd(9)} not implemented yet`);
  }
  out();
  out('  Test credentials (local only — these are not real keys)');
  out(`    secret    ${keys.secretKey}`);
  out(`    public    ${keys.publicKey}`);
  out();
  out('  Point your app at the emulator:');
  out(`    PAYSTACK_BASE_URL=${baseUrl}/paystack`);
  out();

  if (config.freezeClock) {
    out('  ⏸  Clock is FROZEN. Use `paybox time advance 30s` to move it.');
    out();
  }
  for (const warning of warnings) {
    out(`  ⚠  ${warning}`);
    out();
  }
  out('  No real money can move through this process.');
  out();
}
