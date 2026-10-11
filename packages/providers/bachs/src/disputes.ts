import type { Clock, Dispute, IdFactory, Metadata, Payment, PayboxEvent } from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { paymentPot } from './actor.js';
import { fail } from './errors.js';
import { disputeIdOf, hexId } from './ids.js';
import { everyRow } from './http.js';
import { chargeLock, disputeLock, withLock } from './locks.js';
import { toDecimal } from './money.js';
import { customerName, dataTime } from './serializers.js';
import { bachsState, type BachsState, type StoredDispute } from './state.js';
import { bachsDisputeStatus, isOpenDispute, type BachsDisputeStatus } from './status.js';
import type { BachsTreasury } from './treasury.js';
import { requireUpload } from './uploads.js';

/**
 * Bachs disputes.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (listDisputes,
 * getDispute, uploadDisputeDocument, updateDisputeEvidence, submitDispute),
 * guides/disputes/overview, connect/disputes, for-you/fees and the
 * dispute-created and dispute-updated event pages. docs/bachs.md records
 * where they disagree.
 *
 * A dispute is a core `Dispute` row, so paybox's generic tooling (the
 * control API, `paybox dispute`, the event log) sees it. Bachs' own status is
 * stored in `providerStatus`; the canonical status follows it:
 *
 *   needs_response  awaiting_merchant_feedback
 *   under_review    awaiting_bank_feedback
 *   won, lost,      resolved
 *   closed, prevented
 *
 * Money is not moved here. The treasury works out the fee, the amount set
 * aside and its release from the dispute rows themselves
 * (`BachsTreasury.#disputeMovements`), whatever path moved each one.
 */
const PROVIDER = 'bachs' as const;

/** "Deadlines ... are typically 7–21 days"; Bachs' own example gives 14, ending at 23:59:59 UTC. */
const RESPONSE_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

/** `DisputeEvidenceUpdateRequest`'s fields, in the spec's order. */
export const EVIDENCE_FIELDS = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy_attachment_id',
  'cancellation_policy_disclosure',
  'customer_communication_attachment_id',
  'customer_email_address',
  'customer_name',
  'notes',
  'product_description',
  'refund_policy_attachment_id',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'uncategorized_attachment_id',
] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

const NON_NULLABLE_EVIDENCE: readonly EvidenceField[] = [
  'access_activity_log',
  'cancellation_policy_attachment_id',
  'refund_policy_attachment_id',
];

const ATTACHMENT_FIELDS: readonly EvidenceField[] = [
  'cancellation_policy_attachment_id',
  'customer_communication_attachment_id',
  'refund_policy_attachment_id',
  'uncategorized_attachment_id',
];

export type Ruling = 'won' | 'lost' | 'closed';

/** won: the claim was declined; lost: the claim stood. `closed` has no ruling. */
const RESOLUTION = { won: 'declined', lost: 'merchant-accepted', closed: null } as const;

interface DisputeDeps {
  engine: PaymentEngine;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  treasury: BachsTreasury;
}

export class BachsDisputes {
  readonly #engine: PaymentEngine;
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #treasury: BachsTreasury;
  readonly state: BachsState;

  constructor(deps: DisputeDeps) {
    this.#engine = deps.engine;
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#treasury = deps.treasury;
    this.state = bachsState(deps.storage, () => deps.clock.nowISO());
  }

  /** A Bachs dispute by its `dsp_` id, or by paybox's own id for it. */
  async find(id: string): Promise<Dispute | null> {
    const byBachsId = await this.#storage.disputes.byProviderDisputeId(PROVIDER, id);
    if (byBachsId) return byBachsId;
    const byCoreId = await this.#storage.disputes.byId(id);
    if (byCoreId) return byCoreId.provider === PROVIDER ? byCoreId : null;
    // One opened by paybox's own tooling, by the id derived for it.
    const all = await everyRow((page) => this.#storage.disputes.list({ provider: PROVIDER, ...page }));
    return all.find((dispute) => disputeIdOf(dispute) === id) ?? null;
  }

  /**
   * What is left of a charge to dispute or refund: a lost dispute's amount
   * "has gone back to the customer" as surely as a refund's, though the engine
   * records it as neither.
   */
  async lostOn(paymentId: string): Promise<number> {
    let lost = 0;
    for (const dispute of await this.#storage.disputes.listByPayment(paymentId)) {
      if (dispute.provider === PROVIDER && dispute.providerStatus === 'lost') lost += dispute.refundAmount;
    }
    return lost;
  }

  /**
   * A chargeback arrives from the payer's bank, which nothing in a sandbox can
   * produce, so this is reached only through paybox's emulator-only route.
   *
   * One open dispute per charge. A warning is the exception that proves it:
   * "if a warned payment goes on to become a dispute, both fees apply", so a
   * dispute opened on a payment whose warning is still open turns that
   * record into the dispute rather than adding a second.
   */
  async open(input: {
    payment: Payment;
    /** Minor units; null for everything still disputable. */
    amount: number | null;
    reason: string | null;
    deadline: string | null;
    warning: boolean;
  }): Promise<{ dispute: Dispute; created: boolean }> {
    return withLock(chargeLock(input.payment.id), async () => {
      const payment = (await this.#storage.payments.byId(input.payment.id))!;
      const disputable = payment.amount - payment.amountRefunded - (await this.lostOn(payment.id));
      const amount = input.amount ?? disputable;
      if (amount <= 0 || amount > disputable) {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          `amount: must be positive and at most what is left of the charge (${toDecimal(disputable, payment.currency)}).`,
        );
      }
      for (const existing of await this.#storage.disputes.listByPayment(payment.id)) {
        if (existing.provider !== PROVIDER || !isOpenDispute(bachsDisputeStatus(existing))) continue;
        const escalated = await withLock(disputeLock(existing.id), () => this.#escalate(existing, { ...input, amount }));
        if (!escalated) throw fail('invalid_request', 'CONFLICT', 'An open dispute already exists for this charge.');
        await this.#treasury.sweep();
        return { dispute: escalated, created: false };
      }

      const now = this.#clock.now();
      const deadline = input.deadline ?? defaultDeadline(now);
      const id = hexId(this.#ids, 'dsp', 12);
      await this.state.disputes.put({
        seq: await this.state.nextSeq(),
        id,
        warning: input.warning,
        escalatedAt: null,
        evidenceUpdatedAt: null,
        submissions: [],
      });
      let dispute: Dispute;
      try {
        dispute = await this.#engine.createDispute({
          paymentId: payment.id,
          category: input.reason ?? 'fraudulent',
          refundAmount: amount,
          dueAt: deadline,
          providerDisputeId: id,
          providerStatus: 'needs_response',
          evidence: await this.#prefill(payment),
        });
      } catch (error) {
        await this.state.disputes.delete(id);
        throw error;
      }
      await this.#treasury.sweep();
      return { dispute, created: true };
    });
  }

  /**
   * A warned payment that "goes on to become a dispute": the warning's record
   * becomes the dispute, with the dispute's own amount, reason and deadline
   * where given. Null when `existing` is not a warning that can escalate.
   */
  async #escalate(
    existing: Dispute,
    input: { amount: number; reason: string | null; deadline: string | null; warning: boolean },
  ): Promise<Dispute | null> {
    const id = disputeIdOf(existing);
    const record = await this.state.disputes.get(id);
    if (input.warning || !record?.warning || record.escalatedAt !== null) return null;
    await this.state.disputes.put({ ...record, escalatedAt: this.#clock.nowISO() });
    const { result } = await this.#engine.recordEvent({
      provider: PROVIDER,
      type: 'dispute.escalated',
      resourceType: 'dispute',
      resourceId: existing.id,
      data: { dispute_id: id, amount: input.amount, reason: input.reason, response_deadline_at: input.deadline },
      apply: (tx) =>
        tx.disputes.update(existing.id, {
          refundAmount: input.amount,
          ...(input.reason ? { category: input.reason } : {}),
          ...(input.deadline ? { dueAt: input.deadline } : {}),
          updatedAt: this.#clock.nowISO(),
        }),
    });
    return result!;
  }

  /**
   * "When we have them on file, `customer_email_address`, `customer_name`,
   * and `billing_address` arrive already filled in from the customer record
   * attached to the disputed charge."
   */
  async #prefill(payment: Payment): Promise<Metadata> {
    const evidence: Metadata = {};
    const customer = payment.customerId ? await this.#storage.customers.byId(payment.customerId) : null;
    if (!customer) return evidence;
    const stored = await this.state.customers.get(customer.providerCustomerId);
    const name = customerName(customer, stored);
    if (customer.email) evidence.customer_email_address = customer.email;
    if (name) evidence.customer_name = name;
    const address = formatAddress(stored?.billingAddress ?? null);
    if (address) evidence.billing_address = address;
    return evidence;
  }

  /** `PATCH /v1/disputes/{id}/evidence`: a partial save, any number of times while editable. */
  async saveEvidence(id: string, patch: Partial<Record<EvidenceField, string | null>>): Promise<Dispute> {
    return this.#locked(id, async (dispute, record) => {
      this.#assertEditable(dispute);
      // Every reference is checked before anything is attached, so a refused
      // request attaches nothing.
      const attaching = [];
      for (const field of ATTACHMENT_FIELDS) {
        const uploadId = patch[field];
        if (typeof uploadId !== 'string') continue;
        attaching.push(
          await requireUpload(this.state, uploadId, field, {
            type: 'dispute',
            id: disputeIdOf(dispute),
            account: await this.#ownerOf(dispute),
          }),
        );
      }
      for (const upload of attaching) {
        if (upload.linkedResourceId !== null) continue;
        await this.state.uploads.put({
          ...upload,
          linkedResourceType: 'dispute',
          linkedResourceId: disputeIdOf(dispute),
          updatedAt: this.#clock.nowISO(),
        });
      }
      const updated = await this.#engine.addDisputeEvidence(dispute.id, patch);
      // An attachment cleared or replaced is free again, unless another field
      // still names it.
      const kept = new Set(ATTACHMENT_FIELDS.map((field) => updated.evidence?.[field]));
      for (const field of ATTACHMENT_FIELDS) {
        const previous = dispute.evidence?.[field];
        if (typeof previous !== 'string' || kept.has(previous)) continue;
        const upload = await this.state.uploads.get(previous);
        if (upload?.linkedResourceType === 'dispute' && upload.linkedResourceId === disputeIdOf(dispute)) {
          await this.state.uploads.put({
            ...upload,
            linkedResourceType: null,
            linkedResourceId: null,
            updatedAt: this.#clock.nowISO(),
          });
        }
      }
      await this.state.disputes.put({ ...record, evidenceUpdatedAt: updated.updatedAt });
      return updated;
    });
  }

  /** `POST /v1/disputes/{id}/submit`: "irreversible and locks further evidence edits". */
  async submit(id: string): Promise<{ dispute: Dispute; record: StoredDispute }> {
    return this.#locked(id, async (dispute, record) => {
      this.#assertEditable(dispute);
      const submittedAt = this.#clock.nowISO();
      const next: StoredDispute = {
        ...record,
        submissions: [
          ...record.submissions,
          {
            id: hexId(this.#ids, 'dse', 12),
            status: 'submitted',
            triggerSource: 'merchant_submit',
            submittedAt,
            failedAt: null,
            attemptSequence: record.submissions.length + 1,
          },
        ],
      };
      await this.state.disputes.put(next);
      // "Saving or submitting evidence does not send dispute.updated": the
      // event is recorded under a name the webhook formatter does not send.
      const updated = await this.#engine.transitionDispute(dispute.id, 'awaiting_bank_feedback', {
        providerStatus: 'under_review',
        eventType: 'dispute.submitted',
      });
      return { dispute: updated, record: next };
    });
  }

  /**
   * The network's side, which a sandbox cannot produce: a ruling, or a
   * deadline that "can also move earlier after a dispute is created".
   * Reached only through paybox's emulator-only route.
   */
  async networkUpdate(id: string, input: { status?: Ruling; deadline?: string }): Promise<Dispute> {
    return this.#locked(id, async (dispute) => {
      const status = bachsDisputeStatus(dispute);
      if (!isOpenDispute(status)) {
        throw fail('invalid_state_transition', 'CONFLICT', `The dispute is already ${status}.`);
      }
      const record = await this.recordOf(dispute);
      if (input.status && input.status !== 'closed' && record.warning && record.escalatedAt === null) {
        // A warning is not a chargeback: nothing has been filed to win or lose.
        throw fail(
          'invalid_state_transition',
          'CONFLICT',
          'A dispute warning has no ruling. Close it, or open a dispute on the charge to escalate it.',
        );
      }
      let current = dispute;
      if (input.deadline !== undefined) {
        if (Date.parse(input.deadline) >= Date.parse(dispute.dueAt)) {
          throw fail(
            'validation_failed',
            'VALIDATION_ERROR',
            'response_deadline_at: a deadline can only move earlier.',
          );
        }
        const dueAt = new Date(Date.parse(input.deadline)).toISOString();
        // Through the event log like every other change: the deadline is part
        // of the dispute's history. Not a status change, so no dispute.updated.
        const { result } = await this.#engine.recordEvent({
          provider: PROVIDER,
          type: 'dispute.deadline_moved',
          resourceType: 'dispute',
          resourceId: dispute.id,
          data: { dispute_id: disputeIdOf(dispute), from: dispute.dueAt, to: dueAt },
          apply: (tx) => tx.disputes.update(dispute.id, { dueAt, updatedAt: this.#clock.nowISO() }),
        });
        current = result!;
      }
      if (input.status === 'lost') await this.#assertLosable(current);
      if (input.status) current = await this.#rule(current, input.status);
      return current;
    });
  }

  /**
   * A loss sends the disputed amount back to the customer. If a refund still
   * in flight would send the same money back again, the refund wins: it will
   * prevent the dispute when it settles, so a loss is refused meanwhile.
   */
  async #assertLosable(dispute: Dispute): Promise<void> {
    const payment = (await this.#storage.payments.byId(dispute.paymentId))!;
    let refunding = 0;
    for (const refund of await this.#storage.refunds.listByPayment(payment.id)) {
      if (refund.status !== 'failed') refunding += refund.amount;
    }
    const lost = await this.lostOn(payment.id);
    if (refunding + lost + dispute.refundAmount > payment.amount) {
      throw fail(
        'invalid_state_transition',
        'CONFLICT',
        'A refund of this charge is still in flight; it prevents the dispute when it settles.',
      );
    }
  }

  async #rule(dispute: Dispute, ruling: Ruling | 'prevented'): Promise<Dispute> {
    const updated = await this.#engine.transitionDispute(dispute.id, 'resolved', {
      providerStatus: ruling,
      resolution: ruling === 'prevented' ? null : RESOLUTION[ruling],
      eventType: 'dispute.resolved',
    });
    await this.#treasury.sweep();
    return updated;
  }

  /**
   * `prevented`: "The customer was refunded before any ruling. The refund
   * moves the money, nothing else is set aside." A refund that succeeds while
   * a dispute on the charge is undecided prevents it once the charge's refunds
   * cover the disputed amount; a smaller refund leaves the dispute standing.
   */
  onRefundSucceeded = async (event: PayboxEvent): Promise<void> => {
    if (event.type !== 'refund.successful' || event.provider !== PROVIDER) return;
    const refund = await this.#storage.refunds.byId(event.resourceId);
    if (!refund) return;
    for (const dispute of await this.#storage.disputes.listByPayment(refund.paymentId)) {
      if (dispute.provider !== PROVIDER) continue;
      await withLock(disputeLock(dispute.id), async () => {
        const current = await this.#storage.disputes.byId(dispute.id);
        const payment = await this.#storage.payments.byId(refund.paymentId);
        if (!current || !payment || !isOpenDispute(bachsDisputeStatus(current))) return;
        if (payment.amountRefunded >= current.refundAmount) await this.#rule(current, 'prevented');
      });
    }
  };

  /** The Bachs id of the account that owns a dispute's charge; null for the platform. */
  async #ownerOf(dispute: Dispute): Promise<string | null> {
    const payment = await this.#storage.payments.byId(dispute.paymentId);
    const pot = payment ? paymentPot(payment) : null;
    if (pot === null) return null;
    return (await this.state.accounts.all()).find((account) => account.engineId === pot)?.id ?? null;
  }

  /** The Bachs record, or the defaults a dispute opened by paybox's own tooling reads as. */
  async recordOf(dispute: Dispute): Promise<StoredDispute> {
    return (
      (await this.state.disputes.get(disputeIdOf(dispute))) ?? {
        seq: 0,
        id: disputeIdOf(dispute),
        warning: false,
        escalatedAt: null,
        evidenceUpdatedAt: null,
        submissions: [],
      }
    );
  }

  async #locked<T>(id: string, fn: (dispute: Dispute, record: StoredDispute) => Promise<T>): Promise<T> {
    const found = await this.find(id);
    if (!found) throw fail('not_found', 'NOT_FOUND', 'Dispute not found');
    return withLock(disputeLock(found.id), async () => {
      const dispute = (await this.#storage.disputes.byId(found.id))!;
      return fn(dispute, await this.recordOf(dispute));
    });
  }

  /**
   * "Saving or submitting evidence after `response_deadline_at` returns `410
   * DEADLINE_PASSED`. If the dispute is already locked, you get `409
   * DISPUTE_NOT_EDITABLE` instead."
   */
  #assertEditable(dispute: Dispute): void {
    if (bachsDisputeStatus(dispute) !== 'needs_response') {
      throw fail('invalid_state_transition', 'DISPUTE_NOT_EDITABLE', 'Dispute evidence can no longer be edited.');
    }
    if (this.#clock.now() > Date.parse(dispute.dueAt)) {
      throw fail('invalid_state_transition', 'DEADLINE_PASSED', 'The response deadline for this dispute has passed.');
    }
  }
}

export { disputeIdOf };

function defaultDeadline(now: number): string {
  const day = new Date(now + RESPONSE_WINDOW_DAYS * DAY_MS);
  day.setUTCHours(23, 59, 59, 0);
  return day.toISOString();
}

/** The customer's billing address as one line: evidence takes a string. */
function formatAddress(address: Record<string, unknown> | null): string | null {
  if (!address) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'postal_code', 'country']
    .map((key) => address[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

/* ------------------------------- serialisers ------------------------------- */

function common(dispute: Dispute, payment: Payment | null, status: BachsDisputeStatus) {
  return {
    dispute_id: disputeIdOf(dispute),
    charge_id: payment?.providerTransactionId ?? null,
    amount: toDecimal(dispute.refundAmount, dispute.currency),
    currency: dispute.currency,
    status,
    is_response_editable: status === 'needs_response',
    reason: dispute.category,
    response_deadline_at: dispute.dueAt,
  };
}

/** `DisputeSummary`, a list item. */
export function serializeDisputeSummary(dispute: Dispute, payment: Payment | null) {
  return {
    ...common(dispute, payment, bachsDisputeStatus(dispute)),
    created_at: dispute.createdAt,
    updated_at: dispute.updatedAt,
  };
}

/** `DisputeResponse`: the summary plus the evidence draft and the latest submission. */
export function serializeDispute(dispute: Dispute, payment: Payment | null, record: StoredDispute) {
  const evidence: Record<string, unknown> = {};
  for (const field of EVIDENCE_FIELDS) {
    const value = dispute.evidence?.[field] ?? null;
    // Three fields are typed as plain strings in `DisputeEvidence`, not
    // nullable ones: unset, they are left out rather than sent as null.
    if (value === null && NON_NULLABLE_EVIDENCE.includes(field)) continue;
    evidence[field] = value;
  }
  const latest = record.submissions.at(-1) ?? null;
  return {
    ...common(dispute, payment, bachsDisputeStatus(dispute)),
    evidence,
    latest_submission: latest
      ? {
          submission_id: latest.id,
          status: latest.status,
          trigger_source: latest.triggerSource,
          submitted_at: latest.submittedAt,
          failed_at: latest.failedAt,
          attempt_sequence: latest.attemptSequence,
        }
      : null,
    created_at: dispute.createdAt,
    updated_at: dispute.updatedAt,
  };
}

/** The dispute-created and dispute-updated event pages' `data`. */
export function disputeWebhookData(dispute: Dispute, payment: Payment | null, status: BachsDisputeStatus) {
  const view = common(dispute, payment, status);
  return {
    ...view,
    response_deadline_at: dataTime(dispute.dueAt),
    created_at: dataTime(dispute.createdAt),
    updated_at: dataTime(dispute.updatedAt),
    charge_amount: payment ? toDecimal(payment.amount, payment.currency) : null,
    charge_currency: payment?.currency ?? null,
  };
}
