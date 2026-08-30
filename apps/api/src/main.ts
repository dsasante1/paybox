import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { buildApp } from './app.js';
import { printBanner } from './banner.js';

/**
 * Entry point. `paybox start` runs this.
 */
async function main(): Promise<void> {
  const { config, warnings, sourcePath } = loadConfig();
  const context = await buildContext({ config });
  const app = await buildApp(context);

  context.scheduler.start();

  // Announce both phases: app.close() waits for in-flight requests (a
  // simulated-latency response can hold it open for the full latency), and a
  // silent wait reads as "Ctrl+C did not work".
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    context.logger.info('emulator.shutdown', { signal });
    process.stdout.write('\npaybox is stopping — finishing in-flight work…\n');
    await app.close();
    await context.shutdown();
    process.stdout.write('paybox stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  printBanner({ context, warnings, sourcePath });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `paybox failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
