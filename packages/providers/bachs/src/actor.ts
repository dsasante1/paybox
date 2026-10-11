import type { FastifyRequest } from 'fastify';
import type { Payment, Transfer } from '@paybox/shared';
import { fail } from './errors.js';
import type { BachsState, StoredAccount } from './state.js';

/**
 * Who a request runs as (connect/acting-as-an-account).
 *
 * "A platform key plus `X-Account-Id: acct_…` runs the request as that
 * account", on any API-key endpoint. The test is direct parentage: the named
 * account's parent must be the key's own account. A nonexistent account and
 * someone else's answer the same `403`, so the header cannot probe for ids.
 * A header under any other name is not this one, and the request runs as the
 * platform.
 *
 * Everything an owner creates is the owner's: a resource made under the
 * header is invisible without it, and the platform's are invisible with it.
 * Bachs records carry the owning account as `account` (absent: the platform);
 * core rows carry it as a ledger pot -- a direct charge's `subaccountId`, a
 * payout's `sourceSubaccountId`, a ledger entry's `subaccountId`.
 */
export interface Actor {
  /** The connected account acted as; null for the platform itself. */
  account: StoredAccount | null;
  /** The acting party's Bachs id: the account's, or the platform's. */
  id: string;
  /** Its ledger pot: the account's core Subaccount id, or null for the platform. */
  pot: string | null;
}

export async function resolveActor(
  request: FastifyRequest,
  state: BachsState,
  platformId: string,
): Promise<Actor> {
  const header = request.headers['x-account-id'];
  if (header === undefined) return platformActor(platformId);
  const id = String(header).trim();
  const account = id ? await state.accounts.get(id) : null;
  if (!account || account.parent !== platformId) {
    throw fail(
      'authentication_failed',
      'FORBIDDEN',
      `X-Account-Id: \`${id}\` is not an account this key can act as.`,
    );
  }
  return { account, id: account.id, pot: account.engineId };
}

export function platformActor(platformId: string): Actor {
  return { account: null, id: platformId, pot: null };
}

/** Whether a Bachs record, by its `account` field, belongs to the actor. */
export function owns(actor: Actor, account: string | null | undefined): boolean {
  return (account ?? null) === (actor.account?.id ?? null);
}

/** The `account` field a record created by the actor carries: absent for the platform. */
export function ownerField(actor: Actor): { account?: string } {
  return actor.account ? { account: actor.account.id } : {};
}

/**
 * A key for a store with one record per owner: per currency, or per merchant
 * reference. The platform's keys are unchanged. An account's are joined with
 * a unit separator, which no reference a client types contains, so a platform
 * reference can never land on an account's key.
 */
export function ownerKey(account: string | null | undefined, key: string): string {
  return account ? `${account}\u001f${key}` : key;
}

/** The pot a payment's money is in: a direct charge's account, or the platform. */
export function paymentPot(payment: Payment): string | null {
  return payment.settlementMode === 'direct' ? payment.subaccountId : null;
}

export function ownsPayment(actor: Actor, payment: Payment): boolean {
  return paymentPot(payment) === actor.pot;
}

export function ownsTransfer(actor: Actor, transfer: Transfer): boolean {
  return (transfer.sourceSubaccountId ?? null) === actor.pot;
}

/** The owner of a stored record as an actor: for paths with no request to resolve one from (the hosted page, jobs). */
export async function actorFor(state: BachsState, platformId: string, account: string | null | undefined): Promise<Actor> {
  if (!account) return platformActor(platformId);
  const stored = await state.accounts.get(account);
  if (!stored) return platformActor(platformId);
  return { account: stored, id: stored.id, pot: stored.engineId };
}

/** The core payment fields that put a charge in the actor's pot: a direct charge for an account. */
export function directCharge(actor: Actor): { subaccountId?: string; settlementMode?: 'direct' } {
  return actor.pot ? { subaccountId: actor.pot, settlementMode: 'direct' } : {};
}
