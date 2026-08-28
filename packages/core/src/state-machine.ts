import {
  PayboxError,
  TERMINAL_STATUSES,
  type DisputeStatus,
  type InvoiceStatus,
  type PaymentStatus,
  type RefundStatus,
  type SubscriptionStatus,
  type TransferStatus,
} from '@paybox/shared';

/**
 * Explicit payment state machine (spec §7).
 *
 * Data, not code: the whole legality question is this table, which makes it
 * trivially testable and means an illegal transition is impossible to reach by
 * accident from anywhere in the engine.
 *
 *   created ──> pending ──> processing ──┬─> successful ──> partially_refunded
 *      │           │            │        │                        │
 *      │           ├─> requires_action   └─> failed               └─> refunded
 *      │           │        │
 *      │           └─> authorized ──> processing (capture)
 *      │
 *      └──> cancelled / expired
 */
const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['pending', 'processing', 'requires_action', 'failed', 'cancelled', 'expired'],
  pending: [
    'processing',
    'requires_action',
    'authorized',
    'successful',
    'failed',
    'cancelled',
    'expired',
  ],
  processing: ['requires_action', 'authorized', 'successful', 'failed', 'expired'],
  requires_action: ['processing', 'authorized', 'successful', 'failed', 'cancelled', 'expired'],
  // authorized -> processing is the capture path; authorized -> cancelled is a void.
  authorized: ['processing', 'successful', 'failed', 'cancelled', 'expired'],
  successful: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  // Terminal. `failed -> successful` is reachable only via an explicit
  // provider-reversal simulation, which goes through `forceTransition`.
  failed: [],
  cancelled: [],
  expired: [],
  refunded: [],
};

/**
 * Refund lifecycle.
 *
 *   pending ──> processing ──┬─> successful
 *      │            │        └─> failed
 *      │            └─> needs_attention ──> processing | successful | failed
 *      └─> needs_attention
 *
 * `needs_attention` is recoverable: supplying bank details puts the refund
 * back on the processing path. Modelling it as terminal would make the
 * recovery flow -- the one a merchant actually has to build -- untestable.
 */
const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ['processing', 'needs_attention', 'successful', 'failed'],
  processing: ['needs_attention', 'successful', 'failed'],
  needs_attention: ['processing', 'successful', 'failed'],
  successful: [],
  failed: [],
};

const TRANSFER_TRANSITIONS: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
  created: ['pending', 'processing', 'failed'],
  pending: ['processing', 'successful', 'failed'],
  processing: ['successful', 'failed', 'reversed'],
  successful: ['reversed'],
  failed: [],
  reversed: [],
};

/**
 * Subscription lifecycle.
 *
 *   active ──> non_renewing ──> completed | cancelled
 *      │                            
 *      ├──> attention ──> active (the merchant fixed the instrument)
 *      └──> completed | cancelled
 *
 * `attention` is not terminal: a failed renewal is recoverable, and modelling
 * it as terminal would make the recovery path -- the one a merchant actually
 * has to build -- untestable.
 */
const SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  active: ['non_renewing', 'attention', 'completed', 'cancelled'],
  non_renewing: ['completed', 'cancelled', 'active'],
  attention: ['active', 'non_renewing', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** One billing attempt: raised, then either paid or not. */
const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  pending: ['success', 'failed'],
  success: [],
  failed: [],
};

export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  if (from !== to && SUBSCRIPTION_TRANSITIONS[from].includes(to)) return;
  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move a subscription from ${from} to ${to}. Allowed: ${
      SUBSCRIPTION_TRANSITIONS[from].join(', ') || 'none (terminal)'
    }.`,
    { details: { from, to, allowed: SUBSCRIPTION_TRANSITIONS[from] } },
  );
}

export function assertInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (from !== to && INVOICE_TRANSITIONS[from].includes(to)) return;
  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move an invoice from ${from} to ${to}. Allowed: ${
      INVOICE_TRANSITIONS[from].join(', ') || 'none (terminal)'
    }.`,
    { details: { from, to, allowed: INVOICE_TRANSITIONS[from] } },
  );
}

/** A subscription only renews while it is in one of these states. */
export function isRenewable(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'attention';
}

/**
 * Dispute lifecycle.
 *
 *   awaiting_merchant_feedback ──> awaiting_bank_feedback ──> resolved
 *              │                            │
 *              └──> pending ────────────────┘
 *
 * `resolved` is terminal: a reopened chargeback is a new dispute at every
 * provider we model, not a revived one.
 */
const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  awaiting_merchant_feedback: ['awaiting_bank_feedback', 'pending', 'resolved'],
  awaiting_bank_feedback: ['pending', 'resolved'],
  pending: ['awaiting_bank_feedback', 'resolved'],
  resolved: [],
};

export function assertDisputeTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (from !== to && DISPUTE_TRANSITIONS[from].includes(to)) return;
  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move a dispute from ${from} to ${to}. Allowed: ${
      DISPUTE_TRANSITIONS[from].join(', ') || 'none (terminal)'
    }.`,
    { details: { from, to, allowed: DISPUTE_TRANSITIONS[from] } },
  );
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function nextPaymentStates(from: PaymentStatus): readonly PaymentStatus[] {
  return PAYMENT_TRANSITIONS[from];
}

export function isTerminalPayment(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface TransitionContext {
  /** Set only by an explicitly simulated provider reversal (spec §7). */
  reversal?: boolean;
}

export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  context: TransitionContext = {},
): void {
  if (from === to) {
    throw new PayboxError(
      'invalid_state_transition',
      `Payment is already ${from}.`,
      { details: { from, to } },
    );
  }
  if (canTransitionPayment(from, to)) return;

  // The one documented escape hatch. A real provider can reverse a decision
  // (late settlement, chargeback reversal), so we model it -- but only when a
  // caller has explicitly asked to simulate that, never as ordinary flow.
  if (context.reversal && isTerminalPayment(from)) return;

  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move a payment from ${from} to ${to}.` +
      (PAYMENT_TRANSITIONS[from].length === 0
        ? ` ${from} is terminal; use a reversal simulation to override.`
        : ` Allowed: ${PAYMENT_TRANSITIONS[from].join(', ')}.`),
    { details: { from, to, allowed: PAYMENT_TRANSITIONS[from] } },
  );
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (from !== to && REFUND_TRANSITIONS[from].includes(to)) return;
  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move a refund from ${from} to ${to}. Allowed: ${
      REFUND_TRANSITIONS[from].join(', ') || 'none (terminal)'
    }.`,
    { details: { from, to, allowed: REFUND_TRANSITIONS[from] } },
  );
}

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (from !== to && TRANSFER_TRANSITIONS[from].includes(to)) return;
  throw new PayboxError(
    'invalid_state_transition',
    `Cannot move a transfer from ${from} to ${to}. Allowed: ${
      TRANSFER_TRANSITIONS[from].join(', ') || 'none (terminal)'
    }.`,
    { details: { from, to, allowed: TRANSFER_TRANSITIONS[from] } },
  );
}

/**
 * Refund arithmetic (spec §18). Enforces total_refunded <= original_amount.
 */
export function assertRefundable(
  paymentAmount: number,
  alreadyRefunded: number,
  requested: number,
): void {
  if (requested <= 0) {
    throw new PayboxError('validation_failed', 'Refund amount must be greater than zero.', {
      details: { requested },
    });
  }
  const remaining = paymentAmount - alreadyRefunded;
  if (requested > remaining) {
    throw new PayboxError(
      'refund_exceeds_amount',
      `Refund of ${requested} exceeds the ${remaining} still refundable on this payment.`,
      { details: { paymentAmount, alreadyRefunded, requested, remaining } },
    );
  }
}

/** Which status a payment lands in once a refund of `refunded` total settles. */
export function refundedStatus(
  paymentAmount: number,
  totalRefunded: number,
): Extract<PaymentStatus, 'refunded' | 'partially_refunded'> {
  return totalRefunded >= paymentAmount ? 'refunded' : 'partially_refunded';
}
