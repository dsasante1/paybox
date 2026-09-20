import { PayboxError, type Clock, type IdFactory } from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import {
  beepEnvelopeSchema,
  postPaymentPacketSchema,
  queryBillPacketSchema,
  queryFloatBalancePacketSchema,
  queryPaymentStatusPacketSchema,
  validateAccountPacketSchema,
} from './schemas.js';
import { beepEnvelope, major, stamp } from './serializers.js';
import {
  TINGG_BEEP_AUTH,
  TINGG_BEEP_STATUS,
  beepStatusDescription,
  toBeepStatus,
} from './status.js';
import { assertBeepCredentials, type TinggAuthOptions } from './auth.js';
import { assertCountry, normaliseMsisdn } from './rails.js';
import { numericId, type TinggState } from './state.js';
import { ensureCallbackEndpoint } from './webhook.js';

/**
 * Tingg Payouts -- the BEEP API.
 *
 * One HTTP path, `POST /v1/global-api/payments`, and a `function` field
 * selects the operation. This is RPC wearing REST's clothes, and it shares
 * nothing with Checkout 3.0 but a brand: different credentials (a
 * username/password pair **inside the body**), different envelope
 * (`{authStatus, results[]}`), different casing (camelCase with SHOUTED
 * acronyms), different amount handling.
 *
 * Verified 2026-09-20 at docs.tingg.africa/reference/postpayment,
 * /querypaymentstatus, /queryfloatbalance, /validateaccount and /querybill.
 *
 * ## Errors are not HTTP errors here
 *
 * Every documented failure comes back **200 with a code in the envelope**:
 * bad credentials are `authStatusCode: 132`, a payout over the float is
 * `statusCode: 230`. Raising an HTTP error instead would hand a Tingg client
 * a shape it has no branch for, so nothing in this file throws past the
 * function boundary -- failures become codes.
 */

export interface BeepDeps {
  engine: PaymentEngine;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  state: TinggState;
  auth: TinggAuthOptions;
  /** Settle a queued payout after a delay, the way a rail eventually would. */
  scheduleSettlement(transferId: string, outcome: 'successful' | 'failed', reason?: string): Promise<void>;
  transferFee(currency: string): number;
}

const AUTH_OK = { code: TINGG_BEEP_AUTH.SUCCESS, description: 'Authentication was successful' };
const AUTH_FAILED = { code: TINGG_BEEP_AUTH.FAILED, description: 'Authentication failed' };

/** One result row, in the shape every BEEP function answers with. */
function result(code: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { statusCode: code, statusDescription: beepStatusDescription(code), ...extra };
}

export async function handleBeepRequest(
  rawBody: unknown,
  deps: BeepDeps,
): Promise<Record<string, unknown>> {
  const parsed = beepEnvelopeSchema.safeParse(rawBody);
  if (!parsed.success) {
    // 167 is Tingg's own code for a malformed or unroutable request; its
    // querybill page gives it for a missing countryCode specifically.
    return beepEnvelope(AUTH_OK, [result(TINGG_BEEP_STATUS.INVALID_SERVICE)]);
  }
  const envelope = parsed.data;

  if (!assertBeepCredentials(envelope.payload.credentials, deps.auth)) {
    return beepEnvelope(AUTH_FAILED, []);
  }

  const packet = envelope.payload.packet;
  switch (envelope.function) {
    case 'BEEP.postPayment':
      return beepEnvelope(AUTH_OK, await mapPacket(packet, (item) => postPayment(item, envelope.countryCode, deps)));
    case 'BEEP.queryPaymentStatus':
      return beepEnvelope(AUTH_OK, await mapPacket(packet, (item) => queryPaymentStatus(item, deps)));
    case 'BEEP.queryFloatBalance':
      return beepEnvelope(AUTH_OK, await mapPacket(packet, (item) => queryFloatBalance(item, envelope.countryCode, deps)));
    case 'BEEP.validateAccount':
      return beepEnvelope(AUTH_OK, await mapPacket(packet, (item) => validateAccount(item)));
    case 'BEEP.queryBill':
      return beepEnvelope(AUTH_OK, await mapPacket(packet, (item) => queryBill(item, envelope.countryCode, deps)));
    default:
      return beepEnvelope(AUTH_OK, [result(TINGG_BEEP_STATUS.INVALID_SERVICE)]);
  }
}

/**
 * One result per packet item, in order.
 *
 * A packet is a batch, and Tingg answers each item independently -- one bad
 * entry does not sink the rest. A thrown error becomes that item's code
 * rather than the whole request's, for the same reason.
 */
async function mapPacket(
  packet: Record<string, unknown>[],
  handler: (item: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const item of packet) {
    try {
      out.push(await handler(item));
    } catch (error) {
      out.push(codeForError(error, item));
    }
  }
  return out;
}

function codeForError(error: unknown, item: Record<string, unknown>): Record<string, unknown> {
  const reference = typeof item.payerTransactionID === 'string' ? item.payerTransactionID : '';
  if (error instanceof PayboxError) {
    if (error.code === 'balance_insufficient' || error.code === 'insufficient_funds') {
      return result(TINGG_BEEP_STATUS.INSUFFICIENT_FLOAT, { payerTransactionID: reference });
    }
    if (error.code === 'duplicate_reference') {
      return result(TINGG_BEEP_STATUS.GENERIC_FAILURE, {
        payerTransactionID: reference,
        statusDescription: error.message,
      });
    }
  }
  return result(TINGG_BEEP_STATUS.GENERIC_FAILURE, { payerTransactionID: reference });
}

/* ------------------------------ postPayment ------------------------------ */

/**
 * Queue a payout.
 *
 * Answers `139` -- "Payment posted successfully and pending acknowledgement" --
 * which the documentation says is the **only** code that triggers a callback.
 * So this call commits the money and the outcome arrives later, on the
 * callback or via `queryPaymentStatus`.
 *
 * The amount is reserved against the balance at this point rather than at
 * settlement, which is the engine's default and the right one here: Tingg
 * debits the merchant's float when the payout is posted, and `230` exists
 * precisely because that float can run out.
 */
async function postPayment(
  item: Record<string, unknown>,
  countryCode: string,
  deps: BeepDeps,
): Promise<Record<string, unknown>> {
  const packet = postPaymentPacketSchema.parse(item);
  const country = assertCountry(countryCode);
  const currency = packet.currencyCode.toUpperCase();

  const existing = await deps.state.payouts.get(packet.payerTransactionID);
  if (existing) {
    // `payerTransactionID` is the merchant's unique reference, so a repeat is
    // a retry rather than a second payout. Echo the original.
    return result(TINGG_BEEP_STATUS.PENDING_ACKNOWLEDGEMENT, {
      payerTransactionID: existing.payerTransactionId,
      beepTransactionID: Number(existing.beepTransactionId),
    });
  }

  const msisdn = normaliseMsisdn(packet.MSISDN, country);
  const extra = packet.extraData ?? {};
  const callbackUrl = typeof extra.callbackUrl === 'string' ? extra.callbackUrl : null;

  const transfer = await deps.engine.createTransfer({
    provider: 'tingg',
    amount: packet.amount,
    currency,
    // Tingg's unique-by-contract identifier, which is what a canonical
    // reference has to be. The human narration stays on metadata.
    reference: packet.payerTransactionID,
    recipientName: packet.customerNames ?? null,
    recipientAccount: packet.accountNumber,
    recipientBankCode:
      typeof extra.destinationBankCode === 'string' ? extra.destinationBankCode : null,
    reason: packet.narration ?? null,
    fee: deps.transferFee(currency),
    status: 'pending',
    metadata: {
      service_code: packet.serviceCode,
      country_code: country.alpha2,
      msisdn,
      payment_mode: packet.paymentMode ?? 'Online Payment',
      ...(packet.invoiceNumber ? { invoice_number: packet.invoiceNumber } : {}),
      ...(packet.hubID ? { hub_id: packet.hubID } : {}),
      beep_extra_data: extra,
    },
  });

  const beepTransactionId = numericId(deps.ids, 11);
  await deps.state.payouts.put({
    payerTransactionId: packet.payerTransactionID,
    beepTransactionId,
    transferId: transfer.id,
    serviceCode: packet.serviceCode,
    countryCode: country.alpha2,
    msisdn,
    accountNumber: packet.accountNumber,
    currencyCode: currency,
    amount: packet.amount,
    narration: packet.narration ?? '',
    customerNames: packet.customerNames ?? '',
    callbackUrl,
    extraData: extra,
    createdAt: deps.clock.nowISO(),
  });

  if (callbackUrl) {
    await ensureCallbackEndpoint(deps.storage, { ids: deps.ids, clock: deps.clock }, callbackUrl);
  }

  // The outcome is decided here, from the destination account, and never when
  // the job runs -- so the answer is fixed before the clock moves.
  const outcome = payoutOutcome(packet.accountNumber);
  await deps.scheduleSettlement(
    transfer.id,
    outcome,
    outcome === 'failed' ? 'The rail rejected the payout' : undefined,
  );

  return result(TINGG_BEEP_STATUS.PENDING_ACKNOWLEDGEMENT, {
    payerTransactionID: packet.payerTransactionID,
    beepTransactionID: Number(beepTransactionId),
  });
}

/**
 * Which payouts fail.
 *
 * Tingg publishes no test account numbers for Payouts, so this is paybox's
 * convention and docs/tingg.md labels it as such: an account number ending
 * `0000` is rejected by the rail, everything else settles. It follows the
 * same last-four-digits idea the shared test instruments use, so a developer
 * who has read `docs/test-instruments.md` already knows the shape.
 */
function payoutOutcome(accountNumber: string): 'successful' | 'failed' {
  return accountNumber.replace(/\D/g, '').endsWith('0000') ? 'failed' : 'successful';
}

/* --------------------------- queryPaymentStatus --------------------------- */

async function queryPaymentStatus(
  item: Record<string, unknown>,
  deps: BeepDeps,
): Promise<Record<string, unknown>> {
  const packet = queryPaymentStatusPacketSchema.parse(item);
  const stored = packet.payerTransactionID
    ? await deps.state.payouts.get(packet.payerTransactionID)
    : packet.beepTransactionID !== undefined
      ? await deps.state.payouts.byBeepId(String(packet.beepTransactionID))
      : null;

  if (!stored) return result(TINGG_BEEP_STATUS.GENERIC_FAILURE);

  const transfer = await deps.engine.getTransfer(stored.transferId);
  if (!transfer) return result(TINGG_BEEP_STATUS.GENERIC_FAILURE);

  // A settled payout whose callback has not been acknowledged reads 178
  // rather than its own outcome -- that is what "pending acknowledgement from
  // the client" means, and it is why this function exists at all.
  const code = toBeepStatus(transfer.status);
  return result(code, {
    payerTransactionID: stored.payerTransactionId,
    beepTransactionID: stored.beepTransactionId,
    MSISDN: stored.msisdn,
    payerClientCode: stored.serviceCode,
    receiptNumber: transfer.status === 'successful' ? `["${stored.beepTransactionId}"]` : '[""]',
    receiverNarration: `["${stored.narration}"]`,
    totalRecordsPendingQuery: 0,
    totalRecordsPendingAck: 0,
    paymentExtraData: JSON.stringify(stored.extraData ?? {}),
  });
}

/* --------------------------- queryFloatBalance ---------------------------- */

/**
 * The merchant's float.
 *
 * Reads the balance ledger -- the same fold `paybox balance` prints and the
 * same one a payout reserves against. A separately-tracked float would be a
 * second source of truth for the one number `230` depends on.
 */
async function queryFloatBalance(
  item: Record<string, unknown>,
  countryCode: string,
  deps: BeepDeps,
): Promise<Record<string, unknown>> {
  const packet = queryFloatBalancePacketSchema.parse(item);
  const country = assertCountry(countryCode);
  const balance = await deps.engine.getBalance('tingg', country.currency);
  return result(TINGG_BEEP_STATUS.FLOAT_SUCCESS, {
    balance: major(balance),
    floatAccountName: packet.serviceCode,
    currencyCode: country.currency,
  });
}

/* ----------------------------- validateAccount ---------------------------- */

/**
 * Whether an account exists.
 *
 * Tingg publishes `307` valid, `306` invalid and `301` unavailable but no
 * test accounts, so paybox uses the same last-four convention as the payout
 * outcome above: `0000` is invalid, `9999` is a rail that cannot answer,
 * anything else is valid. Recorded in docs/tingg.md as paybox's convention.
 */
async function validateAccount(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const packet = validateAccountPacketSchema.parse(item);
  const digits = packet.accountNumber.replace(/\D/g, '');

  if (digits.endsWith('9999')) {
    return result(TINGG_BEEP_STATUS.VALIDATION_UNAVAILABLE, {
      accountNumber: packet.accountNumber,
      responseExtraData: '',
    });
  }
  if (digits.endsWith('0000')) {
    return result(TINGG_BEEP_STATUS.INVALID_ACCOUNT, {
      accountNumber: packet.accountNumber,
      active: 'no',
      responseExtraData: '',
    });
  }
  return result(TINGG_BEEP_STATUS.VALID_ACCOUNT, {
    serviceID: String(Number(digits.slice(-4)) || 1),
    accountNumber: packet.accountNumber,
    active: 'yes',
    customerName: 'John Doe',
    responseExtraData: '',
  });
}

/* -------------------------------- queryBill ------------------------------- */

/**
 * A bill for presentment.
 *
 * Deterministic from the account number rather than random, so the same
 * account always quotes the same bill -- the property a reproducible run
 * needs, and the reason nothing here touches `Math.random`.
 */
const BILL_DUE_IN_MS = 30 * 24 * 60 * 60 * 1_000;

async function queryBill(
  item: Record<string, unknown>,
  countryCode: string,
  deps: BeepDeps,
): Promise<Record<string, unknown>> {
  const packet = queryBillPacketSchema.parse(item);
  const country = assertCountry(countryCode);
  const digits = packet.accountNumber.replace(/\D/g, '');
  const dueMinor = 100_000 + (Number(digits.slice(-4)) || 0) * 100;

  return result(TINGG_BEEP_STATUS.BILL_AVAILABLE, {
    accountNumber: packet.accountNumber,
    serviceID: String(Number(digits.slice(-2)) || 5),
    serviceCode: packet.serviceCode,
    // Off the virtual clock, so `paybox time advance` can carry a bill past
    // its own due date. Tingg stamps a bare date-time, not ISO 8601.
    dueDate: stamp(new Date(deps.clock.now() + BILL_DUE_IN_MS).toISOString()),
    dueAmount: major(dueMinor),
    currency: country.currency,
    customerName: 'John Doe',
    responseExtraData: '',
  });
}
