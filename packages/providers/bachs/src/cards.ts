import { createHash } from 'node:crypto';
import type { Authorization, Clock, Customer, IdFactory } from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { fail } from './errors.js';
import { hexId } from './ids.js';
import { customerLock, withLock } from './locks.js';
import type { BachsState, StoredPaymentMethod } from './state.js';

const PROVIDER = 'bachs' as const;

/**
 * Saved cards (docs.bachs.io/guides/payments/charge-a-saved-card, read
 * 2026-10-10).
 *
 * A saved card is a core Authorization -- the instrument paybox's dashboard,
 * CLI and generic tooling already understand -- and its `pm_` id is that
 * row's provider authorization code. This file holds the Bachs remainder: the
 * card's own currency, whether it is the customer's default, and what charging
 * it later does.
 *
 * Cards are saved only when a checkout asks (`save_payment_method`, or a
 * subscription checkout), never as a side effect of every card payment, which
 * is why Bachs is deliberately absent from the composition root's
 * payment-path authorization minter.
 */

/**
 * Bachs' sandbox cards (integrate/sandbox and charge-a-saved-card). The first
 * four are refused at the time of payment; 0341 is accepted, saved, and then
 * declined by every later off-session charge -- "the case most integrations
 * get wrong, because it only goes wrong long after the customer has gone".
 */
export const TEST_CARDS: Record<string, { failureCode: string; message: string }> = {
  '4000000000000002': { failureCode: 'card_declined', message: 'Your card was declined.' },
  '4000000000009995': { failureCode: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  '4000000000000069': { failureCode: 'expired_card', message: 'Your card has expired.' },
  '4000000000000119': { failureCode: 'provider_error', message: 'An error occurred while processing your card.' },
};
export const DECLINES_LATER = '4000000000000341';

/** The message an off-session charge on a 0341 card fails with. */
export const SAVED_CARD_DECLINE = { failureCode: 'card_declined', message: 'Your card was declined.' };

export function cardBrand(number: string): string {
  return number.startsWith('4') ? 'visa' : number.startsWith('5') ? 'mastercard' : 'card';
}

/**
 * A card's fingerprint: stable for one number, revealing nothing of it. The
 * number itself is never stored (spec §29); this is what lets "the same card
 * saved twice" resolve to one `pm_`.
 */
export function cardFingerprint(number: string): string {
  return createHash('sha256').update(`bachs-card:${number}`).digest('hex').slice(0, 32);
}

/** What the hosted page learnt about a card, minus the number itself. */
export interface CardFacts {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  fingerprint: string;
  behaviour: StoredPaymentMethod['behaviour'];
}

/**
 * A card past its expiry month is refused when it is entered, as a card form
 * would. Without this, typing an old date over a card already saved would
 * make that card unusable for every subscription it pays.
 */
export function assertNotExpired(expMonth: number, expYear: number, now: number): void {
  if (now >= Date.UTC(expYear, expMonth, 1)) {
    throw fail('validation_failed', 'PAYMENT_ERROR', 'Your card has expired.');
  }
}

export function cardFacts(number: string, expMonth: number, expYear: number): CardFacts {
  return {
    brand: cardBrand(number),
    last4: number.slice(-4),
    expMonth,
    expYear,
    fingerprint: cardFingerprint(number),
    behaviour: number === DECLINES_LATER ? 'declines' : 'succeeds',
  };
}

/** The `card_*` facts a payment carries, so a card saved after it settles has them. */
export function factsFromDetails(details: Record<string, unknown>): CardFacts | null {
  const fingerprint = details.card_fingerprint;
  if (typeof fingerprint !== 'string') return null;
  if (details.corridor !== 'USD_CARD' && details.corridor !== 'NGN_CARD') return null;
  return {
    brand: String(details.brand ?? 'card'),
    last4: String(details.last4 ?? ''),
    expMonth: Number(details.exp_month ?? 12),
    expYear: Number(details.exp_year ?? 2034),
    fingerprint,
    behaviour: details.card_behaviour === 'declines' ? 'declines' : 'succeeds',
  };
}

export interface CardDeps {
  engine: PaymentEngine;
  storage: Storage;
  state: BachsState;
  clock: Clock;
  ids: IdFactory;
}

/**
 * Save a card against a customer, or return the one already saved.
 *
 * "The first card a customer saves becomes their default." Saving the same
 * card twice keeps one `pm_` and sends one `payment_method.saved`: the core
 * dedupe by fingerprint returns the existing row without an event, and the
 * check here runs first so the default is never pointed at an id that was
 * never created. Serialised per customer, so two saves cannot both become
 * the default.
 */
export async function saveCard(
  deps: CardDeps,
  input: { customer: Customer; facts: CardFacts; currency: string; paymentId: string | null },
): Promise<StoredPaymentMethod> {
  return withLock(customerLock(input.customer.id), async () => {
    const { engine, storage, state } = deps;
    const existing = await storage.authorizations.bySignature(
      PROVIDER,
      input.facts.fingerprint,
      input.customer.id,
    );
    if (existing) {
      let stored = await state.paymentMethods.get(existing.providerAuthorizationCode);
      if (stored) {
        // An earlier save stopped between creating the card and linking it.
        if (stored.engineId !== existing.id) {
          stored = { ...stored, engineId: existing.id };
          await state.paymentMethods.put(stored);
        }
        // The same card, saved again: reissued with a later expiry, or saved
        // after paybox's tooling removed it. Still one `pm_`, now current --
        // recorded as an event, because the event log is the source of truth
        // for an authorization's state.
        const expMonth = String(input.facts.expMonth).padStart(2, '0');
        const expYear = String(input.facts.expYear);
        const later =
          input.facts.expYear * 12 + input.facts.expMonth > Number(existing.expYear) * 12 + Number(existing.expMonth);
        if (later || !existing.active) {
          const now = deps.clock.nowISO();
          await engine.recordEvent({
            provider: PROVIDER,
            type: 'authorization.updated',
            resourceType: 'authorization',
            resourceId: existing.id,
            data: { reactivated: !existing.active, exp_month: later ? expMonth : existing.expMonth, exp_year: later ? expYear : existing.expYear },
            apply: async (tx) => {
              await tx.authorizations.update(existing.id, {
                ...(later ? { expMonth, expYear } : {}),
                active: true,
                updatedAt: now,
              });
            },
          });
        }
        return stored;
      }
    }

    const id = hexId(deps.ids, 'pm', 20);
    const stored: StoredPaymentMethod = {
      seq: await state.nextSeq(),
      id,
      engineId: '',
      customerId: input.customer.id,
      currency: input.currency,
      behaviour: input.facts.behaviour,
      createdAt: deps.clock.nowISO(),
    };
    // The record and the default first: `authorization.created` is published
    // inside the engine call below, and the webhook built from it reads both.
    await state.paymentMethods.put(stored);
    if (!(await state.paymentMethods.defaultFor(input.customer.id))) {
      await state.paymentMethods.setDefault(input.customer.id, id);
    }
    const authorization = await engine.createAuthorizationRecord({
      provider: PROVIDER,
      channel: 'card',
      reusable: true,
      customerId: input.customer.id,
      paymentId: input.paymentId,
      providerAuthorizationCode: id,
      last4: input.facts.last4,
      expMonth: String(input.facts.expMonth).padStart(2, '0'),
      expYear: String(input.facts.expYear),
      brand: input.facts.brand,
      cardType: input.facts.brand,
      signature: input.facts.fingerprint,
      metadata: { currency: input.currency },
    });
    const linked = { ...stored, engineId: authorization.id };
    await state.paymentMethods.put(linked);
    return linked;
  });
}

/**
 * The card an off-session charge uses: the one named, or the customer's
 * default. Every refusal Bachs documents for `POST /v1/charges`, with its
 * code. Always scoped to the customer -- core's own authorization lookup is
 * not, and "another customer's card reads as missing".
 */
export async function resolveCard(
  deps: Pick<CardDeps, 'storage' | 'state' | 'clock'>,
  customer: Customer,
  paymentMethodId: string | null | undefined,
): Promise<{ method: StoredPaymentMethod; authorization: Authorization }> {
  let method: StoredPaymentMethod | null;
  if (paymentMethodId) {
    method = await deps.state.paymentMethods.get(paymentMethodId);
    if (!method || method.customerId !== customer.id) {
      throw fail(
        'not_found',
        'SAVED_PAYMENT_METHOD_NOT_FOUND',
        `No saved card ${paymentMethodId} belongs to this customer.`,
      );
    }
  } else {
    method = await deps.state.paymentMethods.defaultFor(customer.id);
    if (!method) {
      throw fail(
        'validation_failed',
        'NO_SAVED_PAYMENT_METHOD',
        'This customer has no saved card. Send them to a checkout that saves one.',
      );
    }
  }
  const authorization = await deps.storage.authorizations.byId(method.engineId);
  if (!authorization || !usable(authorization, deps.clock.now())) {
    throw fail(
      'validation_failed',
      'PAYMENT_METHOD_UNUSABLE',
      'The saved card has expired or been removed. Ask the customer to save a new one.',
    );
  }
  return { method, authorization };
}

/** Removed (deactivated or detached by paybox's tooling) or past its expiry month. */
export function usable(authorization: Authorization, now: number): boolean {
  if (!authorization.active || authorization.customerId === null) return false;
  const month = Number(authorization.expMonth);
  const year = Number(authorization.expYear);
  if (!month || !year) return true;
  // Valid through the last day of the expiry month.
  return now < Date.UTC(year, month, 1);
}
