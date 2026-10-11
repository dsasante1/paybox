import type { Payment, Transfer } from '@paybox/shared';
import type { Storage } from '@paybox/core';
import { paymentPot } from './actor.js';
import { everyRow } from './http.js';
import { derivedId, eventId } from './ids.js';
import { toDecimal } from './money.js';
import type { BachsState, StoredCheckout } from './state.js';

/**
 * Connect money: transfers between a platform and its accounts, and the
 * platform fees struck on split sales.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (createTransfer,
 * listTransfers, getTransfer, listPlatformFees, getPlatformFee) and
 * connect/{transfers, platform-fees, split-payments/*}, with the
 * transfer-created event page.
 *
 * Neither is stored apart from what the engine already records. A transfer
 * is a core transfer between two pots: a manual one carries `bachs_transfer`,
 * and a destination charge's forwarded share is the engine's own
 * `destination_charge` transfer, Bachs' `kind: payout`. A platform fee is
 * read off its charge.
 */
const PROVIDER = 'bachs' as const;

interface ManualFacts {
  kind: 'manual';
  description: string | null;
  metadata: Record<string, unknown>;
}

/** Whether a core transfer is a Connect transfer rather than a payout to a bank. */
export function isConnectTransfer(transfer: Transfer): boolean {
  return (
    transfer.provider === PROVIDER &&
    (transfer.metadata.bachs_transfer !== undefined || transfer.reason === 'destination_charge')
  );
}

export const transferIdOf = (engineId: string) => derivedId('tr', `transfer:${engineId}`, 20);
export const platformFeeIdOf = (paymentId: string) => derivedId('pf', `platform-fee:${paymentId}`, 20);

/** Bachs account ids by ledger pot. */
export async function accountsByPot(state: BachsState): Promise<Map<string, string>> {
  return new Map((await state.accounts.all()).map((account) => [account.engineId, account.id]));
}

export interface TransferView {
  id: string;
  source: string;
  destination: string;
  amount: string;
  currency: string;
  status: 'pending' | 'paid';
  description: string | null;
  metadata: Record<string, unknown>;
  transfer_group: string | null;
  kind: 'payout' | 'manual';
  source_charge_id: string | null;
  created_at: string;
}

/** `TransferResponse`. */
export async function transferView(
  transfer: Transfer,
  storage: Storage,
  state: BachsState,
  platformId: string,
  pots?: Map<string, string>,
): Promise<TransferView> {
  const owners = pots ?? (await accountsByPot(state));
  const party = (pot: string | null) => (pot ? (owners.get(pot) ?? pot) : platformId);
  const manual = transfer.metadata.bachs_transfer as ManualFacts | undefined;
  let amount = transfer.amount;
  let sourceCharge: Payment | null = null;
  if (!manual && transfer.sourcePaymentId) {
    sourceCharge = await storage.payments.byId(transfer.sourcePaymentId);
    const checkout = sourceCharge ? await state.checkouts.byPayment(sourceCharge.id) : null;
    // A fee-first split's payout row carries the sale's gross, "even though
    // the seller is credited only gross − fee" (connect/split-payments).
    if (sourceCharge && checkout?.split?.platformFee != null) amount = sourceCharge.amount;
  }
  return {
    id: transferIdOf(transfer.id),
    source: party(transfer.sourceSubaccountId),
    destination: party(transfer.destinationSubaccountId),
    amount: toDecimal(amount, transfer.currency),
    currency: transfer.currency,
    status: transfer.status === 'successful' ? 'paid' : 'pending',
    description: manual?.description ?? null,
    metadata: manual?.metadata ?? {},
    transfer_group: transfer.transferGroup,
    kind: manual ? 'manual' : 'payout',
    source_charge_id: sourceCharge?.providerTransactionId ?? null,
    created_at: transfer.createdAt,
  };
}

/**
 * The creation order of the Bachs event a resource's change produced. Every
 * Bachs event is numbered as it is built, in the order things happened, which
 * a frozen clock's tied `created_at` cannot tell.
 */
async function eventSeq(storage: Storage, resourceId: string, type: string): Promise<number> {
  for (const event of await storage.events.listByResource(resourceId)) {
    const stored = await storage.providerState.get(PROVIDER, `event:${eventId(event.id, type)}`);
    if (stored) return (JSON.parse(stored) as { seq: number }).seq;
  }
  return 0;
}

/** Every Connect transfer, newest first: by when it was made (its `transfer.created`). */
export async function connectTransfers(storage: Storage): Promise<Transfer[]> {
  const rows = [];
  for (const transfer of await everyRow((page) => storage.transfers.list(page))) {
    if (!isConnectTransfer(transfer)) continue;
    rows.push({ transfer, seq: await eventSeq(storage, transfer.id, 'transfer.created') });
  }
  return rows
    .sort((a, b) => b.transfer.createdAt.localeCompare(a.transfer.createdAt) || b.seq - a.seq)
    .map((row) => row.transfer);
}

export interface PlatformFeeView {
  id: string;
  charge: string;
  collected_from: string;
  earned_by: string;
  amount: string;
  currency: string;
  amount_refunded: string;
  refunded: boolean;
  created_at: string;
}

const COLLECTED: readonly string[] = ['successful', 'partially_refunded', 'refunded'];

/**
 * Platform fees: one for each settled fee-first split -- a direct charge with
 * `platform_fee`, or a destination charge with it -- "never for share-first",
 * recorded "on settlement, never sooner". Not reversed by a refund
 * ("Currently always `0.00`").
 */
export async function platformFees(storage: Storage, state: BachsState, platformId: string): Promise<PlatformFeeView[]> {
  const owners = await accountsByPot(state);
  const fees: Array<PlatformFeeView & { sort: string; seq: number }> = [];
  const payments = await everyRow((page) => storage.payments.list({ provider: PROVIDER, ...page }));
  for (const payment of payments) {
    if (!COLLECTED.includes(payment.status) || payment.platformFee <= 0) continue;
    const checkout: StoredCheckout | null = await state.checkouts.byPayment(payment.id);
    const split = checkout?.split;
    if (!split || split.platformFee === null || split.kind === 'none') continue;
    const collectedFrom = split.kind === 'destination' ? split.destination! : owners.get(paymentPot(payment) ?? '');
    if (!collectedFrom) continue;
    const at = payment.paidAt ?? payment.updatedAt;
    fees.push({
      id: platformFeeIdOf(payment.id),
      charge: payment.providerTransactionId,
      collected_from: collectedFrom,
      earned_by: platformId,
      amount: toDecimal(split.platformFee, split.currency),
      currency: split.currency,
      amount_refunded: toDecimal(0, split.currency),
      refunded: false,
      created_at: at,
      sort: at,
      // Struck when the sale settled: its `collection.succeeded`.
      seq: await eventSeq(storage, payment.id, 'collection.succeeded'),
    });
  }
  return fees
    .sort((a, b) => b.sort.localeCompare(a.sort) || b.seq - a.seq)
    .map(({ sort: _sort, seq: _seq, ...fee }) => fee);
}
