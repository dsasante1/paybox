import type { Customer, Payment, PayboxEvent, Refund, Transfer } from '@paybox/shared';
import type { FormattedWebhook, FormatterContext } from '@paybox/webhooks';
import { toKoraLikeId } from './ids.js';
import { publicMeta, serializeV4Customer, stamp } from './serializers.js';

/**
 * Flutterwave v4 webhooks.
 *
 * Verified 2026-08-30 against the guide at
 * developer.flutterwave.com/docs/webhooks, which shows one complete
 * `charge.completed` delivery, and the reference pages generated from
 * Flutterwave's OpenAPI document -- `reference/charge_completed_webhook`,
 * `reference/transfer_disburse_webhook`, `reference/transfer_reversal_webhook`
 * and `reference/refund_completed_webhook` -- which give each payload's
 * schema. docs/flutterwave.md says, field by field, what is transcribed from
 * which and what could not be grounded.
 *
 * The envelope is `{ webhook_id, timestamp, type, data }`. The guide's
 * example spells the first field `id`; all four reference schemas spell it
 * `webhook_id`, and the schema is what this adapter follows, for the same
 * reason the Paystack adapter follows its OpenAPI document over prose.
 *
 * `order.authorization` exists in the reference and is not emitted: paybox
 * models no orders. Where a provider does not send something, neither do we,
 * and where we cannot produce something it does, the contract says so.
 */
export const V4_EVENT_MAP: Record<string, string> = {
  'payment.successful': 'charge.completed',
  // v3's rule applied to v4: v3's docs are explicit that a failure is also
  // `charge.completed`, and v4's reference types `data.status` as free text
  // with no failure example. Recorded as unverified in docs/flutterwave.md.
  'payment.failed': 'charge.completed',
  'transfer.successful': 'transfer.disburse',
  'transfer.failed': 'transfer.disburse',
  'transfer.reversed': 'transfer.reversal',
  'refund.successful': 'refund.completed',
};

/** The resource behind a v4 event, loaded once by the formatter. */
export type V4Resource =
  | { kind: 'payment'; payment: Payment }
  | { kind: 'transfer'; transfer: Transfer }
  | { kind: 'refund'; refund: Refund; payment: Payment | null };

export async function formatV4Webhook(
  event: PayboxEvent,
  resource: V4Resource,
  context: FormatterContext,
): Promise<FormattedWebhook | null> {
  const type = V4_EVENT_MAP[event.type];
  if (!type) return null;

  const data = await buildData(resource, context);
  if (!data) return null;

  return {
    eventType: type,
    body: {
      webhook_id: toKoraLikeId('wbk', event.id),
      // The guide's example carries epoch milliseconds and the reference
      // types it int64. The event's own instant is virtual time, so a fixed
      // seed and a frozen clock reproduce it.
      timestamp: Date.parse(event.createdAt),
      type,
      data,
    },
    // Tells the dispatcher to hand `sign()` the v4 scheme for this body.
    variant: 'v4',
  };
}

async function buildData(resource: V4Resource, context: FormatterContext): Promise<unknown> {
  switch (resource.kind) {
    case 'payment': {
      const customer = resource.payment.customerId
        ? await context.storage.customers.byId(resource.payment.customerId)
        : null;
      return chargeData(resource.payment, customer);
    }
    case 'transfer':
      return transferData(resource.transfer);
    case 'refund':
      return refundData(resource.refund, resource.payment);
  }
}

/**
 * The guide's example reports a settled charge as `succeeded` -- v4's word,
 * not v3's `successful`. Only settlements and failures produce a webhook, so
 * the in-flight states never reach the wire; `pending` is the documented
 * initial value should one ever do.
 */
function chargeStatus(payment: Payment): string {
  switch (payment.status) {
    case 'successful':
    case 'partially_refunded':
    case 'refunded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

function chargeData(payment: Payment, customer: Customer | null) {
  const issuer = (payment.metadata.v4_issuer as string | undefined) ?? 'approved';
  return {
    id: toKoraLikeId('chg', payment.id),
    amount: payment.amount / 100,
    currency: payment.currency,
    // Expanded in the webhook, where the API response carries `customer_id`.
    customer: customer ? serializeV4Customer(customer) : null,
    description: (payment.metadata.description as string | undefined) ?? null,
    meta: publicMeta(payment.metadata),
    payment_method: paymentMethodBlock(payment),
    processor_response: {
      // The example shows `{ code: "00", type: "approved" }`. `type` is the
      // issuer response the scenario key asked for. `00` is the one code the
      // documentation shows; no declined code is documented, and a null is
      // more honest than a plausible-looking invention.
      code: payment.status === 'failed' ? null : '00',
      type: issuer,
    },
    redirect_url: payment.callbackUrl,
    reference: payment.reference,
    status: chargeStatus(payment),
    created_datetime: stamp(payment.createdAt),
  };
}

/**
 * The instrument, expanded the way the guide's example expands it, and
 * carrying the same `pmd_` id the API handed out for it (recorded on the
 * charge at creation as `v4_payment_method`).
 */
function paymentMethodBlock(payment: Payment) {
  if (!payment.paymentMethod) return null;
  const details = payment.paymentMethodDetails;
  const methodId = (payment.metadata.v4_payment_method as string | undefined) ?? payment.id;
  return {
    id: toKoraLikeId('pmd', methodId),
    type: payment.paymentMethod === 'card' ? 'card' : payment.paymentMethod,
    ...(payment.paymentMethod === 'card'
      ? {
          card: {
            expiry_month: Number(details.exp_month ?? 12),
            expiry_year: Number(details.exp_year ?? 32),
            first6: details.bin ?? null,
            last4: details.last4 ?? null,
            network: String(details.brand ?? 'mastercard').toLowerCase(),
          },
        }
      : {}),
    customer_id: payment.customerId ? toKoraLikeId('cus', payment.customerId) : null,
    client_ip: null,
    device_fingerprint: null,
    meta: {},
    created_datetime: stamp(payment.createdAt),
  };
}

/**
 * `transfer.disburse` and `transfer.reversal` share one object; the reversal
 * adds a `reversal` block. Only the fields the emulator can ground are sent:
 * v4 transfers here resolve no destination, so the recipient objects,
 * `debit_information`, `payment_information` and `proof` have no honest value.
 */
function transferData(transfer: Transfer) {
  const failed = transfer.status === 'failed' || transfer.status === 'cancelled';
  const reversed = transfer.status === 'reversed';
  return {
    id: toKoraLikeId('trf', transfer.id),
    type: 'bank',
    source_currency: transfer.currency,
    // No FX happens in the engine, so the two are always equal.
    destination_currency: transfer.currency,
    amount: transfer.amount / 100,
    reference: transfer.reference,
    // The schema's enum: a reversed transfer *was* successful, and says so
    // in the `reversal` block rather than here.
    status: failed ? 'FAILED' : 'SUCCESSFUL',
    disburse_datetime: stamp(transfer.updatedAt),
    fee: { currency: transfer.currency, value: 0 },
    meta: publicMeta(transfer.metadata),
    ...(failed
      ? { provider_response: { message: transfer.failureReason ?? 'The transfer failed.' } }
      : {}),
    ...(reversed
      ? {
          reversal: {
            reversal_datetime: stamp(transfer.updatedAt),
            initial_status: 'SUCCESSFUL',
            reconciliation_status: 'REVERSED',
          },
        }
      : {}),
  };
}

/** The `refund.completed` schema: `amount_refunded`, not `amount`, and no currency. */
function refundData(refund: Refund, payment: Payment | null) {
  return {
    id: toKoraLikeId('rfd', refund.id),
    amount_refunded: refund.amount / 100,
    reason: refund.reason ?? null,
    status: refund.status === 'successful' ? 'succeeded' : refund.status,
    charge_id: payment ? toKoraLikeId('chg', payment.id) : null,
    meta: publicMeta(refund.metadata),
    created_datetime: stamp(refund.createdAt),
  };
}
