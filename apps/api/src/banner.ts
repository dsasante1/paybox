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
  const { config, baseUrl, keys, stripeKeys, flutterwaveKeys, koraKeys, wewireKeys } = context;
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
  out(`    Paystack   ${baseUrl}/paystack   partial — see docs/paystack.md`);
  out(`    Stripe     ${baseUrl}/stripe     partial — see docs/stripe.md`);
  out(`    Flutterwave ${baseUrl}/flutterwave partial — see docs/flutterwave.md`);
  out(`    Kora       ${baseUrl}/kora        partial — see docs/kora.md`);
  out(`    WeWire     ${baseUrl}/wewire      partial — see docs/wewire.md`);
  for (const id of [] as string[]) {
    out(`    ${id.padEnd(10)} not implemented yet`);
  }
  out();
  out('  Test credentials (local only — these are not real keys)');
  out(`    Paystack   ${keys.secretKey}`);
  out(`    Stripe     ${stripeKeys.secretKey}`);
  out(`    Flutterwave ${flutterwaveKeys.secretKey}`);
  out(`    Flutterwave encryption key ${flutterwaveKeys.encryptionKey}`);
  out(`    Kora       ${koraKeys.secretKey}`);
  out(`    WeWire     ${wewireKeys.secretKey}`);
  out();
  out('  Point your app at the emulator:');
  out(`    PAYSTACK_BASE_URL=${baseUrl}/paystack`);
  out(`    STRIPE_API_BASE=${baseUrl}/stripe`);
  out(`    FLW_BASE_URL=${baseUrl}/flutterwave`);
  out(`    KORA_BASE_URL=${baseUrl}/kora`);
  out(`    WEWIRE_BASE_URL=${baseUrl}/wewire`);
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
