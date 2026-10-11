import type { Clock, IdFactory, LedgerEntry, Payment, PayboxEvent, Transfer } from '@paybox/shared';
import type { Job, PaymentEngine, Storage } from '@paybox/core';
import { hasCapability } from './accounts.js';
import { keptBy, splitParts } from './split.js';
import { actorFor, ownerKey, paymentPot, platformActor, type Actor } from './actor.js';
import { fail } from './errors.js';
import { everyRow } from './http.js';
import { derivedId, disputeIdOf, hexId } from './ids.js';
import { toDecimal } from './money.js';
import { withLock } from './locks.js';
import { convertMinor, exchangeRate, isHeld, isStablecoin } from './rates.js';
import { amountPaidOf, feeOf } from './serializers.js';
import { bachsDisputeStatus, isOpenDispute } from './status.js';
import {
  bachsState,
  type BachsState,
  type StoredAccount,
  type StoredConversion,
  type StoredDestination,
  type StoredQuote,
  type StoredSchedule,
} from './state.js';

const PROVIDER = 'bachs' as const;

/**
 * Bachs' money out: settlement into held currencies, payouts, quotes,
 * conversions and payout schedules.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (createPayout,
 * createPayoutQuote, the destination, conversion and balance-settings
 * operations), guides/payouts/{overview, payout-using-api, global-payouts,
 * payout-schedules}, connect/{payouts, testing, balances},
 * for-you/{fees, supported-currencies} and the payout and conversion event
 * pages. docs/bachs.md records where they disagree and which one paybox
 * follows.
 */

export const BACHS_PAYOUT_ADVANCE_JOB = 'bachs.payout.advance';
export const BACHS_PAYOUT_SCHEDULE_JOB = 'bachs.payout.schedule';

/** "Quotes last 30 seconds" (payout-using-api). Conversion quotes are given the same. */
export const QUOTE_TTL_MS = 30_000;
/** Sandbox payouts move to processing, then resolve, "after a short delay": a second each here. */
const STEP_MS = 1_000;
/** `instant` "fires about a minute after funds settle". */
const INSTANT_DELAY_MS = 60_000;

/** A payment that collected money, whatever has been refunded since: it owes its processing fee. */
const COLLECTED: readonly string[] = ['successful', 'partially_refunded', 'refunded'];

/**
 * for-you/fees: "Dispute / Chargeback: $15.00 per dispute" and "Early dispute
 * warning: $29.00 per payment", in US cents. Each is taken in the disputed
 * charge's settlement currency (an NGN charge pays in naira at the fixed
 * rate), the currency a lost dispute lands in too (connect/disputes).
 */
export const DISPUTE_FEE_USD = 1_500;
export const WARNING_FEE_USD = 2_900;

/** One ledger movement a dispute owes but the ledger does not yet hold. */
interface DisputeMovement {
  direction: 'debit' | 'credit';
  currency: string;
  amount: number;
  reason: 'dispute_fee' | 'dispute_warning_fee' | 'dispute_hold' | 'dispute_hold_release';
  resourceId: string;
  /** The pot of whoever owns the disputed charge. */
  pot: string | null;
}

/** Every currency movement serialises on this one key: the sweep, payouts and conversions all read and move balances. */
const TREASURY_LOCK = 'treasury';

/**
 * Bachs' published test destinations (connect/testing). Mobile money "has no
 * trigger values; it always resolves to the default outcome", which is
 * completed.
 */
const FAILING_BANK = { bankCode: '998', accountNumber: '0001112224' };
const FAILING_WALLET = '0x2222222222222222222222222222222222222222';

export const PAYOUT_FAILURE = 'The destination bank rejected the payout.';
export const WALLET_FAILURE = 'The crypto transfer to the destination wallet failed.';
export const MOMO_UNLISTED_FAILURE = 'The mobile money provider is not supported for this country.';

/** Mobile-money networks payouts reach (global-payouts); others fail "when it is sent". */
export const MOMO_PROVIDERS: Record<string, string[]> = {
  GHS: ['MTN', 'VODAFONE', 'AIRTEL'],
  KES: ['SAFARICOM', 'AIRTEL', 'T-KASH'],
  TZS: ['Vodacom', 'Tigo', 'Airtel Tanzania', 'Halopesa'],
};

/**
 * The withdrawal fee (for-you/fees, "Withdrawal Fees"): priced from the amount
 * that leaves the balance, then the minimum and the cap.
 */
export function withdrawalFee(source: string, type: StoredDestination['type'], leaving: number): number {
  const percent = (bps: number) => Math.floor((leaving * bps + 5_000) / 10_000);
  if (source === 'NGN') return type === 'bank_account' ? 5_000 : percent(30);
  if (source === 'USD') {
    const fee = Math.max(100, percent(100));
    return type === 'bank_account' ? Math.min(fee, 1_500) : fee;
  }
  return percent(30);
}

export interface TreasuryDeps {
  engine: PaymentEngine;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  /** The platform's own account id, for jobs that act for whoever owns a schedule. */
  organizationId: string;
}

/** What a payout's core transfer carries beyond the engine's own columns. */
export interface PayoutFacts {
  destination: string;
  sourceCurrency: string;
  destinationCurrency: string;
  /** What arrives, minor units of `destinationCurrency`. */
  destinationAmount: number;
  fee: number;
  totalDebited: number;
  rate: string | null;
  quoteId: string | null;
  reference: string | null;
  failureReason: string | null;
  outcome: 'completed' | 'failed';
  schedule: string | null;
}

export function payoutFacts(transfer: Transfer): PayoutFacts {
  return transfer.metadata.bachs_payout as unknown as PayoutFacts;
}

/** A payout's Bachs id, recomputable from its core transfer. */
export const payoutIdOf = (engineId: string) => derivedId('pay', `payout:${engineId}`, 16);

export class BachsTreasury {
  readonly #engine: PaymentEngine;
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #organizationId: string;
  readonly state: BachsState;

  constructor(deps: TreasuryDeps) {
    this.#engine = deps.engine;
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#organizationId = deps.organizationId;
    this.state = bachsState(deps.storage, () => deps.clock.nowISO());
  }

  /**
   * Every pot that holds money: the platform's, and each connected
   * account's (connect/balances: an account's balance is its own, from the
   * moment it exists). Each is settled, read and spent on its own.
   */
  async #pots(): Promise<Array<string | null>> {
    return [null, ...(await this.state.accounts.all()).map((account) => account.engineId)];
  }

  /** The owner of a pot, as an actor, for jobs and listeners that have only the pot. */
  async #actorOfPot(pot: string | null): Promise<Actor> {
    if (pot === null) return platformActor(this.#organizationId);
    const account = (await this.state.accounts.all()).find((candidate) => candidate.engineId === pot);
    return actorFor(this.state, this.#organizationId, account?.id ?? null);
  }

  /* ------------------------------ settlement ------------------------------ */

  /**
   * Bachs holds USD and NGN only: a collection in any other currency "is
   * converted when it settles, and the converted amount is credited to your
   * balance in your settlement currency", USD.
   *
   * The engine credits (and on a refund debits) a payment in its own currency
   * on every path -- the hosted page, `paybox simulate`, scenarios, the
   * dashboard, a control-API refund. Rather than hook each, this sweeps
   * whatever a non-held currency has netted into USD, one atomic pair per
   * currency, and runs before anything reads or moves a balance. A crash
   * between a charge and its sweep therefore loses nothing: the next sweep
   * finds it, and balance reads project it meanwhile.
   */
  async sweep(): Promise<void> {
    await withLock(TREASURY_LOCK, () => this.#sweep());
  }

  async #sweep(): Promise<void> {
    await this.#chargeFees();
    await this.#settleDisputes();
    // A hold whose refund has finished comes back here too, not only from the
    // refund's own event: that event lives in memory, and a crash or a failing
    // handler must not leave the hold taken for good.
    for (const hold of await this.#finishedHolds()) await this.#releaseRefundHold(hold.resourceId!);
    for (const pot of await this.#pots()) await this.#sweepPot(pot);
  }

  async #sweepPot(pot: string | null): Promise<void> {
    for (const currency of await this.#storage.ledger.currencies(PROVIDER, pot)) {
      if (isHeld(currency)) continue;
      const net = await this.#storage.ledger.net(PROVIDER, currency, pot);
      if (net === 0) continue;
      const { foreign, usd } = await this.#swept(currency, pot);
      // Rounded on the running total, not per sweep, so a hundred small
      // collections settle to what their sum is worth.
      const delta = convertMinor(foreign + net, currency, 'USD') - usd;
      // Too small to move a cent yet: left for the next sweep to gather.
      if (delta === 0 || Math.sign(delta) !== Math.sign(net)) continue;
      const other = { currency, amount: Math.abs(net) };
      const dollars = { currency: 'USD', amount: Math.abs(delta) };
      await this.#engine.exchangeBalance({
        provider: PROVIDER,
        from: net > 0 ? other : dollars,
        to: net > 0 ? dollars : other,
        reason: 'settlement',
        resourceId: `settlement:${currency}`,
        subaccountId: pot,
      });
    }
  }

  /** What every sweep of `currency` has moved so far: foreign out (+) and dollars in (+). */
  async #swept(currency: string, pot: string | null): Promise<{ foreign: number; usd: number }> {
    const tag = `settlement:${currency}`;
    let foreign = 0;
    let usd = 0;
    for (const entry of await this.#ledger(pot)) {
      if (entry.reason !== 'settlement' || entry.resourceId !== tag) continue;
      const signed = entry.direction === 'credit' ? entry.amount : -entry.amount;
      if (entry.currency === currency) foreign -= signed;
      else if (entry.currency === 'USD') usd += signed;
    }
    return { foreign, usd };
  }

  async #payments() {
    return everyRow((page) => this.#storage.payments.list({ provider: PROVIDER, ...page }));
  }

  /** One pot's ledger, or, with no pot named, every pot's. */
  async #ledger(pot?: string | null) {
    return everyRow((page) =>
      this.#storage.ledger.list({ provider: PROVIDER, ...(pot === undefined ? {} : { subaccountId: pot }), ...page }),
    );
  }

  /** Collections owed their processing fee: successful once, whatever has happened since. */
  async #feesOwed(): Promise<Array<{ paymentId: string; currency: string; fee: number; pot: string | null }>> {
    const charged = new Set(
      (await this.#ledger()).filter((entry) => entry.reason === 'processing_fee').map((entry) => entry.resourceId),
    );
    const owed = [];
    const accounts = new Map((await this.state.accounts.all()).map((account) => [account.engineId, account]));
    for (const payment of await this.#payments()) {
      if (charged.has(payment.id) || !COLLECTED.includes(payment.status)) continue;
      const fee = feeOf(payment) ?? 0;
      if (fee <= 0) continue;
      for (const part of await this.#feePayers(payment, fee, accounts)) {
        owed.push({ paymentId: payment.id, currency: payment.currency, fee: part.fee, pot: part.pot });
      }
    }
    return owed;
  }

  /**
   * Whose balance pays a collection's processing fee. Normally the charge's
   * owner. On a direct charge for an account whose fees are collected by the
   * platform (`responsibilities.fees.collector: "platform"`, connect/
   * processing-fees), the platform pays it and the account settles gross --
   * unless the platform cannot cover it, when it "silently falls back" to the
   * charge.
   */
  async #feePayers(
    payment: Payment,
    fee: number,
    accounts: Map<string, StoredAccount>,
  ): Promise<Array<{ pot: string | null; fee: number }>> {
    const held = settlementCurrency(payment.currency);
    const platformBalance = () => this.#engine.getBalance(PROVIDER, held, null);
    // A destination charge: "(1) the platform's cut on this sale, (2) the
    // platform's available balance -- all or nothing, (3) the account's
    // share", the last only for the remainder (connect/processing-fees).
    if (payment.settlementMode === 'forwarded' && payment.subaccountId) {
      const cut = Math.min(payment.platformFee, fee);
      if (cut >= fee) return [{ pot: null, fee }];
      const remainder = fee - cut;
      // The platform's balance besides this sale's cut, which a held
      // currency's balance already counts.
      const besides = (await platformBalance()) - (isHeld(payment.currency) ? cut : 0);
      if (besides >= convertMinor(remainder, payment.currency, held)) return [{ pot: null, fee }];
      return [
        ...(cut > 0 ? [{ pot: null, fee: cut }] : []),
        { pot: payment.subaccountId, fee: remainder },
      ];
    }
    const pot = paymentPot(payment);
    if (pot === null || accounts.get(pot)?.collector !== 'platform') return [{ pot, fee }];
    return (await platformBalance()) >= convertMinor(fee, payment.currency, held) ? [{ pot: null, fee }] : [{ pot, fee }];
  }

  /**
   * What settles is the amount net of Bachs' processing fee
   * (`settlement_amount`): the engine credits a collection gross, so the fee
   * comes off here, once per collection, whatever settled it.
   */
  async #chargeFees(): Promise<void> {
    for (const owed of await this.#feesOwed()) {
      await this.#engine.debitBalance({
        provider: PROVIDER,
        currency: owed.currency,
        amount: owed.fee,
        reason: 'processing_fee',
        resourceId: owed.paymentId,
        subaccountId: owed.pot,
      });
    }
  }

  /**
   * What disputes owe the ledger, worked out from the dispute rows rather
   * than from the call that moved each one, so a dispute opened or ruled on
   * by any path -- the Bachs routes, the control API, `paybox dispute` -- and
   * a crash between the row and its ledger entry come out the same.
   *
   * guides/disputes/overview: the fee is "deducted as soon as the dispute is
   * created, whether it is later won or lost", and the disputed amount "is
   * taken out of your available balance and set aside". A win, a closure or
   * a prevention releases it; a loss keeps it, the amount having "gone back
   * to the customer", so a loss needs no second debit. An unescalated warning
   * pays its own fee, once per payment, and sets nothing aside: no chargeback
   * has been filed yet.
   */
  async #disputeMovements(): Promise<DisputeMovement[]> {
    const ledger = await this.#ledger();
    const seen = new Set(ledger.map((entry) => `${entry.reason}:${entry.resourceId}`));
    const holds = new Map(
      ledger.filter((entry) => entry.reason === 'dispute_hold').map((entry) => [entry.resourceId, entry.amount]),
    );
    const owed: DisputeMovement[] = [];
    const disputes = await everyRow((page) => this.#storage.disputes.list({ provider: PROVIDER, ...page }));
    for (const dispute of disputes) {
      const record = await this.state.disputes.get(disputeIdOf(dispute));
      const currency = settlementCurrency(dispute.currency);
      // connect/disputes: "A dispute debits whoever owns the charge".
      const payment = await this.#storage.payments.byId(dispute.paymentId);
      const pot = payment ? paymentPot(payment) : null;
      const status = bachsDisputeStatus(dispute);
      const warningOnly = record !== null && record.warning && record.escalatedAt === null;
      const owe = (movement: DisputeMovement) => {
        const key = `${movement.reason}:${movement.resourceId}`;
        if (seen.has(key)) return;
        seen.add(key);
        owed.push(movement);
      };
      if (record?.warning) {
        owe({
          direction: 'debit',
          currency,
          amount: convertMinor(WARNING_FEE_USD, 'USD', currency),
          reason: 'dispute_warning_fee',
          resourceId: `warning:${dispute.paymentId}`,
          pot,
        });
      }
      if (warningOnly) continue;
      owe({
        direction: 'debit',
        currency,
        amount: convertMinor(DISPUTE_FEE_USD, 'USD', currency),
        reason: 'dispute_fee',
        resourceId: dispute.id,
        pot,
      });
      // Kept while undecided and on a loss. A loss recorded by the generic
      // tooling raised a real refund, which took the money itself.
      const keep = isOpenDispute(status) || dispute.providerStatus === 'lost';
      const amount = holds.get(dispute.id) ?? convertMinor(dispute.refundAmount, dispute.currency, currency);
      if (!seen.has(`dispute_hold:${dispute.id}`)) {
        // A dispute ruled on before its hold was written never needs one,
        // unless it was lost.
        if (keep) owe({ direction: 'debit', currency, amount, reason: 'dispute_hold', resourceId: dispute.id, pot });
      } else if (!keep) {
        owe({ direction: 'credit', currency, amount, reason: 'dispute_hold_release', resourceId: dispute.id, pot });
      }
    }
    return owed;
  }

  async #settleDisputes(): Promise<void> {
    for (const movement of await this.#disputeMovements()) {
      const input = {
        provider: PROVIDER,
        currency: movement.currency,
        amount: movement.amount,
        reason: movement.reason,
        resourceId: movement.resourceId,
        subaccountId: movement.pot,
      };
      if (movement.direction === 'debit') await this.#engine.debitBalance(input);
      else await this.#engine.creditBalance(input);
    }
  }

  /**
   * A held balance as Bachs reports it: the engine's, plus anything a
   * non-held currency has netted that no sweep has moved yet. Pure: a read
   * neither writes nor draws an id.
   */
  async available(currency: 'USD' | 'NGN', pot: string | null = null): Promise<number> {
    let balance = await this.#engine.getBalance(PROVIDER, currency, pot);
    // Fees not yet taken off, and foreign money not yet swept, are reported
    // as the sweep will leave them -- without writing.
    const pending = new Map<string, number>();
    for (const owed of await this.#feesOwed()) {
      if (owed.pot !== pot) continue;
      pending.set(owed.currency, (pending.get(owed.currency) ?? 0) - owed.fee);
    }
    for (const hold of await this.#finishedHolds()) {
      if ((hold.subaccountId ?? null) === pot && hold.currency === currency) balance += hold.amount;
    }
    for (const movement of await this.#disputeMovements()) {
      if (movement.currency !== currency || movement.pot !== pot) continue;
      balance += movement.direction === 'credit' ? movement.amount : -movement.amount;
    }
    balance += pending.get(currency) ?? 0;
    if (currency !== 'USD') return balance;
    const currencies = new Set([...(await this.#storage.ledger.currencies(PROVIDER, pot)), ...pending.keys()]);
    for (const other of currencies) {
      if (isHeld(other)) continue;
      const net = (await this.#storage.ledger.net(PROVIDER, other, pot)) + (pending.get(other) ?? 0);
      if (net === 0) continue;
      const { foreign, usd } = await this.#swept(other, pot);
      balance += convertMinor(foreign + net, other, 'USD') - usd;
    }
    return balance;
  }

  /** "A negative balance in any one currency freezes every transfer and every withdrawal" for that party. */
  async inDebt(pot: string | null): Promise<boolean> {
    return (await this.available('USD', pot)) < 0 || (await this.available('NGN', pot)) < 0;
  }

  /** React to money arriving or leaving through any path: settle it into a held currency. */
  onMoneyMoved = async (event: PayboxEvent): Promise<void> => {
    if (event.provider !== PROVIDER) return;
    if (event.resourceType === 'refund') {
      await withLock(TREASURY_LOCK, async () => {
        await this.#releaseRefundHold(event.resourceId);
        await this.#sweep();
      });
      return;
    }
    await this.sweep();
    if (event.type === 'payment.successful') await this.#triggerInstant(event.resourceId);
  };

  /**
   * A refund "reserves" its amount when it is created (guides/refunds): the
   * held balance is debited at once, so a payout made before it settles
   * cannot spend the same money. When it settles the engine takes the real
   * amount, in the charge's currency, and the hold comes back; when it fails,
   * the hold just comes back. Call inside `exclusive`.
   */
  async holdForRefund(input: { refundId: string; currency: string; amount: number; pot: string | null }): Promise<void> {
    await this.#engine.debitBalance({
      provider: PROVIDER,
      currency: input.currency,
      amount: input.amount,
      reason: 'refund_hold',
      resourceId: input.refundId,
      subaccountId: input.pot,
    });
  }

  /** Refund holds, in every pot, still taken although their refund has succeeded or failed. */
  async #finishedHolds(): Promise<LedgerEntry[]> {
    const ledger = await this.#ledger();
    const released = new Set(
      ledger.filter((entry) => entry.reason === 'refund_hold_release').map((entry) => entry.resourceId),
    );
    const finished: LedgerEntry[] = [];
    for (const entry of ledger) {
      if (entry.reason !== 'refund_hold' || !entry.resourceId || released.has(entry.resourceId)) continue;
      const refund = await this.#storage.refunds.byId(entry.resourceId);
      if (!refund || refund.status === 'successful' || refund.status === 'failed') finished.push(entry);
    }
    return finished;
  }

  async #releaseRefundHold(refundId: string): Promise<void> {
    const entries = (await this.#ledger()).filter((entry) => entry.resourceId === refundId);
    const hold = entries.find((entry) => entry.reason === 'refund_hold');
    if (!hold || entries.some((entry) => entry.reason === 'refund_hold_release')) return;
    await this.#engine.creditBalance({
      provider: PROVIDER,
      currency: hold.currency,
      amount: hold.amount,
      reason: 'refund_hold_release',
      resourceId: refundId,
      subaccountId: hold.subaccountId,
    });
  }

  /** Run `fn` with every balance movement held still, after a sweep: the refund route's check-and-hold. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(TREASURY_LOCK, async () => {
      await this.#sweep();
      return fn();
    });
  }

  /** A scheduled payout that fails releases its collections; an `instant` schedule should look again. */
  onPayoutFailed = async (event: PayboxEvent): Promise<void> => {
    if (event.provider !== PROVIDER || event.resourceType !== 'transfer') return;
    const transfer = await this.#storage.transfers.byId(event.resourceId);
    const facts = transfer?.metadata.bachs_payout as PayoutFacts | undefined;
    if (!transfer || !facts?.schedule) return;
    await this.#queueInstant(facts.schedule, (await this.#actorOfPot(transfer.sourceSubaccountId ?? null)).account?.id ?? null);
  };

  /* ------------------------------- transfers ------------------------------- */

  /**
   * `POST /v1/transfers`: a manual transfer between a platform and one of its
   * own accounts, "paid on creation (instant both sides)". There is no source
   * field: whoever is authenticated is debited -- the platform sending a share
   * out, or an account sending money back (`destination: "self"`).
   */
  async createTransfer(input: {
    source: Actor;
    destination: StoredAccount | null;
    amount: number;
    currency: string;
    description: string | null;
    metadata: Record<string, unknown>;
    transferGroup: string | null;
  }): Promise<Transfer> {
    return withLock(TREASURY_LOCK, async () => {
      await this.#sweep();
      // "Account `transfers` active (both directions)."
      const account = input.source.account ?? input.destination;
      if (account && !hasCapability(account, 'transfers')) {
        throw fail('authentication_failed', 'FORBIDDEN', "The account's transfers capability is not active.");
      }
      const pot = input.source.pot;
      if (await this.inDebt(pot)) {
        throw fail(
          'validation_failed',
          'ORGANIZATION_IN_DEBT',
          'A balance is negative. Transfers are blocked until it is brought back to zero.',
        );
      }
      const available = await this.available(input.currency as 'USD' | 'NGN', pot);
      if (available < input.amount) {
        throw fail(
          'balance_insufficient',
          'INSUFFICIENT_BALANCE',
          `Insufficient ${input.currency} balance: ${toDecimal(available, input.currency)} available, ` +
            `${toDecimal(input.amount - available, input.currency)} short.`,
        );
      }
      return this.#engine.createTransfer({
        provider: PROVIDER,
        amount: input.amount,
        currency: input.currency,
        reason: 'transfer',
        status: 'successful',
        sourceSubaccountId: pot,
        destinationSubaccountId: input.destination?.engineId ?? null,
        destinationPlatform: input.destination === null,
        transferGroup: input.transferGroup,
        metadata: {
          bachs_transfer: {
            kind: 'manual',
            description: input.description,
            metadata: input.metadata,
          },
        },
      });
    });
  }

  /* -------------------------------- quotes -------------------------------- */

  async createQuote(input: {
    kind: StoredQuote['kind'];
    from: string;
    to: string;
    fromAmount: number;
    fee: number;
    rail?: StoredDestination['type'] | null;
    owner: Actor;
  }): Promise<StoredQuote> {
    const now = this.#clock.nowISO();
    const toAmount = convertMinor(input.fromAmount - input.fee, input.from, input.to);
    if (toAmount <= 0) {
      throw fail(
        'validation_failed',
        'QUOTE_ERROR',
        'The amount is too small to convert. Check the currency pair and amount are valid.',
      );
    }
    const quote: StoredQuote = {
      ...(input.owner.account ? { account: input.owner.account.id } : {}),
      kind: input.kind,
      id: hexId(this.#ids, input.kind === 'payout' ? 'pqt' : 'cqt', 12),
      fromCurrency: input.from,
      toCurrency: input.to,
      fromAmount: input.fromAmount,
      toAmount,
      fee: input.fee,
      rate: exchangeRate(input.from, input.to),
      expiresAt: new Date(this.#clock.now() + QUOTE_TTL_MS).toISOString(),
      usedBy: null,
      rail: input.rail ?? null,
      createdAt: now,
    };
    await this.state.quotes.put(quote);
    return quote;
  }

  /** A quote that can still be used, or the documented refusal. Call under the treasury lock. */
  async #usableQuote(id: string, kind: StoredQuote['kind'], owner: Actor): Promise<StoredQuote> {
    const quote = await this.state.quotes.get(id);
    // "Also covers a quote that belongs to another organisation", and a quote
    // of the other kind. 400, not 404.
    if (!quote || quote.kind !== kind || quote.usedBy || (quote.account ?? null) !== (owner.account?.id ?? null)) {
      throw fail('validation_failed', 'QUOTE_NOT_FOUND', `Quote ${id} was not found or has already been used.`);
    }
    if (this.#clock.now() >= Date.parse(quote.expiresAt)) {
      throw fail('validation_failed', 'QUOTE_EXPIRED', `Quote ${id} has expired. Request a new quote.`);
    }
    return quote;
  }

  /* -------------------------------- payouts ------------------------------- */

  /**
   * `POST /v1/payouts`. "Creating one debits the balance immediately": the
   * core transfer reserves what leaves (`total_debited`) in the source
   * currency, so a failure gives back exactly that, in that currency.
   */
  async createPayout(input: {
    destination: StoredDestination;
    amount: number | null;
    quoteId: string | null;
    reference: string | null;
    metadata: Record<string, unknown>;
    schedule?: string | null;
    owner: Actor;
  }): Promise<Transfer> {
    return withLock(TREASURY_LOCK, async () => {
      await this.#sweep();
      // connect/payouts: an account withdraws only while its `payouts`
      // capability is active, and is refused with 403 FORBIDDEN otherwise.
      if (!hasCapability(input.owner.account, 'payouts')) {
        throw fail('authentication_failed', 'FORBIDDEN', "This account's payouts capability is not active.");
      }
      // "Any currency is negative ... blocks every payout."
      if (await this.inDebt(input.owner.pot)) {
        throw fail(
          'validation_failed',
          'ORGANIZATION_IN_DEBT',
          'A balance is negative. Payouts are blocked until it is brought back to zero.',
        );
      }
      const { destination } = input;
      const destCurrency = destination.currency;
      // Same-currency payouts leave from that balance; crypto is dollars at
      // one to one; everything else is funded from USD through a quote.
      const sameCurrency = isHeld(destCurrency) || isStablecoin(destCurrency);
      let source: string;
      let destinationAmount: number;
      let fee: number;
      let totalDebited: number;
      let quote: StoredQuote | null = null;
      if (input.quoteId !== null) {
        if (input.amount !== null) {
          throw fail('validation_failed', 'AMOUNT_NOT_ALLOWED_WITH_QUOTE', 'Send amount or quote_id, never both.');
        }
        if (isHeld(destCurrency)) {
          // An NGN destination may be paid from USD through a quote.
          if (destCurrency === 'USD') {
            throw fail(
              'validation_failed',
              'QUOTE_NOT_APPLICABLE',
              'A same-currency payout takes amount, not quote_id.',
            );
          }
        } else if (sameCurrency) {
          throw fail('validation_failed', 'QUOTE_NOT_APPLICABLE', 'A same-currency payout takes amount, not quote_id.');
        }
        quote = await this.#usableQuote(input.quoteId, 'payout', input.owner);
        if (quote.toCurrency !== destCurrency || (quote.rail !== null && quote.rail !== destination.type)) {
          throw fail(
            'validation_failed',
            'QUOTE_DESTINATION_MISMATCH',
            `Quote ${quote.id} is for a ${quote.rail ?? 'bank_account'} payout in ${quote.toCurrency}; ` +
              `the destination is a ${destination.type} in ${destCurrency}.`,
          );
        }
        source = quote.fromCurrency;
        destinationAmount = quote.toAmount;
        fee = quote.fee;
        totalDebited = quote.fromAmount;
      } else {
        if (input.amount === null) {
          throw fail(
            'validation_failed',
            sameCurrency ? 'AMOUNT_REQUIRED' : 'QUOTE_REQUIRED',
            sameCurrency ? 'A same-currency payout needs an amount.' : 'A cross-currency payout needs a quote_id.',
          );
        }
        if (!sameCurrency) {
          throw fail('validation_failed', 'QUOTE_REQUIRED', `Paying out ${destCurrency} needs a quote_id from USD.`);
        }
        source = isStablecoin(destCurrency) ? 'USD' : destCurrency;
        destinationAmount = input.amount;
        // "The fee is charged on top."
        fee = withdrawalFee(source, destination.type, input.amount);
        totalDebited = input.amount + fee;
      }

      const outcome = payoutOutcome(destination);
      const facts: PayoutFacts = {
        destination: destination.id,
        sourceCurrency: source,
        destinationCurrency: destCurrency,
        destinationAmount,
        fee,
        totalDebited,
        rate: quote?.rate ?? null,
        quoteId: quote?.id ?? null,
        reference: input.reference,
        failureReason: outcome.failureReason,
        outcome: outcome.status,
        schedule: input.schedule ?? null,
      };
      const routing = destination.routing;
      // The engine's reference is unique per provider; Bachs' own is
      // optional, so one is minted when none is given.
      // A reference is unique per owner, and the core transfer's per provider,
      // so an account's is namespaced there (facts keep the one it was given).
      const reference = payoutReference(input.owner, input.reference ?? hexId(this.#ids, 'ref', 24));
      // Everything that must follow the transfer is arranged before it, keyed
      // by its reference, so a crash right after it commits leaves nothing
      // undone: the advance job finds the transfer, and the quote is spent.
      if (quote) await this.state.quotes.put({ ...quote, usedBy: reference });
      await this.#enqueueAdvance(reference, 'processing', STEP_MS);
      let transfer: Transfer;
      try {
        transfer = await this.#engine.createTransfer({
          provider: PROVIDER,
          // Out of the owner's own balance (connect/payouts).
          sourceSubaccountId: input.owner.pot,
          amount: totalDebited - fee,
          currency: source,
          reference,
          recipientName: (routing.account_name as string | undefined) ?? destination.name,
          recipientAccount:
            (routing.account_number as string | undefined) ??
            (routing.phone_number as string | undefined) ??
            (routing.wallet_address as string | undefined) ??
            null,
          recipientBankCode: (routing.bank_code as string | undefined) ?? null,
          reason: 'payout',
          fee,
          feeRefundable: true,
          status: 'pending',
          metadata: {
            bachs_payout: facts as unknown as Record<string, unknown>,
            ...input.metadata,
          },
        });
      } catch (error) {
        // Refused (the balance, a duplicate reference): nothing was paid, so
        // the quote can still be used. The queued job finds no payout and
        // does nothing.
        if (quote) await this.state.quotes.put(quote);
        throw error;
      }
      const id = payoutIdOf(transfer.id);
      await this.state.payouts.index(id, transfer.id);
      if (input.reference) await this.state.payouts.indexReference(input.reference, id, input.owner.account?.id ?? null);
      return transfer;
    });
  }

  async #enqueueAdvance(reference: string, stage: 'processing' | 'settle', delayMs: number): Promise<void> {
    await this.#enqueue(BACHS_PAYOUT_ADVANCE_JOB, { reference, stage }, delayMs, `bachs-payout:${reference}`);
  }

  /**
   * `bachs.payout.advance`: pending -> processing, then the outcome decided
   * when the payout was created. A payout paybox's tooling moved meanwhile
   * is left where it is.
   */
  handleAdvanceJob = async (job: Job): Promise<void> => {
    const reference = String(job.payload.reference ?? '');
    const stage = job.payload.stage;
    // Not there: the payout's creation failed after the job was queued.
    const transfer = await this.#storage.transfers.byReference(PROVIDER, reference);
    if (!transfer?.metadata.bachs_payout) return;
    const transferId = transfer.id;
    const facts = payoutFacts(transfer);
    if (stage === 'processing') {
      if (transfer.status !== 'pending') return;
      await this.#engine.transitionTransfer(transferId, 'processing');
      await this.#enqueueAdvance(reference, 'settle', STEP_MS);
      return;
    }
    if (transfer.status !== 'processing') return;
    if (facts.outcome === 'failed') {
      await this.#engine.transitionTransfer(transferId, 'failed', {
        failureReason: facts.failureReason,
      });
      return;
    }
    await this.#engine.transitionTransfer(transferId, 'successful');
  };

  /* ------------------------------ conversions ------------------------------ */

  /** `POST /v1/conversions`: synchronous, `completed`, the balance moved at the quoted amounts. */
  async executeConversion(input: { quoteId: string; from: string; to: string; amount: number; owner: Actor }) {
    return withLock(TREASURY_LOCK, async () => {
      await this.#sweep();
      const quote = await this.#usableQuote(input.quoteId, 'conversion', input.owner);
      if (quote.fromCurrency !== input.from || quote.toCurrency !== input.to || quote.fromAmount !== input.amount) {
        throw fail('validation_failed', 'QUOTE_ERROR', 'The currencies and amount must match the quote.');
      }
      const id = hexId(this.#ids, 'cvt', 12);
      const now = this.#clock.nowISO();
      const conversion: StoredConversion = {
        ...(input.owner.account ? { account: input.owner.account.id } : {}),
        seq: await this.state.nextSeq(),
        id,
        quoteId: quote.id,
        fromCurrency: quote.fromCurrency,
        toCurrency: quote.toCurrency,
        fromAmount: quote.fromAmount,
        toAmount: quote.toAmount,
        rate: quote.rate,
        status: 'pending',
        metadata: null,
        createdAt: now,
      };
      // Recorded, and the quote spent, before any money moves: a crash after
      // the exchange leaves a pending conversion and a used quote -- never
      // money moved with no record, nor a quote that converts twice.
      await this.state.quotes.put({ ...quote, usedBy: id });
      await this.state.conversions.put(conversion);
      try {
        await this.#engine.exchangeBalance({
          provider: PROVIDER,
          from: { currency: quote.fromCurrency, amount: quote.fromAmount },
          to: { currency: quote.toCurrency, amount: quote.toAmount },
          reason: 'conversion',
          resourceId: id,
          checkFunds: true,
          subaccountId: input.owner.pot,
        });
      } catch (error) {
        // Refused before anything moved: the quote can be used again.
        await this.state.conversions.delete(id);
        await this.state.quotes.put(quote);
        throw error;
      }
      const completed: StoredConversion = {
        ...conversion,
        status: 'completed',
      };
      await this.#engine.recordEvent({
        provider: PROVIDER,
        type: 'conversion.completed',
        resourceType: 'conversion',
        resourceId: id,
        data: { conversion_id: id },
        apply: (tx) => tx.providerState.put(PROVIDER, `conversion:${id}`, JSON.stringify(completed), now),
      });
      return completed;
    });
  }

  /* ------------------------------- schedules ------------------------------- */

  /** When a schedule next runs, from `after`; null for manual and instant. */
  nextRun(
    schedule: Pick<StoredSchedule, 'interval' | 'weeklyDays' | 'monthlyDays' | 'anchorHour'>,
    after: number,
  ): string | null {
    if (schedule.interval === 'manual' || schedule.interval === 'instant') return null;
    const hour = schedule.anchorHour ?? 10;
    const day = new Date(after);
    for (let offset = 0; offset <= 62; offset++) {
      const candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + offset, hour);
      if (candidate <= after) continue;
      const date = new Date(candidate);
      if (schedule.interval === 'daily') return date.toISOString();
      if (schedule.interval === 'weekly') {
        const name = WEEKDAYS[date.getUTCDay()]!;
        if ((schedule.weeklyDays ?? ['monday']).includes(name)) return date.toISOString();
        continue;
      }
      // "Days 29, 30 and 31 land on the last day of a shorter month."
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      const days = (schedule.monthlyDays ?? [1]).map((value) => Math.min(value, last));
      if (days.includes(date.getUTCDate())) return date.toISOString();
    }
    return null;
  }

  /** Write a schedule and queue its next run. */
  async saveSchedule(schedule: StoredSchedule, options: { fromRun?: boolean } = {}): Promise<StoredSchedule> {
    const prior = await this.state.schedules.get(schedule.currency, schedule.account);
    const next: StoredSchedule = {
      ...schedule,
      nextRunAt: this.nextRun(schedule, this.#clock.now()),
      version: (prior?.version ?? 0) + 1,
    };
    await this.state.schedules.put(next);
    const group = scheduleGroup(next.currency, next.account);
    await this.#storage.jobs.cancelGroup(group);
    // Switching to instant takes in what has already settled.
    // A run does not queue another: instant runs follow money settling.
    if (next.interval === 'instant' && !options.fromRun) await this.#queueInstant(next.currency, next.account ?? null);
    if (next.nextRunAt) {
      await this.#enqueue(
        BACHS_PAYOUT_SCHEDULE_JOB,
        { currency: next.currency, version: next.version, ...(next.account ? { account: next.account } : {}) },
        Date.parse(next.nextRunAt) - this.#clock.now(),
        group,
      );
    }
    return next;
  }

  /** An `instant` schedule "fires about a minute after funds settle", grouping what settles close together. */
  async #triggerInstant(paymentId: string): Promise<void> {
    const payment = await this.#storage.payments.byId(paymentId);
    if (!payment) return;
    const owner = await this.#actorOfPot(paymentPot(payment));
    await this.#queueInstant(settlementCurrency(payment.currency), owner.account?.id ?? null);
  }

  async #queueInstant(balance: string, account: string | null): Promise<void> {
    const schedule = await this.state.schedules.get(balance, account);
    if (!schedule || schedule.interval !== 'instant') return;
    const group = scheduleGroup(balance, account);
    const pending = await everyRow((page) => this.#storage.jobs.list({ status: 'ready', ...page }));
    const queued = pending.some((job) => job.kind === BACHS_PAYOUT_SCHEDULE_JOB && job.groupKey === group);
    if (queued) return;
    await this.#enqueue(
      BACHS_PAYOUT_SCHEDULE_JOB,
      { currency: balance, version: schedule.version, ...(account ? { account } : {}) },
      INSTANT_DELAY_MS,
      group,
    );
  }

  /**
   * `bachs.payout.schedule`: one run. "Only settled customer collections are
   * eligible", whole and oldest first, "up to what the available balance
   * covers", stopping at the first one it cannot cover. A run that cannot
   * create a payout counts a failure; three in a row return the currency to
   * `manual` with a `disabled_reason`.
   */
  handleScheduleJob = async (job: Job): Promise<void> => {
    const currency = String(job.payload.currency ?? '');
    const version = Number(job.payload.version ?? 0);
    const account = typeof job.payload.account === 'string' ? job.payload.account : null;
    let schedule = await this.state.schedules.get(currency, account);
    if (!schedule || schedule.version !== version || schedule.interval === 'manual') return;
    const now = this.#clock.nowISO();

    let error: string | null = null;
    let withdrawal: string | null = null;
    try {
      withdrawal = await this.#runSchedule(schedule);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    schedule = (await this.state.schedules.get(currency, account)) ?? schedule;
    const failures = error ? schedule.failures + 1 : 0;
    const disabled = failures >= 3;
    const next: StoredSchedule = {
      ...schedule,
      lastRunAt: now,
      lastWithdrawalId: withdrawal ?? schedule.lastWithdrawalId,
      failures: disabled ? 0 : failures,
      ...(disabled
        ? {
            interval: 'manual' as const,
            weeklyDays: null,
            monthlyDays: null,
            anchorHour: null,
            disabledReason: `Auto-payout paused after 3 consecutive failures. Last error: ${error}`,
          }
        : {}),
    };
    // The next run is queued from this run's own instant, so a long advance
    // runs every one at its own time.
    await this.saveSchedule(next, { fromRun: true });
  };

  /** Pay what is eligible. Returns the payout's id, or null when nothing was due. Throws when it cannot pay. */
  async #runSchedule(schedule: StoredSchedule): Promise<string | null> {
    await this.sweep();
    const owner = await actorFor(this.state, this.#organizationId, schedule.account);
    const available = await this.available(schedule.currency as 'USD' | 'NGN', owner.pot);
    const claimed = await this.#liveClaims();
    // "Only settled customer collections are eligible", each for what it
    // actually left in the balance: what arrived, less its fee and anything
    // refunded or being refunded.
    const collections = [];
    // What of each collection's fee the owner's own balance paid: a fee the
    // platform paid, or a destination fee it shared with the seller, did not
    // all leave it.
    const feesPaid = new Map<string, number>();
    for (const entry of await this.#ledger(owner.pot)) {
      if (entry.reason !== 'processing_fee' || !entry.resourceId) continue;
      feesPaid.set(entry.resourceId, (feesPaid.get(entry.resourceId) ?? 0) + entry.amount);
    }
    for (const payment of await this.#payments()) {
      if (payment.status !== 'successful' && payment.status !== 'partially_refunded') continue;
      if (paymentPot(payment) !== owner.pot) continue;
      if (settlementCurrency(payment.currency) !== schedule.currency || claimed.has(payment.id)) continue;
      const refunds = (await this.#storage.refunds.listByPayment(payment.id))
        .filter((refund) => refund.status !== 'failed')
        .reduce((sum, refund) => sum + refund.amount, 0);
      // A split sale leaves the owner its own part of what arrived: the fixed
      // part or the rest (split.ts), never the other party's.
      const parts = splitParts(payment, (await this.state.checkouts.byPayment(payment.id))?.split);
      const paid = amountPaidOf(payment);
      const kept = (parts ? keptBy(owner.pot, paid, parts) : paid) - (feesPaid.get(payment.id) ?? 0) - refunds;
      if (kept <= 0) continue;
      collections.push({
        payment,
        settled: convertMinor(kept, payment.currency, schedule.currency),
      });
    }
    // Nothing to pay is not a failed run, whatever the destination.
    if (collections.length === 0) return null;
    const destination = await this.state.destinations.defaultFor(schedule.payoutCurrency, schedule.account);
    if (!destination || destination.deleted || destination.status !== 'approved') {
      throw new Error(`no approved default destination for ${schedule.payoutCurrency}`);
    }
    collections.sort(
      (a, b) =>
        (a.payment.paidAt ?? a.payment.createdAt).localeCompare(b.payment.paidAt ?? b.payment.createdAt) ||
        a.payment.id.localeCompare(b.payment.id),
    );
    // A same-currency payout pays its fee on top; a quoted one takes it from
    // what leaves, so only the former needs room for it.
    const quoted = !(schedule.payoutCurrency === schedule.currency || isStablecoin(schedule.payoutCurrency));
    const taken: string[] = [];
    let total = 0;
    for (const { payment, settled } of collections) {
      const fee = quoted ? 0 : withdrawalFee(schedule.currency, destination.type, total + settled);
      // "Stops at the first collection it cannot cover."
      if (total + settled + fee > available) break;
      total += settled;
      taken.push(payment.id);
    }
    // "A run below it pays nothing and the money rolls into the next run."
    if (total === 0 || (schedule.minimum !== null && total < schedule.minimum)) return null;
    const quoteFee = quoted ? withdrawalFee(schedule.currency, destination.type, total) : 0;
    // Not enough to cover the fee of a converted payout: nothing to pay yet.
    if (quoted && total <= quoteFee) return null;

    const reference = `auto_${hexId(this.#ids, 'run', 16).slice(4)}`;
    // Claimed first, by the payout's reference, so a crash after the payout
    // cannot leave its collections free for the next run to pay again.
    for (const paymentId of taken) await this.state.schedules.claim(paymentId, payoutReference(owner, reference));
    try {
      let transfer: Transfer;
      if (!quoted) {
        transfer = await this.createPayout({
          destination,
          amount: total,
          quoteId: null,
          reference,
          metadata: {},
          schedule: schedule.currency,
          owner,
        });
      } else {
        // "Each run is quoted at that day's rate."
        const quote = await this.createQuote({
          kind: 'payout',
          from: schedule.currency,
          to: schedule.payoutCurrency,
          fromAmount: total,
          fee: quoteFee,
          rail: destination.type,
          owner,
        });
        transfer = await this.createPayout({
          destination,
          amount: null,
          quoteId: quote.id,
          reference,
          metadata: {},
          schedule: schedule.currency,
          owner,
        });
      }
      return payoutIdOf(transfer.id);
    } catch (error) {
      for (const paymentId of taken) await this.state.schedules.release(paymentId);
      throw error;
    }
  }

  /**
   * Collections a scheduled payout has taken and still holds. "If a run's
   * payout fails, its collections become eligible again" -- however it came
   * to fail, paybox's own tools included -- so a claim on a failed payout,
   * or on one that was never created, does not count.
   */
  async #liveClaims(): Promise<Set<string>> {
    const live = new Set<string>();
    for (const row of await this.state.schedules.claims()) {
      const { transferId: reference } = JSON.parse(row.value) as {
        transferId: string;
      };
      const transfer = await this.#storage.transfers.byReference(PROVIDER, reference);
      if (transfer && !['failed', 'cancelled', 'reversed'].includes(transfer.status)) {
        live.add(row.key.slice('schedule-claim:'.length));
      }
    }
    return live;
  }

  /* -------------------------------- helpers ------------------------------- */

  async #enqueue(kind: string, payload: Record<string, unknown>, delayMs: number, groupKey: string): Promise<void> {
    const now = this.#clock.nowISO();
    await this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind,
      payload,
      status: 'ready',
      runAt: new Date(this.#clock.now() + Math.max(0, delayMs)).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** A payout's core transfer reference: the owner's own, namespaced for an account. */
export function payoutReference(owner: Actor, reference: string): string {
  return ownerKey(owner.account?.id ?? null, reference);
}

/** One owner's schedule for one balance: its jobs' group. The platform's is unchanged. */
function scheduleGroup(currency: string, account: string | null | undefined): string {
  return `bachs-schedule:${ownerKey(account, currency)}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The held balance a collection lands in: NGN stays NGN, everything else settles to USD. */
export function settlementCurrency(currency: string): 'USD' | 'NGN' {
  return currency === 'NGN' ? 'NGN' : 'USD';
}

/** What Bachs' sandbox decides for a destination (connect/testing, global-payouts). */
function payoutOutcome(destination: StoredDestination): {
  status: 'completed' | 'failed';
  failureReason: string | null;
} {
  const routing = destination.routing;
  if (
    destination.type === 'bank_account' &&
    routing.bank_code === FAILING_BANK.bankCode &&
    routing.account_number === FAILING_BANK.accountNumber
  ) {
    return { status: 'failed', failureReason: PAYOUT_FAILURE };
  }
  if (destination.type === 'crypto_wallet' && String(routing.wallet_address ?? '').toLowerCase() === FAILING_WALLET) {
    return { status: 'failed', failureReason: WALLET_FAILURE };
  }
  if (destination.type === 'mobile_money') {
    const listed = MOMO_PROVIDERS[destination.currency] ?? [];
    if (!listed.some((name) => name.toLowerCase() === String(routing.mobile_provider ?? '').toLowerCase())) {
      return { status: 'failed', failureReason: MOMO_UNLISTED_FAILURE };
    }
  }
  return { status: 'completed', failureReason: null };
}
