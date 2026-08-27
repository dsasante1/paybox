/**
 * A complete Paystack integration, pointed at paybox.
 *
 * The only thing that differs from a production integration is PAYSTACK_BASE_URL.
 * Everything else — initialization, the redirect, signature verification,
 * verify-before-granting-value — is exactly what you would ship.
 *
 *   1. paybox start
 *   2. paybox webhook add http://localhost:3000/webhooks/paystack
 *   3. PAYSTACK_SECRET_KEY=<from the paybox banner> npm start
 *   4. open http://localhost:3000
 */
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL ?? 'http://127.0.0.1:8080/paystack';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PORT = Number(process.env.PORT ?? 3000);

if (!SECRET_KEY) {
  console.error('Set PAYSTACK_SECRET_KEY to the sk_test_local_... key paybox printed.');
  process.exit(1);
}

const app = express();

/** Stand-in for your database. */
const orders = new Map();
/** Webhook ids already handled — the defence against replay and duplicates. */
const processedEvents = new Set();

const paystack = async (path, options = {}) => {
  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!body.status) throw new Error(body.message);
  return body.data;
};

/* ------------------------------------------------------------------ *
 * Webhook — mounted BEFORE express.json() so the raw bytes survive.
 * ------------------------------------------------------------------ */

app.post(
  '/webhooks/paystack',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    // Verify over the exact bytes received. Hashing a re-serialised object is
    // the most common cause of signature failures in production.
    const expected = createHmac('sha512', SECRET_KEY).update(req.body).digest('hex');
    const received = req.get('x-paystack-signature') ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(received, 'utf8');

    if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
      console.warn('✗ rejected a webhook with a bad signature');
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString('utf8'));

    // Acknowledge immediately. Paystack times out after 30 seconds and retries;
    // slow handlers turn one payment into a pile of duplicate deliveries.
    res.sendStatus(200);

    // Idempotency. paybox will happily deliver this twice
    // (`paybox webhook chaos --duplicate true`) — as will Paystack.
    const key = `${event.event}:${event.data?.reference ?? event.data?.id}`;
    if (processedEvents.has(key)) {
      console.log(`↺ duplicate ${event.event} for ${key} — ignored`);
      return;
    }
    processedEvents.add(key);

    if (event.event === 'charge.success') {
      void grantValue(event.data.reference);
    }
    if (event.event === 'refund.processed') {
      console.log(`↩ refund processed: ${event.data.amount}`);
    }
  },
);

app.use(express.json());

/**
 * Never grant value on the webhook payload alone. Verify first — it is the
 * only source of truth, and it is what protects you if a webhook is ever
 * forged or replayed.
 */
async function grantValue(reference) {
  const transaction = await paystack(`/transaction/verify/${reference}`);
  if (transaction.status !== 'success') {
    console.log(`… ${reference} is ${transaction.status}, not granting value`);
    return;
  }
  const order = orders.get(reference);
  if (order?.fulfilled) return;
  orders.set(reference, { ...order, fulfilled: true, amount: transaction.amount });
  console.log(`✓ fulfilled ${reference} — ${transaction.currency} ${transaction.amount / 100}`);
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>paybox example shop</h1>
    <form method="POST" action="/checkout">
      <button>Buy a thing — GHS 100.00</button>
    </form>
    <h2>Orders</h2>
    <pre>${JSON.stringify([...orders.entries()], null, 2)}</pre>`);
});

app.post('/checkout', async (_req, res) => {
  const reference = `order_${Date.now()}`;
  const init = await paystack('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: 'customer@example.com',
      amount: 10_000,
      currency: 'GHS',
      reference,
      callback_url: `http://localhost:${PORT}/return`,
    }),
  });
  orders.set(reference, { reference, fulfilled: false });
  res.redirect(init.authorization_url);
});

app.get('/return', async (req, res) => {
  const { reference } = req.query;
  // The customer may arrive back before the webhook does — verify here too.
  const transaction = await paystack(`/transaction/verify/${reference}`);
  if (transaction.status === 'success') await grantValue(String(reference));
  res.type('html').send(`
    <h1>${transaction.status === 'success' ? 'Thank you' : 'Payment ' + transaction.status}</h1>
    <p>${transaction.gateway_response}</p>
    <a href="/">Back</a>`);
});

app.listen(PORT, () => {
  console.log(`example shop  http://localhost:${PORT}`);
  console.log(`paystack via  ${PAYSTACK_BASE_URL}`);
});
