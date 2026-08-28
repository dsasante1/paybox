/**
 * Stage a large database for manual verification.
 *
 * Writes settled payments straight through the engine into a file-backed
 * database, then exits. Start the server against that file to exercise the
 * HTTP surface over a dataset bigger than one repository page (500 rows) --
 * which is where the reporting endpoints' aggregation actually gets tested.
 *
 *   npx tsx scripts/seed-volume.ts ./data/volume.db 520
 *   PAYBOX_DATABASE=./data/volume.db npm start
 */
import { openStorage } from '@paybox/storage';
import { EventBus, PaymentEngine, VirtualClock } from '@paybox/core';
import { createIdFactory, createRandom } from '@paybox/shared';

const [databasePath = './data/volume.db', countArg = '520', amountArg = '1000'] =
  process.argv.slice(2);
const count = Number(countArg);
const amount = Number(amountArg);

const { storage } = await openStorage({ database: databasePath });
const clock = new VirtualClock({ startAt: '2026-01-01T09:00:00.000Z', frozen: true });
const random = createRandom('volume');
const engine = new PaymentEngine({
  storage,
  clock,
  ids: createIdFactory(random),
  bus: new EventBus(),
});

for (let i = 0; i < count; i++) {
  const payment = await engine.createPayment({
    provider: 'paystack',
    amount,
    currency: 'NGN',
    reference: `volume-${i}`,
    status: 'pending',
  });
  await engine.transitionPayment(payment.id, 'successful');
}

process.stdout.write(
  `seeded ${count} settled payments of ${amount} minor units into ${databasePath}\n` +
    `expected total_volume: ${count * amount}\n`,
);
await storage.close();
