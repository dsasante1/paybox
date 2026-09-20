import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  type Clock,
  type IdFactory,
  type Payment,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { resolveInstrument, type PaymentSimulator } from '@paybox/simulator';
import {
  assertApiKey,
  assertCheckoutCredentials,
  assertClientCredentials,
  issueToken,
  type TinggAuthOptions,
  type TinggCredentials,
} from './auth.js';
import { TINGG_ERROR_CODES, fail, tinggEnvelope, toTinggError } from './errors.js';
import { renderTinggCheckout, renderTinggResult } from './checkout.js';
import {
  CHECKOUT_TTL_MS,
  assertCountry,
  assertCurrency,
  methodForOption,
  normaliseMsisdn,
  optionLabel,
  type TinggCountry,
} from './rails.js';
import {
  acknowledgementSchema,
  chargeRequestSchema,
  checkoutChargeSchema,
  checkoutRequestSchema,
  expressRequestSchema,
  hostedPaySchema,
  refundRequestSchema,
  tokenRequestSchema,
} from './schemas.js';
import {
  CHARGE_SAVED_CODE,
  CHARGE_SAVED_DESCRIPTION,
  major,
  serializeChargeResults,
  serializeCheckoutResults,
  serializeExpressResults,
  serializeNotification,
  stamp,
} from './serializers.js';
import {
  TINGG_CHECKOUT_STATUS,
  TINGG_REFUND_STATUS,
  checkoutStatusDescription,
  toTinggStatus,
} from './status.js';
import { numericId, tinggState, type StoredCharge, type StoredCheckout } from './state.js';
import { ensureCallbackEndpoint } from './webhook.js';
import { handleBeepRequest } from './payouts.js';

export interface TinggPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  credentials: TinggCredentials;
  allowAnyKey?: boolean;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
  transferFee?: Record<string, number>;
}

const PROVIDER = 'tingg' as const;
/** Checkout 3.0's own prefix, which is part of its published URLs. */
const CHECKOUT = '/v3/checkout-api';

/**
 * Tingg-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a Tingg request can never be answered in another provider's envelope. Every
 * route translates a request into engine calls and translates the result back;
 * no payment behaviour lives here (spec §30).
 *
 * Shapes verified against docs.tingg.africa, read **2026-09-20**; the page is
 * cited beside each group. Coverage is documented honestly in docs/tingg.md.
 * Tingg's Stoplight portal at dev-portal.tingg.africa returns HTTP 403 to
 * automated fetches, the same as paystack.com/docs, so there is no pinnable
 * OpenAPI artefact to cite a commit of -- the URL and the date are the
 * citation.
 *
 * ## One mount point, two APIs
 *
 * Checkout 3.0 (`/v3/checkout-api/**`, OAuth bearer + apiKey header) and
 * Payouts (`/v1/global-api/payments`, credentials in the body) share nothing
 * but a brand. They are nonetheless served from one prefix, because a real
 * integration points one base URL at `api.tingg.africa` and calls both -- so
 * `http://localhost:8080/tingg` has to answer both for an unmodified client
 * to work.
 *
 * That is the opposite of the Flutterwave decision, and for the opposite
 * reason: v3 and v4 collide on paths and a client targets exactly one, so
 * they are two adapters at two prefixes. Here the paths are disjoint and a
 * client targets both.
 */
export const tinggPlugin: FastifyPluginAsync<TinggPluginOptions> = async (fastify, options) => {
  const { engine, simulator, storage, clock, ids } = options;
  const state = tinggState(storage, () => clock.nowISO());
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;
  const auth: TinggAuthOptions = {
    credentials: options.credentials,
    ...(options.allowAnyKey === undefined ? {} : { allowAnyKey: options.allowAnyKey }),
  };

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toTinggError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(
        tinggEnvelope(
          TINGG_ERROR_CODES.NO_REQUEST_FOUND,
          `Unknown endpoint (${request.method} ${request.url}).`,
        ),
      ),
  );

  const authenticate = (request: FastifyRequest): Promise<string> =>
    assertCheckoutCredentials(
      storage,
      {
        apiKey: headerValue(request, 'apikey'),
        authorization: request.headers.authorization,
      },
      { ...auth, now: clock.now() },
    );

  /* ------------------------------ helpers ------------------------------ */

  async function loadCheckout(merchantTransactionId: string): Promise<StoredCheckout> {
    const checkout = await state.checkouts.get(merchantTransactionId);
    if (!checkout) {
      throw fail(
        'not_found',
        TINGG_ERROR_CODES.NO_REQUEST_FOUND,
        `No checkout request found for merchant_transaction_id "${merchantTransactionId}".`,
      );
    }
    return checkout;
  }

  async function loadPayment(checkout: StoredCheckout): Promise<Payment> {
    const payment = await engine.getPayment(checkout.paymentId);
    if (!payment) {
      throw fail(
        'not_found',
        TINGG_ERROR_CODES.NO_REQUEST_FOUND,
        `Checkout ${checkout.checkoutRequestId} has no payment.`,
      );
    }
    return payment;
  }

  /**
   * Create the checkout request and its payment.
   *
   * Shared by express checkout, `checkout/request` and `checkout-charge`,
   * which take the same payload and differ only in what happens next.
   */
  async function createCheckout(
    body: ReturnType<typeof checkoutRequestSchema.parse>,
    initialStatus: 'created' | 'pending',
  ): Promise<{ checkout: StoredCheckout; payment: Payment; country: TinggCountry }> {
    const country = assertCountry(body.country_code);
    const currency = assertCurrency(body.currency_code, country);
    const msisdn = normaliseMsisdn(body.msisdn, country);

    const existing = await state.checkouts.get(body.merchant_transaction_id);
    if (existing) {
      throw fail(
        'duplicate_reference',
        TINGG_ERROR_CODES.GENERIC_FAILURE,
        `merchant_transaction_id "${body.merchant_transaction_id}" has already been used.`,
      );
    }

    const customer = body.customer_email
      ? await upsertCustomer(body.customer_email, body.customer_first_name, body.customer_last_name)
      : null;

    const expiresInMs = body.due_date
      ? Math.max(0, Date.parse(`${body.due_date.replace(' ', 'T')}Z`) - clock.now())
      : CHECKOUT_TTL_MS;

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.request_amount,
      currency,
      reference: body.merchant_transaction_id,
      providerTransactionId: numericId(ids, 6),
      customerId: customer?.id ?? null,
      // Tingg's `callback_url` is the **IPN** address, not a browser
      // redirect -- those are success_redirect_url and fail_redirect_url. The
      // canonical `callbackUrl` field means the browser one, so that is what
      // goes here and the IPN address lives on the stored checkout.
      callbackUrl: body.success_redirect_url,
      paymentMethod: methodForOption(body.payment_option_code),
      metadata: {
        account_number: body.account_number,
        service_code: body.service_code,
        ...(body.request_description ? { request_description: body.request_description } : {}),
        ...(body.invoice_number ? { invoice_number: body.invoice_number } : {}),
        ...(body.extra_data ?? {}),
      },
      status: initialStatus,
      providerStatus: String(TINGG_CHECKOUT_STATUS.PENDING),
      expiresInMs: Number.isFinite(expiresInMs) ? expiresInMs : CHECKOUT_TTL_MS,
    });

    const checkout: StoredCheckout = {
      merchantTransactionId: body.merchant_transaction_id,
      checkoutRequestId: payment.providerTransactionId,
      paymentId: payment.id,
      serviceCode: body.service_code,
      accountNumber: body.account_number,
      msisdn,
      countryCode: country.alpha3,
      currencyCode: currency,
      requestAmount: body.request_amount,
      customerFirstName: body.customer_first_name,
      customerLastName: body.customer_last_name,
      customerEmail: body.customer_email ?? null,
      requestDescription: body.request_description ?? null,
      invoiceNumber: body.invoice_number ?? null,
      callbackUrl: body.callback_url,
      successRedirectUrl: body.success_redirect_url,
      failRedirectUrl: body.fail_redirect_url,
      paymentOptionCode: body.payment_option_code ?? null,
      languageCode: body.language_code ?? 'en',
      dueDate: body.due_date ?? stamp(new Date(clock.now() + CHECKOUT_TTL_MS).toISOString()),
      shortUrl: null,
      charges: [],
      acknowledgement: null,
      createdAt: clock.nowISO(),
    };
    await state.checkouts.put(checkout);

    // Tingg has no dashboard-registered webhook address. Recording the one
    // this request named is what lets the dispatcher find it later.
    await ensureCallbackEndpoint(storage, { ids, clock }, body.callback_url);

    return { checkout, payment, country };
  }

  async function upsertCustomer(email: string, firstName: string, lastName: string) {
    const existing = await storage.customers.byEmail(PROVIDER, email);
    if (existing) return existing;
    return engine.createCustomer({ provider: PROVIDER, email, firstName, lastName });
  }

  /**
   * Post a charge against a checkout.
   *
   * The payer's number decides the outcome, through the shared instrument
   * resolver every other adapter uses -- so a developer who has read
   * `docs/test-instruments.md` already knows which numbers do what, and
   * nothing here invents a second convention.
   */
  async function postCharge(
    checkout: StoredCheckout,
    payment: Payment,
    input: { paymentOptionCode: string; chargeMsisdn: string; chargeAmount: number },
  ): Promise<{ checkout: StoredCheckout; charge: StoredCharge; payment: Payment }> {
    let current = payment;
    if (current.status === 'created') {
      current = await engine.transitionPayment(current.id, 'pending', {
        providerStatus: String(TINGG_CHECKOUT_STATUS.PENDING),
        paymentMethod: methodForOption(input.paymentOptionCode),
        paymentMethodDetails: {
          payment_option_code: input.paymentOptionCode,
          msisdn: input.chargeMsisdn,
        },
      });
    }

    const chargeRequestId = numericId(ids, 6);
    const charge: StoredCharge = {
      chargeRequestId,
      gatewayChargeUuid: numericId(ids, 19),
      paymentOptionCode: input.paymentOptionCode,
      chargeMsisdn: input.chargeMsisdn,
      chargeAmount: input.chargeAmount,
      paymentInstructions:
        `You will receive a prompt on your mobile number ${input.chargeMsisdn} to authorize ` +
        `a payment of ${checkout.currencyCode} ${major(input.chargeAmount)} for ${checkout.accountNumber}`,
      thirdPartyReference: numericId(ids, 13),
      thirdPartyId: numericId(ids, 4),
      createdAt: clock.nowISO(),
    };

    const updated: StoredCheckout = { ...checkout, charges: [...checkout.charges, charge] };
    await state.checkouts.put(updated);

    const resolution = resolveInstrument(input.chargeMsisdn, methodForOption(input.paymentOptionCode));
    await schedulePaymentOutcome(current.id, resolution.outcome);

    return { checkout: updated, charge, payment: current };
  }

  async function schedulePaymentOutcome(paymentId: string, outcome: string): Promise<void> {
    if (!autoAdvance) return;
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: 'payment.simulate',
      payload: { paymentId, outcome },
      status: 'ready',
      runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `payment:${paymentId}`,
      createdAt: clock.nowISO(),
      updatedAt: clock.nowISO(),
    });
  }

  /* ----------------------------- OAuth 2.0 ----------------------------- *
   * docs.tingg.africa/reference/generate-token                            */

  fastify.post(`/v1/oauth/token/request`, async (request, reply) => {
    // The token endpoint is authenticated by the apiKey header alone -- there
    // is no bearer token yet, which is the point of it.
    assertApiKey(headerValue(request, 'apikey'), auth);
    const body = tokenRequestSchema.parse(request.body);
    assertClientCredentials(body, auth);

    const issued = await issueToken(storage, {
      token: ids.token(40),
      refreshToken: ids.token(40),
      clientId: body.client_id,
      now: clock.now(),
      nowISO: clock.nowISO(),
    });
    return reply.send(issued);
  });

  /* --------------------------- express checkout ------------------------ *
   * docs.tingg.africa/docs/checkout-v3-express-checkout                    */

  fastify.post(`${CHECKOUT}/checkout-request/express-request`, async (request, reply) => {
    await authenticate(request);
    const body = expressRequestSchema.parse(request.body);
    const { checkout } = await createCheckout(body, 'pending');

    const url = `${options.baseUrl}${options.basePath}/checkout/${encodeURIComponent(checkout.merchantTransactionId)}`;
    await state.checkouts.put({ ...checkout, shortUrl: url });

    // Tingg returns a shortened URL and a long one. paybox serves the same
    // page from both rather than standing up a link shortener that would add
    // nothing and could only fail.
    return reply.send(
      tinggEnvelope(
        TINGG_ERROR_CODES.SUCCESS,
        'success',
        serializeExpressResults(checkout, { shortUrl: url, longUrl: url }),
      ),
    );
  });

  /* ------------------------- custom checkout API ----------------------- *
   * docs.tingg.africa/docs/checkout-v3-custom-checkout                     */

  fastify.post(`${CHECKOUT}/checkout/request`, async (request, reply) => {
    await authenticate(request);
    const body = checkoutRequestSchema.parse(request.body);
    const { checkout, payment } = await createCheckout(body, 'created');
    return reply.send(
      tinggEnvelope(
        TINGG_ERROR_CODES.SUCCESS,
        'Checkout request successfully logged in the checkout platform.',
        serializeCheckoutResults(checkout, payment),
      ),
    );
  });

  fastify.post(`${CHECKOUT}/checkout-charge`, async (request, reply) => {
    await authenticate(request);
    const body = checkoutChargeSchema.parse(request.body);
    const { checkout, payment } = await createCheckout(body, 'created');

    const charged = await postCharge(checkout, payment, {
      paymentOptionCode: body.payment_option_code ?? 'SAFKE',
      chargeMsisdn: checkout.msisdn,
      chargeAmount: body.request_amount,
    });

    // `checkout-charge` answers `status_code: 1`, not 200. Tingg's own
    // inconsistency, reproduced rather than tidied up.
    return reply.send(
      tinggEnvelope(CHARGE_SAVED_CODE, CHARGE_SAVED_DESCRIPTION, {
        checkout_results: serializeCheckoutResults(charged.checkout, charged.payment),
        charge_results: serializeChargeResults(charged.checkout, charged.charge),
      }),
    );
  });

  fastify.post(`${CHECKOUT}/charge/request`, async (request, reply) => {
    await authenticate(request);
    const body = chargeRequestSchema.parse(request.body);
    const checkout = await loadCheckout(body.merchant_transaction_id);
    const payment = await loadPayment(checkout);

    if (!['created', 'pending', 'requires_action'].includes(payment.status)) {
      throw fail(
        'invalid_state_transition',
        TINGG_ERROR_CODES.GENERIC_FAILURE,
        `Checkout ${checkout.checkoutRequestId} is ${payment.status} and cannot be charged again.`,
      );
    }

    const country = assertCountry(body.country_code ?? checkout.countryCode);
    const charged = await postCharge(checkout, payment, {
      paymentOptionCode: body.payment_option_code,
      chargeMsisdn: body.charge_msisdn
        ? normaliseMsisdn(body.charge_msisdn, country)
        : checkout.msisdn,
      chargeAmount: body.charge_amount ?? payment.amount,
    });

    return reply.send(
      tinggEnvelope(
        CHARGE_SAVED_CODE,
        CHARGE_SAVED_DESCRIPTION,
        serializeChargeResults(charged.checkout, charged.charge),
      ),
    );
  });

  /* ---------------------------- query status --------------------------- *
   * docs.tingg.africa/reference/query-status                               */

  fastify.get<{ Params: { service_code: string; merchant_transaction_id: string } }>(
    `${CHECKOUT}/query/:service_code/:merchant_transaction_id`,
    async (request, reply) => {
      await authenticate(request);
      const checkout = await loadCheckout(request.params.merchant_transaction_id);
      if (checkout.serviceCode !== request.params.service_code) {
        throw fail(
          'not_found',
          TINGG_ERROR_CODES.NO_REQUEST_FOUND,
          `No request found for service_code "${request.params.service_code}".`,
        );
      }
      const payment = await loadPayment(checkout);
      const country = assertCountry(checkout.countryCode);

      // The published page for this route renders through Tingg's Stoplight
      // portal, which 403s automated fetches, so its exact response body could
      // not be read. paybox answers in the standard checkout envelope carrying
      // the same fields the IPN does -- recorded in docs/tingg.md as paybox's
      // choice rather than a transcription.
      return reply.send(
        tinggEnvelope(
          TINGG_ERROR_CODES.SUCCESS,
          checkoutStatusDescription(Number(toTinggStatus(payment.status))),
          serializeNotification(checkout, payment, {
            countryAbbrv: country.alpha2,
            requestDate: stamp(checkout.createdAt),
          }),
        ),
      );
    },
  );

  /* --------------------------- acknowledgement -------------------------- *
   * docs.tingg.africa/reference/acknowledgement-1                          */

  fastify.post(`${CHECKOUT}/acknowledgement/request`, async (request, reply) => {
    await authenticate(request);
    const body = acknowledgementSchema.parse(request.body);
    const checkout = await loadCheckout(body.merchant_transaction_id);
    const payment = await loadPayment(checkout);

    const type = body.acknowledgement_type.trim().toLowerCase();
    if (type !== 'full' && type !== 'partial') {
      throw fail(
        'invalid_request',
        TINGG_ERROR_CODES.NOT_JSON,
        'acknowledgement_type must be "Full" or "Partial".',
      );
    }
    // Documented as a conditional the flat schema cannot express: "required
    // for partial payments".
    if (type === 'partial' && body.acknowledgement_amount === undefined) {
      throw fail(
        'invalid_request',
        TINGG_ERROR_CODES.INVALID_AMOUNT,
        'acknowledgement_amount is required when acknowledgement_type is Partial.',
      );
    }

    await state.checkouts.put({
      ...checkout,
      acknowledgement: {
        statusCode: String(body.status_code),
        reference: body.acknowledgment_reference,
        type: body.acknowledgement_type,
        amount: body.acknowledgement_amount ?? null,
        narration: body.acknowledgement_narration ?? null,
        at: clock.nowISO(),
      },
    });

    return reply.send(
      tinggEnvelope(TINGG_ERROR_CODES.SUCCESS, 'Acknowledgement received successfully.', {
        checkout_request_id: Number(checkout.checkoutRequestId),
        merchant_transaction_id: checkout.merchantTransactionId,
        amount_paid: major(body.acknowledgement_amount ?? payment.amount),
        currency_code: body.currency_code.toUpperCase(),
        acknowledgment_reference: body.acknowledgment_reference,
        status_code: String(body.status_code),
      }),
    );
  });

  /* ------------------------------- refunds ------------------------------ *
   * docs.tingg.africa/reference/refund                                     */

  fastify.post(`${CHECKOUT}/refund/request`, async (request, reply) => {
    await authenticate(request);
    const body = refundRequestSchema.parse(request.body);
    const checkout = await loadCheckout(body.merchant_transaction_id);
    const payment = await loadPayment(checkout);

    const type = body.refund_type.trim().toLowerCase();
    if (type !== 'full' && type !== 'partial') {
      throw fail(
        'invalid_request',
        TINGG_ERROR_CODES.NOT_JSON,
        'refund_type must be "Full" or "Partial".',
      );
    }
    if (type === 'partial' && body.amount === undefined) {
      throw fail(
        'invalid_request',
        TINGG_ERROR_CODES.INVALID_AMOUNT,
        'amount is required when refund_type is Partial.',
      );
    }

    await engine.createRefund({
      paymentId: payment.id,
      ...(type === 'partial' && body.amount !== undefined ? { amount: body.amount } : {}),
      reason: body.refund_narration,
      metadata: {
        refund_reference: body.refund_reference,
        refund_type: body.refund_type,
        service_code: body.service_code,
        ...(body.payment_id ? { payment_id: body.payment_id } : {}),
        tingg_status_code:
          type === 'partial'
            ? TINGG_REFUND_STATUS.PARTIAL_INITIATED
            : TINGG_REFUND_STATUS.FULL_INITIATED,
      },
    });

    return reply.send(
      tinggEnvelope(TINGG_ERROR_CODES.SUCCESS, 'Reversal request was successful.', {
        checkout_request_id: Number(checkout.checkoutRequestId),
        merchant_transaction_id: checkout.merchantTransactionId,
      }),
    );
  });

  /* ------------------------------- payouts ------------------------------ *
   * docs.tingg.africa/docs/payouts-get-started                             */

  fastify.post(`/v1/global-api/payments`, async (request, reply) => {
    // No header authentication on purpose: BEEP's credentials are a
    // username/password pair inside the body, and a failure is a code in the
    // envelope rather than an HTTP error. See payouts.ts.
    const body = await handleBeepRequest(request.body, {
      engine,
      storage,
      clock,
      ids,
      state,
      auth,
      transferFee: (currency) => options.transferFee?.[currency.toUpperCase()] ?? 0,
      async scheduleSettlement(transferId, outcome, reason) {
        if (!autoAdvance) return;
        await storage.jobs.enqueue({
          id: ids.next('job'),
          kind: 'transfer.settle',
          payload: { transferId, outcome, ...(reason ? { reason } : {}) },
          status: 'ready',
          runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
          attempt: 0,
          maxAttempts: 1,
          leaseExpiresAt: null,
          lastError: null,
          groupKey: `transfer:${transferId}`,
          createdAt: clock.nowISO(),
          updatedAt: clock.nowISO(),
        });
      },
    });
    return reply.send(body);
  });

  /* --------------------------- hosted checkout -------------------------- *
   * Emulator surface. Tingg's own page lives on a Tingg domain.            */

  fastify.get<{ Params: { reference: string } }>(
    '/checkout/:reference',
    async (request, reply) => {
      const checkout = await loadCheckout(request.params.reference);
      const payment = await loadPayment(checkout);

      if (!['created', 'pending', 'requires_action'].includes(payment.status)) {
        return reply.type('text/html').send(
          renderTinggResult(checkout, {
            heading: payment.status === 'successful' ? 'Payment received' : 'Payment not completed',
            detail: checkoutStatusDescription(Number(toTinggStatus(payment.status))),
            redirectTo:
              payment.status === 'successful'
                ? checkout.successRedirectUrl
                : checkout.failRedirectUrl,
          }),
        );
      }

      return reply.type('text/html').send(
        renderTinggCheckout(checkout, {
          amountMinor: payment.amount,
          action: `${options.basePath}/checkout/${encodeURIComponent(checkout.merchantTransactionId)}`,
        }),
      );
    },
  );

  fastify.post<{ Params: { reference: string } }>(
    '/checkout/:reference',
    async (request, reply) => {
      const checkout = await loadCheckout(request.params.reference);
      const payment = await loadPayment(checkout);
      const form = hostedPaySchema.parse(request.body ?? {});
      const country = assertCountry(checkout.countryCode);

      if (!['created', 'pending', 'requires_action'].includes(payment.status)) {
        throw fail(
          'invalid_state_transition',
          TINGG_ERROR_CODES.GENERIC_FAILURE,
          `This checkout is ${payment.status} and can no longer be paid.`,
        );
      }

      const optionCode = form.payment_option_code?.trim() || checkout.paymentOptionCode || 'SAFKE';
      const charged = await postCharge(checkout, payment, {
        paymentOptionCode: optionCode,
        chargeMsisdn: form.msisdn ? normaliseMsisdn(form.msisdn, country) : checkout.msisdn,
        chargeAmount: payment.amount,
      });

      return reply.type('text/html').send(
        renderTinggResult(charged.checkout, {
          heading: 'Authorisation sent',
          detail: `${optionLabel(optionCode)} — ${charged.charge.paymentInstructions}`,
          redirectTo: checkout.successRedirectUrl,
        }),
      );
    },
  );

  // `simulator` is wired for parity with the other adapters and for the
  // control API to reach; the charge path schedules through the same
  // `payment.simulate` job it handles.
  void simulator;
};

/** Fastify lowercases header names; Tingg's docs write `apiKey`. */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Mount the plugin on an existing instance — used by the coverage test. */
export async function registerTingg(
  app: FastifyInstance,
  options: TinggPluginOptions,
): Promise<void> {
  await app.register(tinggPlugin, { ...options, prefix: options.basePath });
}

export { PayboxError };
