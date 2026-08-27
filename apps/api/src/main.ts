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

  const shutdown = async (signal: string) => {
    context.logger.info('emulator.shutdown', { signal });
    await app.close();
    await context.shutdown();
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
