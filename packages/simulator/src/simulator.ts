import {
  PayboxError,
  type Clock,
  type Metadata,
  type Payment,
  type PaymentStatus,
} from '@paybox/shared';
import type { PaymentEngine } from '@paybox/core';
import type { SimulatedOutcome } from './instruments.js';

/** Job kind used to play an instrument's outcome out over virtual time. */
export const PAYMENT_SIMULATE_JOB = 'payment.simulate';

export interface SimulationOptions {
  /** Provider-specific status to record alongside the canonical one. */
  providerStatus?: string;
  /** Extra detail merged onto the payment's method details. */
  paymentMethodDetails?: Metadata;
  /** Skip the intermediate `processing` hop and jump to the outcome. */
  immediate?: boolean;
}

/** How each outcome maps onto real state transitions (spec §11). */
interface OutcomePlan {
  /** Statuses to pass through, in order. */
  path: PaymentStatus[];
  failureCode?: string;
  failureMessage?: string;
}

const PLANS: Record<SimulatedOutcome, OutcomePlan> = {
  success: { path: ['processing', 'successful'] },
  declined: {
    path: ['processing', 'failed'],
    failureCode: 'card_declined',
    failureMessage: 'The card was declined by the issuer.',
  },
  insufficient_funds: {
    path: ['processing', 'failed'],
    failureCode: 'insufficient_funds',
    failureMessage: 'Insufficient funds.',
  },
  expired_card: {
    path: ['failed'],
    failureCode: 'expired_card',
    failureMessage: 'The card has expired.',
  },
  // Stops at requires_action deliberately: the developer's integration is
  // supposed to notice and surface an authentication step. Completing it is a
  // second, explicit call -- which is exactly the flow they need to test.
  authentication_required: { path: ['requires_action'] },
  authentication_failed: {
    path: ['requires_action', 'failed'],
    failureCode: 'authentication_required',
    failureMessage: 'Authentication failed.',
  },
  timeout: {
    path: ['requires_action'],
  },
  customer_rejected: {
    path: ['requires_action', 'failed'],
    failureCode: 'authorization_rejected',
    failureMessage: 'The customer rejected the payment request.',
  },
  processing_error: {
    path: ['processing', 'failed'],
    failureCode: 'provider_error',
    failureMessage: 'The provider returned an error.',
  },
  network_error: {
    path: ['failed'],
    failureCode: 'network_error',
    failureMessage: 'The connection dropped during authorization.',
  },
};

/**
 * Drives a payment through real state transitions to reach a requested
 * outcome (spec §11).
 *
 * Deliberately not a shortcut: every outcome walks the state machine, appends
 * the same events, and triggers the same webhooks as the equivalent organic
 * flow. `simulate success` and a card that happens to succeed are the same
 * code path, which is the difference between an emulator and a mock (§46).
 */
export class PaymentSimulator {
  readonly #engine: PaymentEngine;
  readonly #clock: Clock;

  constructor(deps: { engine: PaymentEngine; clock: Clock }) {
    this.#engine = deps.engine;
    this.#clock = deps.clock;
  }

  async apply(
    paymentId: string,
    outcome: SimulatedOutcome,
    options: SimulationOptions = {},
  ): Promise<Payment> {
    const plan = PLANS[outcome];
    if (!plan) {
      throw new PayboxError('invalid_request', `Unknown simulation outcome "${outcome}".`);
    }

    const path = options.immediate ? plan.path.slice(-1) : plan.path;
    let payment = await this.#require(paymentId);

    for (const [index, status] of path.entries()) {
      // Skip a hop the payment has already made -- re-simulating success on a
      // payment that is already processing should not fail on a self-transition.
      if (payment.status === status) continue;
      const isLast = index === path.length - 1;
      payment = await this.#engine.transitionPayment(payment.id, status, {
        ...(options.providerStatus && isLast ? { providerStatus: options.providerStatus } : {}),
        ...(isLast && plan.failureCode
          ? { failureCode: plan.failureCode, failureMessage: plan.failureMessage ?? null }
          : {}),
        ...(options.paymentMethodDetails
          ? { paymentMethodDetails: options.paymentMethodDetails }
          : {}),
        eventData: { simulated: true, outcome },
      });
    }

    return payment;
  }

  /* Direct actions used by the CLI, the dashboard and the checkout page. */

  async succeed(paymentId: string, options: SimulationOptions = {}): Promise<Payment> {
    return this.apply(paymentId, 'success', options);
  }

  async fail(
    paymentId: string,
    reason: SimulatedOutcome = 'declined',
    options: SimulationOptions = {},
  ): Promise<Payment> {
    return this.apply(paymentId, reason, options);
  }

  async cancel(paymentId: string): Promise<Payment> {
    return this.#engine.transitionPayment(paymentId, 'cancelled', {
      eventData: { simulated: true, outcome: 'cancelled' },
    });
  }

  async expire(paymentId: string): Promise<Payment> {
    return this.#engine.transitionPayment(paymentId, 'expired', {
      failureCode: 'transaction_timeout',
      failureMessage: 'The payment was not completed before it expired.',
      eventData: { simulated: true, outcome: 'expired' },
    });
  }

  async authorize(paymentId: string): Promise<Payment> {
    return this.#engine.transitionPayment(paymentId, 'authorized', {
      eventData: { simulated: true, outcome: 'authorized' },
    });
  }

  /** Capture an authorized payment (spec §7's authorize -> capture path). */
  async capture(paymentId: string): Promise<Payment> {
    const payment = await this.#require(paymentId);
    if (payment.status !== 'authorized') {
      throw new PayboxError(
        'invalid_state_transition',
        `Only an authorized payment can be captured; this one is ${payment.status}.`,
        { details: { paymentId, status: payment.status } },
      );
    }
    await this.#engine.transitionPayment(paymentId, 'processing', {
      eventData: { simulated: true, outcome: 'capture' },
    });
    return this.#engine.transitionPayment(paymentId, 'successful', {
      eventData: { simulated: true, outcome: 'capture' },
    });
  }

  /** Complete a pending authentication step (3-D Secure, OTP, momo prompt). */
  async completeAuthentication(paymentId: string, approved: boolean): Promise<Payment> {
    const payment = await this.#require(paymentId);
    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `This payment is not awaiting authentication; it is ${payment.status}.`,
        { details: { paymentId, status: payment.status } },
      );
    }
    return approved
      ? this.apply(paymentId, 'success')
      : this.apply(paymentId, 'customer_rejected');
  }

  async #require(paymentId: string): Promise<Payment> {
    const payment = await this.#engine.getPayment(paymentId);
    if (!payment) throw new PayboxError('not_found', `No payment with id ${paymentId}.`);
    return payment;
  }

  get now(): string {
    return this.#clock.nowISO();
  }
}
