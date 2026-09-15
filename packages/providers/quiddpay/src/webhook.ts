import type { PayboxEvent, Payment, Transfer } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import {
  QUIDDPAY_EVENT_ID_HEADER,
  QUIDDPAY_EVENT_TYPE_HEADER,
  quiddpaySignatureHeaders,
} from './signature.js';
import { ENVIRONMENT, LIVEMODE, serializeWebhookPayout, serializeWebhookSession } from './serializers.js';
import { toAttemptStatus, toQuiddpaySessionStatus } from './status.js';

/**
 * The metadata marker a test-simulated attempt leaves behind.
 *
 * Quid publishes a second family of events — `test.payment.*` — alongside the
 * checkout ones, carrying `data.test_payment` rather than `data.session`. They
 * describe what the *test simulator* decided, so they must fire only for a
 * payment driven through `POST /api/v1/test/payment-attempts/{ref}/simulate`
 * and never for an ordinary hosted checkout, which would otherwise double-fire
 * for every payer.
 *
 * The marker is the same device the Flutterwave v4 adapter uses for its API
 * version: the route records it, the formatter reads it, and `publicMetadata`
 * strips it from anything echoed back to the merchant.
 */
export const TEST_OUTCOME_KEY = 'quiddpay_test_outcome';
export const TEST_ATTEMPT_KEY = 'quiddpay_test_attempt';
export const TEST_RAIL_KEY = 'quiddpay_test_rail';

/**
 * Canonical event -> Quid Payments webhook.
 *
 * Verified at `docs.quiddpayments.com/webhooks` and against the
 * `MerchantWebhookEvent` / `MerchantWebhookEventType` components of the
 * published OpenAPI document (contract `2026-06`, both read 2026-09-15).
 *
 * Quid sends **final** payment events only. There is deliberately no
 * `checkout.session.pending` and no per-attempt checkout event, because Quid
 * does not send one: its guide tells a merchant to wait, and a merchant
 * backend that could subscribe to a pending event here would be building
 * against something that never arrives in production. Where a provider does
 * not do something, neither does paybox.
 *
 * Two families share the transport:
 *
 *   checkout.session.*  final state of a session; `data.session`
 *   payout.*            every payout transition; `data.payout`
 *   test.payment.*      what the test simulator decided; `data.test_payment`
 *
 * A finalising simulated attempt produces **both** a `checkout.session.*` and
 * a `test.payment.*` event from one canonical event — the fan-out seam Stripe
 * needed first. Each becomes its own delivery matched against endpoints by its
 * own type, so a subscriber to only `checkout.session.completed` receives only
 * that.
 */
export class QuiddpayWebhookFormatter implements WebhookFormatter {
  readonly provider = 'quiddpay' as const;

  /**
   * The signature covers `<t>.<body>`, so it moves with the attempt. Replaying
   * a stale one would fail any correct verifier's five-minute tolerance
   * window — teaching a developer to work around a bug the emulator invented.
   */
  readonly resignsPerAttempt = true;

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | FormattedWebhook[] | null> {
    const { storage } = context;

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment || payment.provider !== this.provider) return null;
      return this.#sessionEvents(event, payment);
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      if (!transfer || transfer.provider !== this.provider) return null;
      return this.#payoutEvent(event, transfer);
    }

    return null;
  }

  /** The final state of a checkout session, plus any test-simulator echo. */
  #sessionEvents(event: PayboxEvent, payment: Payment): FormattedWebhook[] | null {
    const eventType = {
      'payment.successful': 'checkout.session.completed',
      'payment.failed': 'checkout.session.failed',
      'payment.expired': 'checkout.session.expired',
      // A cancelled session is a failed one at Quid: `CheckoutSessionStatusEnum`
      // has no cancelled member, and the reason lives on the attempt.
      'payment.cancelled': 'checkout.session.failed',
    }[event.type];
    if (!eventType) return null;

    const webhooks: FormattedWebhook[] = [
      this.#envelope(eventType, event.id, { session: serializeWebhookSession(payment) }),
    ];

    const outcome = payment.metadata[TEST_OUTCOME_KEY];
    if (typeof outcome === 'string') {
      webhooks.push(
        this.#envelope(`test.payment.${outcome}`, `${event.id}_test`, {
          test_payment: {
            payment_reference: String(payment.metadata[TEST_ATTEMPT_KEY] ?? ''),
            session_reference: payment.providerTransactionId,
            outcome,
            status: toAttemptStatus(payment.status),
            rail: String(payment.metadata[TEST_RAIL_KEY] ?? ''),
            amount_minor: payment.amount,
            currency: payment.currency,
            // Always true here, and true of Quid's test mode too: "test
            // payments are synthetic: they never contact a bank, wallet,
            // teller, or live settlement system."
            synthetic: true,
          },
        }),
      );
    }

    return webhooks;
  }

  /**
   * Every payout transition, unlike sessions.
   *
   * Quid publishes six payout events covering the whole lifecycle, so a
   * merchant can follow a payout rather than only learn its ending — and it
   * warns that "a paid payout can later be returned", which is why
   * `transfer.reversed` maps to `payout.returned` rather than being dropped as
   * an after-the-fact correction.
   */
  #payoutEvent(event: PayboxEvent, transfer: Transfer): FormattedWebhook | null {
    const eventType = {
      'transfer.created': 'payout.requested',
      'transfer.pending': 'payout.requested',
      'transfer.processing': 'payout.processing',
      'transfer.successful': 'payout.paid',
      'transfer.failed': 'payout.failed',
      'transfer.cancelled': 'payout.cancelled',
      'transfer.reversed': 'payout.returned',
    }[event.type];
    if (!eventType) return null;

    // Quid states these carry no session and no `client_reference`. The
    // omission is the contract, so `serializeWebhookPayout` is a narrower
    // shape than the payout object the API returns rather than the same one.
    return this.#envelope(eventType, event.id, { payout: serializeWebhookPayout(transfer) });
  }

  /** `MerchantWebhookEvent`, plus the two headers that repeat its id and type. */
  #envelope(
    eventType: string,
    eventId: string,
    data: Record<string, unknown>,
  ): FormattedWebhook {
    return {
      eventType,
      body: {
        id: eventId,
        type: eventType,
        environment: ENVIRONMENT,
        livemode: LIVEMODE,
        data,
      },
      // Static for the life of the delivery, so they are set here rather than
      // in `sign()`: the dispatcher replays stored headers and recomputes only
      // the signature, which keeps the id Quid tells consumers to deduplicate
      // on stable across every retry.
      headers: {
        [QUIDDPAY_EVENT_ID_HEADER]: eventId,
        [QUIDDPAY_EVENT_TYPE_HEADER]: eventType,
      },
    };
  }

  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    return quiddpaySignatureHeaders(rawBody, secret, context.timestamp);
  }
}

/** Exported for the status test; keeps the session mapping in one place. */
export function sessionStatus(payment: Payment): string {
  return toQuiddpaySessionStatus(payment.status);
}
