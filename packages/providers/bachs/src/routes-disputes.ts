import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Dispute } from '@paybox/shared';
import {
  disputeIdOf,
  EVIDENCE_FIELDS,
  serializeDispute,
  serializeDisputeSummary,
  type EvidenceField,
} from './disputes.js';
import { fail } from './errors.js';
import { everyRow, newestFirst, notFound, readPage } from './http.js';
import { hexId } from './ids.js';
import { toMinor } from './money.js';
import { owns, ownerField, ownsPayment, type Actor } from './actor.js';
import type { RouteContext } from './route-context.js';
import type { StoredUpload } from './state.js';
import { bachsDisputeStatus, BACHS_DISPUTE_STATUSES } from './status.js';
import {
  assertScope,
  attachmentDisposition,
  DISPUTE_DOCUMENT_MAX_BYTES,
  disputeDocumentType,
  isInlineType,
  readMultipartFile,
  serializeUpload,
  sniffMimeType,
  UPLOAD_MAX_BYTES,
} from './uploads.js';

const PROVIDER = 'bachs' as const;

/**
 * `GET /v1/disputes`. The spec's `status` filter stops at `closed`; the guide
 * adds `prevented`, and a status a dispute can have is one it can be
 * filtered by.
 */
const listDisputesQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(BACHS_DISPUTE_STATUSES).optional(),
  from_date: z.iso.datetime({ offset: true }).optional(),
  to_date: z.iso.datetime({ offset: true }).optional(),
});

/** `DisputeEvidenceUpdateRequest`: every field optional, and any of them cleared with `null`. */
const evidenceSchema = z.object(
  Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, z.string().max(20_000).nullable().optional()])) as Record<
    EvidenceField,
    z.ZodOptional<z.ZodNullable<z.ZodString>>
  >,
);

/** "No request fields are accepted for this operation." */
const submitSchema = z.object({}).strict();

/** paybox's own: a chargeback filed by the payer's bank. */
const openDisputeSchema = z.object({
  charge_id: z.string().min(1),
  amount: z.string().optional(),
  reason: z.string().min(1).max(64).optional(),
  response_deadline_at: z.iso.datetime({ offset: true }).optional(),
  warning: z.boolean().optional(),
});

/** paybox's own: the network's side of a dispute. */
const networkSchema = z
  .object({
    status: z.enum(['won', 'lost', 'closed']).optional(),
    response_deadline_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((body) => body.status !== undefined || body.response_deadline_at !== undefined, {
    message: 'Send status, response_deadline_at, or both.',
  });

/**
 * Disputes and uploads.
 *
 * Two routes are paybox's own and say so in coverage.ts: a chargeback is
 * filed by the payer's bank and ruled on by the card network, and Bachs'
 * sandbox documents no trigger for either (its CLI's `trigger` list has no
 * dispute event). Without them nothing here could be exercised locally. A
 * third serves a public upload's bytes at the `url` the API returns.
 */
export function registerDisputeRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { storage, clock, ids, state, disputes } = ctx;
  const origin = `${ctx.baseUrl}${ctx.basePath}`;

  /** connect/disputes: "without it, the calls reach only your platform's disputes". */
  async function loadDispute(actor: Actor, id: string): Promise<Dispute> {
    const dispute = await disputes.find(id);
    const payment = dispute ? await storage.payments.byId(dispute.paymentId) : null;
    if (!dispute || !payment || !ownsPayment(actor, payment)) throw notFound('Dispute');
    return dispute;
  }

  async function view(dispute: Dispute) {
    const payment = await storage.payments.byId(dispute.paymentId);
    return serializeDispute(dispute, payment, await disputes.recordOf(dispute));
  }

  /* -------------------------------- disputes ------------------------------- */

  fastify.get('/v1/disputes', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listDisputesQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    const from = query.from_date ? Date.parse(query.from_date) : null;
    const to = query.to_date ? Date.parse(query.to_date) : null;
    const rows = [];
    for (const dispute of await everyRow((page) => storage.disputes.list({ provider: PROVIDER, ...page }))) {
      if (query.status && bachsDisputeStatus(dispute) !== query.status) continue;
      const payment = await storage.payments.byId(dispute.paymentId);
      if (!payment || !ownsPayment(actor, payment)) continue;
      const created = Date.parse(dispute.createdAt);
      if ((from !== null && created < from) || (to !== null && created > to)) continue;
      rows.push({ dispute, seq: (await disputes.recordOf(dispute)).seq || undefined, createdAt: dispute.createdAt });
    }
    rows.sort(newestFirst);
    const items = [];
    for (const { dispute } of rows.slice(offset, offset + limit)) {
      items.push(serializeDisputeSummary(dispute, await storage.payments.byId(dispute.paymentId)));
    }
    return reply.send({ total: rows.length, items });
  });

  fastify.get<{ Params: { dispute_id: string } }>('/v1/disputes/:dispute_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    return reply.send(await view(await loadDispute(actor, request.params.dispute_id)));
  });

  fastify.patch<{ Params: { dispute_id: string } }>('/v1/disputes/:dispute_id/evidence', async (request, reply) => {
    const actor = await ctx.actor(request);
    const patch = evidenceSchema.parse(request.body ?? {});
    const dispute = await loadDispute(actor, request.params.dispute_id);
    const updated = await disputes.saveEvidence(dispute.id, patch);
    const status = bachsDisputeStatus(updated);
    return reply.send({
      dispute_id: disputeIdOf(updated),
      status,
      is_response_editable: status === 'needs_response',
      evidence_updated_at: updated.updatedAt,
    });
  });

  fastify.post<{ Params: { dispute_id: string } }>('/v1/disputes/:dispute_id/submit', async (request, reply) => {
    const actor = await ctx.actor(request);
    submitSchema.parse(request.body ?? {});
    const owned = await loadDispute(actor, request.params.dispute_id);
    const { dispute, record } = await disputes.submit(owned.id);
    const submission = record.submissions.at(-1)!;
    return reply.send({
      dispute_id: disputeIdOf(dispute),
      status: bachsDisputeStatus(dispute),
      is_response_editable: false,
      submission: {
        submission_id: submission.id,
        submission_status: submission.status,
        trigger_source: submission.triggerSource,
        submitted_at: submission.submittedAt,
      },
    });
  });

  /** Emulator-only: a chargeback against a charge. */
  fastify.post('/v1/disputes', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = openDisputeSchema.parse(request.body);
    const payment = await storage.payments.byProviderTransactionId(PROVIDER, body.charge_id);
    if (!payment || !ownsPayment(actor, payment)) throw notFound('Charge');
    const { dispute, created } = await disputes.open({
      payment,
      amount: body.amount === undefined ? null : toMinor(body.amount, payment.currency, 'amount'),
      reason: body.reason ?? null,
      deadline: body.response_deadline_at ? new Date(Date.parse(body.response_deadline_at)).toISOString() : null,
      warning: body.warning ?? false,
    });
    return reply.status(created ? 201 : 200).send(await view(dispute));
  });

  /** Emulator-only: a ruling from the network, or a deadline moved earlier. */
  fastify.post<{ Params: { dispute_id: string } }>('/v1/disputes/:dispute_id/network', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = networkSchema.parse(request.body ?? {});
    const owned = await loadDispute(actor, request.params.dispute_id);
    const updated = await disputes.networkUpdate(owned.id, {
      ...(body.status ? { status: body.status } : {}),
      ...(body.response_deadline_at ? { deadline: body.response_deadline_at } : {}),
    });
    return reply.send(await view(updated));
  });

  /* --------------------------------- uploads -------------------------------- */

  async function store(input: {
    bytes: Buffer;
    fileName: string;
    mimeType: string;
    scope: string;
    private: boolean;
    owner: Actor;
  }): Promise<StoredUpload> {
    const now = clock.nowISO();
    const upload: StoredUpload = {
      ...ownerField(input.owner),
      seq: await state.nextSeq(),
      id: hexId(ids, 'upl', 12),
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      scope: input.scope,
      private: input.private,
      linkedResourceType: null,
      linkedResourceId: null,
      createdAt: now,
      updatedAt: now,
    };
    await state.uploads.putBytes(upload.id, input.bytes);
    await state.uploads.put(upload);
    return upload;
  }

  fastify.post('/v1/disputes/uploads', async (request, reply) => {
    const actor = await ctx.actor(request);
    const file = await readMultipartFile(request, DISPUTE_DOCUMENT_MAX_BYTES);
    const mimeType = disputeDocumentType(file.bytes);
    const upload = await store({ ...file, mimeType, scope: 'dispute-evidence', private: true, owner: actor });
    return reply.send({
      document_id: upload.id,
      file_name: upload.fileName,
      mime_type: upload.mimeType,
      file_size_bytes: upload.sizeBytes,
      uploaded_at: upload.createdAt,
    });
  });

  fastify.post('/v1/utilities/uploads', async (request, reply) => {
    const actor = await ctx.actor(request);
    const file = await readMultipartFile(request, UPLOAD_MAX_BYTES);
    const scope = file.fields.scope ?? 'general';
    assertScope(scope);
    const upload = await store({
      ...file,
      mimeType: sniffMimeType(file.bytes, file.declaredType),
      scope,
      private: false,
      owner: actor,
    });
    return reply.status(201).send(serializeUpload(upload, origin));
  });

  fastify.get<{ Params: { upload_id: string } }>('/v1/utilities/uploads/:upload_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const upload = await state.uploads.get(request.params.upload_id);
    if (!upload || !owns(actor, upload.account)) throw notFound('Upload');
    return reply.send(serializeUpload(upload, origin));
  });

  /** "Delete an upload that has not yet been linked to any resource." */
  fastify.delete<{ Params: { upload_id: string } }>('/v1/utilities/uploads/:upload_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const upload = await state.uploads.get(request.params.upload_id);
    if (!upload || !owns(actor, upload.account)) throw notFound('Upload');
    if (upload.linkedResourceId !== null) {
      throw fail(
        'invalid_request',
        'CONFLICT',
        `Upload is attached to ${upload.linkedResourceType} ${upload.linkedResourceId} and cannot be deleted.`,
      );
    }
    await state.uploads.delete(upload.id);
    return reply.send({ upload_id: upload.id, deleted: true });
  });

  /** Emulator-only: a public upload's bytes, at the `url` the API returns. */
  fastify.get<{ Params: { upload_id: string; file_name: string } }>(
    '/files/:upload_id/:file_name',
    async (request, reply) => {
      const upload = await state.uploads.get(request.params.upload_id);
      const bytes = upload && !upload.private ? await state.uploads.bytes(upload.id) : null;
      if (!upload || !bytes || request.params.file_name !== upload.fileName) throw notFound('File');
      // paybox serves its dashboard and control API from this origin, so a
      // type a browser would run (HTML, SVG, script) is never served inline.
      reply.header('x-content-type-options', 'nosniff');
      if (!isInlineType(upload.mimeType)) {
        return reply
          .type('application/octet-stream')
          .header('content-disposition', attachmentDisposition(upload.fileName))
          .send(bytes);
      }
      return reply.type(upload.mimeType).send(bytes);
    },
  );
}
