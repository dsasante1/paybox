import type { PayboxEvent, Payment, Transfer } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { wewireSignatureHeaders } from './signature.js';
import { africaFailureReason, toWewireStatus, toWewireTransferStatus } from './status.js';
import { serializeAfrica, serializeWebhookTransaction, walletIdFor } from './serializers.js';

/**
 * Canonical event -> WeWire webhook.
 *
 * Verified at docs.wewire.com/working-with-the-api/webhooks and
 * /ghana/webhooks (read 2026-08-29).
 *
 * WeWire is the first adapter where the event *name* depends on the corridor
 * rather than on the resource. The same canonical `transfer.successful`
 * becomes `disbursement.completed` for a Ghana payout and
 * `transaction.status_updated` for an offshore one, because those are two
 * different products with two different payload shapes. The corridor is
 * recorded on the transfer's metadata at creation, so the formatter reads it
 * rather than guessing from the currency.
 *
 * Two deliberate absences, both stated in docs/wewire.md:
 *
 *   transaction.pay_in    Fires when a virtual account is credited. paybox
 *                         does not provision WeWire virtual accounts, so
 *                         nothing can produce it. Emitting it for a Ghana
 *                         collection would be wrong -- WeWire sends
 *                         `collection.completed` for that.
 *   subcustomer.*         paybox has no KYC review lifecycle to report on.
 */
export class WewireWebhookFormatter implements WebhookFormatter {
  readonly provider = 'wewire' as const;

  /**
   * Standard Webhooks signs `{id}.{timestamp}.{body}`, so the signature moves
   * with the attempt and a stale one would fail any correct verifier's
   * five-minute tolerance window.
   */
  readonly resignsPerAttempt = true;

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | FormattedWebhook[] | null> {
    const { storage } = context;

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      if (!transfer || transfer.provider !== this.provider) return null;
      return this.#transferEvent(event, transfer);
    }

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment || payment.provider !== this.provider) return null;
      return this.#paymentEvent(event, payment);
    }

    return null;
  }

  /** A payout: Ghana disbursement or offshore wallet transaction. */
  #transferEvent(event: PayboxEvent, transfer: Transfer): FormattedWebhook | null {
    const ghana = transfer.metadata.corridor === 'GH';

    if (ghana) {
      const eventType = {
        'transfer.created': 'disbursement.initiated',
        'transfer.processing': 'disbursement.initiated',
        'transfer.successful': 'disbursement.completed',
        'transfer.failed': 'disbursement.failed',
        'transfer.reversed': 'disbursement.failed',
      }[event.type];
      if (!eventType) return null;

      const failed = eventType === 'disbursement.failed';
      return {
        eventType,
        body: {
          eventType,
          data: serializeAfrica(
            transfer,
            {
              type: 'DISBURSEMENT',
              status: failed ? 'FAILED' : eventType === 'disbursement.completed' ? 'SUCCESSFUL' : 'PENDING',
              amount: transfer.amount,
              channel: String(transfer.metadata.channel ?? 'MOBILE_MONEY'),
              accountCode: transfer.recipientBankCode ?? '',
              accountNumber: transfer.recipientAccount ?? '',
              accountName: transfer.recipientName,
              memo: transfer.reason,
            },
            {
              reason: failed ? (transfer.failureReason ?? 'The rail rejected the transfer') : null,
              // The Africa webhook payload carries the settlement instant.
              occurredAt: transfer.updatedAt,
            },
          ),
        },
      };
    }

    // Offshore. `transaction.status_updated` fires "on any status
    // transition", so every transfer event maps to the one name and the
    // consumer branches on `status` -- which is what the docs tell them to do.
    if (
      event.type !== 'transfer.processing' &&
      event.type !== 'transfer.successful' &&
      event.type !== 'transfer.failed' &&
      event.type !== 'transfer.reversed'
    ) {
      return null;
    }

    return {
      eventType: 'transaction.status_updated',
      body: {
        eventType: 'transaction.status_updated',
        data: serializeWebhookTransaction({
          id: transfer.id,
          amount: transfer.amount,
          fee: 0,
          currency: transfer.currency,
          reference: transfer.reference,
          status: toWewireTransferStatus(transfer.status),
          type: 'DEBIT',
          // The webhook example says `PAYOUT` where the API object says
          // `AUTOMATED_PAYOUT`. Both are transcribed as published.
          channel: 'PAYOUT',
          description: transfer.reason,
          memo: transfer.reason,
          purpose: (transfer.metadata.purpose_code as string | undefined) ?? null,
          walletId: walletIdFor(transfer.sourceSubaccountId, transfer.currency),
          subCustomerId: transfer.sourceSubaccountId,
          createdAt: transfer.createdAt,
          updatedAt: transfer.updatedAt,
        }),
      },
    };
  }

  /** A collection on the Ghana corridor. */
  #paymentEvent(event: PayboxEvent, payment: Payment): FormattedWebhook | null {
    const eventType = {
      'payment.successful': 'collection.completed',
      'payment.failed': 'collection.failed',
      'payment.expired': 'collection.failed',
    }[event.type];
    if (!eventType) return null;

    const failed = eventType === 'collection.failed';
    const details = payment.paymentMethodDetails;
    const text = (key: string): string =>
      typeof details[key] === 'string' ? (details[key] as string) : '';

    return {
      eventType,
      body: {
        eventType,
        data: serializeAfrica(
          payment,
          {
            type: 'COLLECTION',
            status: failed ? 'FAILED' : 'SUCCESSFUL',
            amount: payment.amount,
            channel: String(payment.metadata.channel ?? 'MOBILE_MONEY'),
            accountCode: text('account_code'),
            accountNumber: text('account_number'),
            accountName: text('account_name') || null,
            memo: (payment.metadata.memo as string | undefined) ?? null,
          },
          {
            // Never the simulator's wording: its `declined` outcome says
            // "The card was declined by the issuer", which is nonsense on a
            // mobile-money prompt. The adapter translates.
            reason: failed ? africaFailureReason(payment.failureCode) : null,
            occurredAt: payment.updatedAt,
          },
        ),
      },
    };
  }

  /**
   * Standard Webhooks headers.
   *
   * `context.timestamp` is the virtual-time instant of *this attempt*, so a
   * retry after `paybox time advance 10m` carries a fresh timestamp and a
   * fresh signature — exactly as a real WeWire retry would, and exactly what a
   * consumer's tolerance check needs in order to be worth testing.
   */
  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    return wewireSignatureHeaders(rawBody, secret, context.timestamp);
  }
}

/** Exported for the status test; keeps the mapping in one place. */
export function collectionStatus(payment: Payment): string {
  return toWewireStatus(payment.status);
}
