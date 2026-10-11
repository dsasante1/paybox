import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Actor } from './actor.js';
import {
  applyConfiguration,
  BUSINESS_STRUCTURES,
  capabilityView,
  outstanding,
  PERSONA_CAPABILITIES,
  PRODUCT_CATEGORIES,
  requirementsOf,
  serializeAccount,
  serializePerson,
  type CapabilityRequest,
  type Requirement,
} from './accounts.js';
import { fail } from './errors.js';
import { notFound, readPage } from './http.js';
import { alnumId, derivedId, hexId } from './ids.js';
import { withLock } from './locks.js';
import { isStablecoin } from './rates.js';
import { BANKS, MOMO_COUNTRIES } from './reference.js';
import type { RouteContext } from './route-context.js';
import { CORRIDORS } from './routes-checkout.js';
import { feeHandlingOf, settingsOf } from './settings.js';
import type {
  StoredAccount,
  StoredAccountDocument,
  StoredAccountLink,
  StoredDestination,
  StoredPerson,
  StoredRequirementValue,
} from './state.js';

const PROVIDER = 'bachs' as const;

/** createAccountLink: the spec's example expires 30 days out (the guides say an hour); read `expires_at`. */
const LINK_TTL_MS = 30 * 86_400_000;

/** Balances a connected account can hold: "balance currencies = USD, NGN only", USD always. */
const BALANCE_CURRENCIES = ['USD', 'NGN'];

/** The country a payout destination's currency is routed in, for its bank and network lists. */
const CURRENCY_COUNTRY: Record<string, string> = { NGN: 'NG', GHS: 'GH', KES: 'KE', TZS: 'TZ', UGX: 'UG' };
/** connect/requirements: inline payout destinations reach these routes. */
const INLINE_BANK = ['NGN', 'GHS', 'KES', 'TZS', 'UGX'];
const INLINE_MOMO = ['GHS', 'KES', 'TZS'];

const trimmedName = z
  .string()
  .max(255)
  .nullable()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : value === undefined ? undefined : null));

const configurationSchema = z.record(
  z.string(),
  z
    .object({ capabilities: z.record(z.string(), z.object({ requested: z.boolean() })).optional() })
    .nullable()
    .optional(),
);

/** `CreateConnectedAccountRequest`. Unknown fields are "silently defaulted", not refused. */
const createAccountSchema = z.object({
  contact_email: z.email().transform((value) => value.trim().toLowerCase()),
  display_name: z.string().max(255).nullable().optional(),
  first_name: trimmedName,
  last_name: trimmedName,
  country: z.string().regex(/^[A-Za-z]{2}$/).nullable().optional(),
  entity_type: z.enum(['company', 'individual']).nullable().optional(),
  configuration: configurationSchema.nullable().optional(),
  responsibilities: z.object({ fees: z.object({ collector: z.enum(['platform', 'bachs']) }) }).nullable().optional(),
});

/** `UpdateAccountRequest`. */
const updateAccountSchema = z.object({
  configuration: configurationSchema.nullable().optional(),
  display_name: z.string().max(255).optional(),
  contact_email: z.email().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  balance_currencies: z.record(z.string(), z.boolean()).nullable().optional(),
});

const relationshipSchema = z
  .object({
    representative: z.boolean().optional(),
    owner: z.boolean().optional(),
    director: z.boolean().optional(),
    executive: z.boolean().optional(),
    percent_ownership: z.number().int().min(0).max(100).nullable().optional(),
    title: z.string().max(255).nullable().optional(),
  })
  .optional();

/** `PersonWriteRequest`: omitted keys untouched, explicit `null` clears. */
const personSchema = z.object({
  first_name: z.string().max(255).nullable().optional(),
  last_name: z.string().max(255).nullable().optional(),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dob: YYYY-MM-DD.')
    .nullable()
    .optional(),
  address: z.record(z.string(), z.unknown()).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  email: z.string().nullable().optional(),
  id_number: z.string().min(1).optional(),
  relationship: relationshipSchema,
});

const linkSchema = z.object({
  type: z.enum(['onboarding', 'update']),
  refresh_url: z.url(),
  return_url: z.url(),
  collection_options: z.record(z.string(), z.unknown()).nullable().optional(),
});

const documentSchema = z.object({ file: z.string().min(1), document: z.string().min(1), side: z.string().optional() });

const reviewSchema = z.object({
  field: z.string().min(1),
  outcome: z.enum(['accept', 'reject']),
  code: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
});

const capabilityControlSchema = z.object({ status: z.enum(['active', 'restricted']) });

type FieldError = { field: string; message: string; code: string };

/**
 * Connect: connected accounts, persons, documents, capabilities and the
 * onboarding link. Accounts are addressed by path, not by `X-Account-Id`:
 * "Reads your own account or one you own (direct child). Any other id → 404."
 *
 * Three routes are paybox's own and say so in coverage.ts: the hosted
 * onboarding page an account link opens (Bachs serves its own at
 * connect.bachs.io and never describes it), and two review controls. "Sandbox
 * grants do not exercise the complete live requirements and review flow", and
 * nothing in the sandbox verifies a person, accepts a document, or restricts
 * a capability.
 */
export function registerAccountRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { engine, storage, state, clock, ids } = ctx;
  const platformId = ctx.organizationId;

  /* --------------------------------- reading --------------------------------- */

  /** An account the actor may address by path: itself, or a child of the platform it is. */
  async function loadAccount(actor: Actor, id: string): Promise<StoredAccount> {
    const account = await state.accounts.get(id);
    const mine = actor.account ? account?.id === actor.account.id : account?.parent === platformId;
    if (!account || !mine) throw notFound('Account');
    return account;
  }

  async function detail(account: StoredAccount, include: string[] = []) {
    const persons = (await state.persons.of(account.id)).sort((a, b) => a.seq - b.seq);
    const documents = await state.accountDocuments.of(account.id);
    const requirements = requirementsOf(account, persons, documents);
    const withValues = include.includes('requirements.values');
    return serializeAccount(
      account,
      {
      requirements,
      ...(withValues
        ? {
            values: valueItems(account, persons),
            persons: persons.map((person) => ({
              id: person.id,
              first_name: person.firstName,
              last_name: person.lastName,
              dob: person.dob,
              address: person.address,
              address_reference_data: null,
              relationship: person.relationship,
              id_document_provided: documents.some((document) => document.person === person.id),
              verification_status: person.verification.status,
            })),
          }
        : {}),
      },
      await feeHandling(account.id),
    );
  }

  /** `fee_handling`: the owner's checkout settings (`fee_preference`). */
  async function feeHandling(account: string | null) {
    return feeHandlingOf(await settingsOf(state, account));
  }

  /** `TaskValueItem[]`: what has been submitted, sensitive values masked. */
  function valueItems(account: StoredAccount, persons: StoredPerson[]) {
    const items = Object.entries(account.values).map(([field, value]) => ({
      field,
      label: labelOf(field),
      group: groupOf(field),
      provided: true,
      sensitive: false,
      value: value.value,
      display: typeof value.value === 'string' ? value.value : null,
      reference_data: null,
    }));
    for (const person of persons) {
      if (person.idNumberProvided) {
        items.push({
          field: `persons.${person.id}.id_number`,
          label: 'ID number',
          group: 'identity_verification',
          provided: true,
          sensitive: true,
          value: null,
          display: 'Provided',
          reference_data: null,
        });
      }
    }
    return items;
  }

  /** The platform itself, as `OrganizationResponse` describes it. */
  async function platformView(single: boolean) {
    const created = (await storage.providerState.get(PROVIDER, 'platform-created')) ?? clock.nowISO();
    if (!(await storage.providerState.get(PROVIDER, 'platform-created'))) {
      await storage.providerState.put(PROVIDER, 'platform-created', created, created);
    }
    const capabilities = ['payouts', 'transfers', 'conversions', 'connect'];
    return {
      id: platformId,
      name: null,
      owner_user_id: derivedId('usr', `owner:${platformId}`, 12),
      parent_organization_id: null,
      country: 'NG',
      entity_type: 'company',
      fee_handling: await feeHandling(null),
      enabled_payment_methods: Object.fromEntries(Object.keys(CORRIDORS).map((corridor) => [corridor, { enabled: true }])),
      adaptive_pricing: true,
      balance_currencies: ['NGN', 'USD'],
      phone_number: null,
      company_name: null,
      enabled_capabilities: capabilities,
      capabilities: single
        ? Object.fromEntries(capabilities.map((name) => [name, { status: 'active', requested: true, status_details: null }]))
        : null,
      requirements: single
        ? { currently_due: [], eventually_due: [], past_due: [], pending_verification: [], errors: [], entries: [], current_deadline: null }
        : null,
      is_active: true,
      created_at: created,
      updated_at: created,
      responsibilities: null,
      configuration: single ? {} : null,
    };
  }

  function includeOf(query: unknown): string[] {
    const raw = (query as { include?: string | string[] }).include;
    const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((value) => value.split(','));
    for (const value of values) {
      if (value !== 'requirements.values') {
        throw fail('validation_failed', 'invalid_include', `Unknown include \`${value}\`. Valid: requirements.values.`);
      }
    }
    return values;
  }

  /* ---------------------------------- events --------------------------------- */

  /**
   * `capability.updated` for each capability whose status was written, then
   * `account.updated` if what is outstanding changed: "fires when requirement
   * state changes", never for a capability-only change.
   */
  async function publish(account: StoredAccount, before: string[] | null, capabilities: string[]): Promise<void> {
    for (const name of capabilities) {
      const capability = account.capabilities[name]!;
      await engine.recordEvent({
        provider: PROVIDER,
        type: 'capability.updated',
        resourceType: 'subaccount',
        resourceId: account.engineId,
        data: {
          account: account.id,
          capability: name,
          // The event "only ever carries active or restricted".
          status: capability.status === 'active' ? 'active' : 'restricted',
          requested: capability.requested,
        },
      });
    }
    if (before === null) return;
    const after = await outstandingOf(account);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    await engine.recordEvent({
      provider: PROVIDER,
      type: 'account.updated',
      resourceType: 'subaccount',
      resourceId: account.engineId,
      data: { account: account.id, outstanding: after },
    });
  }

  async function outstandingOf(account: StoredAccount): Promise<string[]> {
    return outstanding(
      requirementsOf(account, await state.persons.of(account.id), await state.accountDocuments.of(account.id)),
    );
  }

  async function save(account: StoredAccount): Promise<StoredAccount> {
    const next = { ...account, updatedAt: clock.nowISO() };
    await state.accounts.put(next);
    return next;
  }

  /* --------------------------------- accounts -------------------------------- */

  fastify.post('/v1/accounts', async (request, reply) => {
    const actor = await ctx.actor(request);
    // "An account cannot create other accounts of its own; that returns 403."
    if (actor.account) {
      throw fail('authentication_failed', 'FORBIDDEN', 'A connected account cannot create accounts of its own.');
    }
    const body = createAccountSchema.parse(request.body);
    if (body.configuration && Object.keys(body.configuration).length === 0) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'configuration: name at least one persona.', {
        httpStatus: 422,
      });
    }
    const id = alnumId(ids, 'acct', 16);
    const now = clock.nowISO();
    const account: StoredAccount = {
      seq: await state.nextSeq(),
      id,
      engineId: '',
      parent: platformId,
      ownerUserId: hexId(ids, 'usr', 12),
      contactEmail: body.contact_email,
      displayName: body.display_name ?? null,
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      country: (body.country ?? 'NG').toUpperCase(),
      entityType: body.entity_type ?? null,
      phoneNumber: null,
      companyName: null,
      personas: [],
      capabilities: {},
      collector: body.responsibilities?.fees.collector ?? 'bachs',
      balanceCurrencies: [],
      values: {},
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const granted = body.configuration ? applyConfiguration(account, body.configuration as CapabilityRequest, 'create') : [];
    // Its money lives in a core subaccount pot, created ready to transact:
    // "Granted capabilities are `active` immediately" in the sandbox.
    const subaccount = await engine.createSubaccount({
      provider: PROVIDER,
      providerSubaccountCode: id,
      businessName: body.display_name ?? body.contact_email,
      settlementBank: '',
      accountNumber: '',
      percentageCharge: 0,
      currency: 'USD',
      countryCode: account.country,
      primaryContactEmail: body.contact_email,
      onboarded: true,
    });
    const stored = { ...account, engineId: subaccount.id };
    await state.accounts.put(stored);
    await publish(stored, null, granted);
    return reply.status(201).send(await detail(stored));
  });

  fastify.get('/v1/accounts', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).optional(), offset: z.coerce.number().int().min(0).optional() })
      .parse(request.query);
    const { limit, offset } = readPage(query, 20);
    // An account has no accounts of its own.
    const children = actor.account
      ? []
      : (await state.accounts.all()).filter((account) => account.parent === platformId).sort((a, b) => b.seq - a.seq);
    const items = [];
    for (const account of children.slice(offset, offset + limit)) {
      items.push(serializeAccount(account, null, await feeHandling(account.id)));
    }
    return reply.send({
      items,
      total: children.length,
      limit,
      offset,
    });
  });

  fastify.get('/v1/accounts/me', async (request, reply) => {
    const actor = await ctx.actor(request);
    if (!actor.account) return reply.send(await platformView(false));
    return reply.send({
      ...serializeAccount(actor.account, null, await feeHandling(actor.account.id)),
      parent_organization_id: actor.account.parent,
    });
  });

  fastify.get<{ Params: { account_id: string } }>('/v1/accounts/:account_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const include = includeOf(request.query);
    if (!actor.account && request.params.account_id === platformId) return reply.send(await platformView(true));
    return reply.send(await detail(await loadAccount(actor, request.params.account_id), include));
  });

  /**
   * "The one write path." Contact details, capability requests and balance
   * currencies are applied first and never undone; then every key in
   * `fields` is validated together, and one bad value saves none of them.
   */
  fastify.post<{ Params: { account_id: string } }>('/v1/accounts/:account_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = updateAccountSchema.parse(request.body ?? {});
    if (!actor.account && request.params.account_id === platformId) return reply.send(await platformView(true));
    const found = await loadAccount(actor, request.params.account_id);
    return withLock(`account:${found.id}`, async () => {
      let account = (await state.accounts.get(found.id))!;
      const before = await outstandingOf(account);
      let written: string[] = [];
      if (body.configuration) {
        account = structuredClone(account);
        written = applyConfiguration(account, body.configuration as CapabilityRequest, 'update');
      }
      if (body.display_name !== undefined) account = { ...account, displayName: body.display_name };
      if (body.contact_email !== undefined) account = { ...account, contactEmail: body.contact_email.trim().toLowerCase() };
      if (body.balance_currencies) account = { ...account, balanceCurrencies: balanceCurrencies(account, body.balance_currencies) };
      account = await save(account);

      if (body.fields) {
        const plan = await planFields(account, body.fields);
        if (plan.errors.length > 0) {
          await publish(account, before, written);
          throw fail(
            'validation_failed',
            'INVALID_REQUIREMENT_FIELD',
            `${plan.errors[0]!.field}: ${plan.errors[0]!.message}`,
            { errors: plan.errors },
          );
        }
        account = await save(await plan.apply(account));
      }
      await publish(account, before, written);
      return reply.send(await detail(account));
    });
  });

  function balanceCurrencies(account: StoredAccount, changes: Record<string, boolean>): string[] {
    const held = new Set(account.balanceCurrencies);
    for (const [key, on] of Object.entries(changes)) {
      const currency = key.toUpperCase();
      if (!BALANCE_CURRENCIES.includes(currency)) {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          `balance_currencies: ${currency} cannot be held. Accepted: ${BALANCE_CURRENCIES.join(', ')}.`,
        );
      }
      // "USD always held, cannot be removed", and not listed.
      if (currency === 'USD') {
        if (!on) throw fail('validation_failed', 'VALIDATION_ERROR', 'balance_currencies: USD is always held.');
        continue;
      }
      if (on) held.add(currency);
      else held.delete(currency);
    }
    return [...held].sort();
  }

  /* --------------------------------- fields ---------------------------------- */

  /**
   * Validate every requirement value at once, and return how to apply them.
   * An incomplete value is not a rejection: it is saved, and stays due with
   * an error coded `required`.
   */
  async function planFields(
    account: StoredAccount,
    fields: Record<string, unknown>,
  ): Promise<{ errors: FieldError[]; apply: (account: StoredAccount) => Promise<StoredAccount> }> {
    const errors: FieldError[] = [];
    const values: Record<string, StoredRequirementValue> = {};
    const steps: Array<(account: StoredAccount) => Promise<StoredAccount>> = [];
    const accept = (value: unknown): StoredRequirementValue => ({ value, status: 'accepted', code: null, reason: null });
    const invalid = (field: string, message: string, code = 'invalid') => errors.push({ field, message, code });

    for (const [key, raw] of Object.entries(fields)) {
      if (key === 'business_profile' || key === 'company' || key === 'tos_acceptance') {
        if (!raw || typeof raw !== 'object') {
          invalid(key, 'must be an object');
          continue;
        }
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
          const field = `${key}.${name}`;
          if (typeof value !== 'string' || value.trim() === '') {
            invalid(field, 'must be a non-empty string');
            continue;
          }
          if (field === 'business_profile.support_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            invalid(field, 'must be an email address');
            continue;
          }
          if (
            field === 'business_profile.product_category' &&
            !PRODUCT_CATEGORIES.categories.some((category) => category.value === value)
          ) {
            invalid(field, 'must be a value from /v1/reference/product-categories');
            continue;
          }
          const structures = BUSINESS_STRUCTURES[account.country];
          if (field === 'company.structure' && structures && !structures.some((entry) => entry.value === value)) {
            invalid(field, 'must be a value from /v1/reference/business-structures');
            continue;
          }
          values[field] = accept(value);
        }
        continue;
      }
      if (key === 'payout_destination') {
        const outcome = payoutDestination(account, raw);
        if ('error' in outcome) {
          invalid('payout_destination', outcome.error.message, outcome.error.code);
          continue;
        }
        if ('incomplete' in outcome) {
          values.payout_destination = { value: raw, status: 'rejected', code: 'required', reason: outcome.incomplete };
          continue;
        }
        values.payout_destination = accept(raw);
        steps.push(async (current) => {
          await createDestination(current, outcome.destination);
          return current;
        });
        continue;
      }
      if (key === 'persons') {
        if (!Array.isArray(raw)) {
          invalid('persons', 'must be an array of persons');
          continue;
        }
        for (const [index, entry] of raw.entries()) {
          const parsed = personSchema.extend({ id: z.string().optional() }).safeParse(entry);
          if (!parsed.success) {
            invalid(`persons.${index}`, parsed.error.issues[0]?.message ?? 'invalid');
            continue;
          }
          if (parsed.data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.data.email)) {
            invalid(`persons.${index}.email`, 'must be an email address');
            continue;
          }
          if (parsed.data.id) {
            const person = await state.persons.get(parsed.data.id);
            if (!person || person.account !== account.id) {
              invalid(`persons.${index}.id`, 'no such person on this account');
              continue;
            }
          }
          steps.push(async (current) => {
            await writePerson(current, parsed.data.id ?? null, parsed.data);
            return current;
          });
        }
        continue;
      }
      invalid(key, 'is not a requirement field');
    }
    return {
      errors,
      apply: async (current) => {
        let next: StoredAccount = { ...current, values: { ...current.values, ...values } };
        for (const step of steps) next = await step(next);
        return next;
      },
    };
  }

  /** `fields.payout_destination`, the tagged union, with its documented rejection codes. */
  function payoutDestination(
    account: StoredAccount,
    raw: unknown,
  ):
    | { error: { code: string; message: string } }
    | { incomplete: string }
    | { destination: Pick<StoredDestination, 'type' | 'currency' | 'routing' | 'name'> } {
    if (!raw || typeof raw !== 'object') return { error: { code: 'invalid', message: 'must be an object' } };
    const input = raw as Record<string, unknown>;
    const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : null;
    if (!currency) return { error: { code: 'currency_required', message: 'currency is required' } };
    const rails: StoredDestination['type'][] = [];
    if (INLINE_BANK.includes(currency)) rails.push('bank_account');
    if (INLINE_MOMO.includes(currency)) rails.push('mobile_money');
    if (isStablecoin(currency)) rails.push('crypto_wallet');
    if (rails.length === 0) {
      return { error: { code: 'currency_not_supported', message: `there is no inline payout route for ${currency}` } };
    }
    const type = (input.type as StoredDestination['type'] | undefined) ?? (rails.length === 1 ? rails[0] : undefined);
    if (!type) return { error: { code: 'type_required', message: `${currency} has more than one rail; send type` } };
    if (!rails.includes(type)) {
      return { error: { code: 'currency_not_supported', message: `${currency} has no ${type} route` } };
    }
    const need = (keys: string[]) => keys.filter((key) => typeof input[key] !== 'string' || input[key] === '');
    if (type === 'bank_account') {
      const routing = {
        account_number: input.account_number ?? input.routing_number,
        account_name: input.account_name,
        bank_code: input.bank_code,
      };
      const missing = need(['account_number', 'account_name', 'bank_code'].filter((key) => key !== 'account_number' || !input.routing_number));
      if (missing.length > 0) return { incomplete: `${missing.join(', ')} required` };
      const country = CURRENCY_COUNTRY[currency]!;
      const bank = (BANKS[country] ?? []).find((entry) => entry.code === routing.bank_code);
      if (!bank) return { error: { code: 'bank_code_unknown', message: `bank_code ${String(routing.bank_code)} is not a ${country} bank` } };
      return {
        destination: {
          type,
          currency,
          name: String(routing.account_name),
          routing: { ...routing, bank_name: bank.name },
        },
      };
    }
    if (type === 'mobile_money') {
      const missing = need(['phone_number', 'mobile_provider']);
      if (missing.length > 0) return { incomplete: `${missing.join(', ')} required` };
      const country = CURRENCY_COUNTRY[currency]!;
      if (!(MOMO_COUNTRIES[country] ?? []).includes(String(input.mobile_provider))) {
        return { error: { code: 'mobile_provider_unknown', message: `${String(input.mobile_provider)} is not a ${country} network` } };
      }
      return {
        destination: { type, currency, name: null, routing: { phone_number: input.phone_number, mobile_provider: input.mobile_provider } },
      };
    }
    const asset = typeof input.asset === 'string' ? input.asset : currency;
    if (!isStablecoin(asset)) return { error: { code: 'asset_not_supported', message: `${asset} is not supported` } };
    const missing = need(['wallet_address']);
    if (missing.length > 0) return { incomplete: 'wallet_address required' };
    return {
      destination: {
        type,
        currency: asset,
        name: null,
        routing: { wallet_address: input.wallet_address, network: asset.split('_')[1] ?? null },
      },
    };
  }

  /** "Row ends up as an ordinary payout destination; first usable one per currency becomes default." */
  async function createDestination(
    account: StoredAccount,
    input: Pick<StoredDestination, 'type' | 'currency' | 'routing' | 'name'>,
  ): Promise<void> {
    const now = clock.nowISO();
    const destination: StoredDestination = {
      account: account.id,
      seq: await state.nextSeq(),
      id: hexId(ids, 'pd', 16),
      name: input.name,
      type: input.type,
      currency: input.currency,
      status: 'approved',
      statusReason: null,
      deleted: false,
      routing: input.routing,
      metadata: {},
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await state.destinations.put(destination);
    if (!(await state.destinations.defaultFor(input.currency, account.id))) {
      await state.destinations.setDefault(input.currency, destination.id, account.id);
    }
  }

  /* --------------------------------- persons --------------------------------- */

  async function writePerson(
    account: StoredAccount,
    personId: string | null,
    input: z.infer<typeof personSchema>,
  ): Promise<StoredPerson> {
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'email: must be an email address.', { httpStatus: 422 });
    }
    const now = clock.nowISO();
    const current = personId ? await state.persons.get(personId) : null;
    const base: StoredPerson = current ?? {
      seq: await state.nextSeq(),
      id: hexId(ids, 'per', 8),
      account: account.id,
      firstName: null,
      lastName: null,
      dob: null,
      address: null,
      phone: null,
      email: null,
      idNumberProvided: false,
      relationship: { representative: false, owner: false, director: false, executive: false, percent_ownership: null, title: null },
      verification: { status: 'unverified', failureReason: null },
      createdAt: now,
      updatedAt: now,
    };
    const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
    const person: StoredPerson = {
      ...base,
      firstName: pick(input.first_name, base.firstName),
      lastName: pick(input.last_name, base.lastName),
      dob: pick(input.dob, base.dob),
      address: pick(input.address, base.address),
      phone: pick(input.phone, base.phone),
      email: pick(input.email, base.email),
      idNumberProvided: base.idNumberProvided || input.id_number !== undefined,
      // "Naming one flag leaves the others."
      relationship: { ...base.relationship, ...stripUndefined(input.relationship ?? {}) },
      updatedAt: now,
    };
    await state.persons.put(person);
    return person;
  }

  async function loadPerson(account: StoredAccount, id: string): Promise<StoredPerson> {
    const person = await state.persons.get(id);
    if (!person || person.account !== account.id) throw notFound('Person');
    return person;
  }

  async function personView(person: StoredPerson) {
    return serializePerson(person, await state.accountDocuments.of(person.account));
  }

  fastify.get<{ Params: { account_id: string } }>('/v1/accounts/:account_id/persons', async (request, reply) => {
    const actor = await ctx.actor(request);
    const account = await loadAccount(actor, request.params.account_id);
    const query = z
      .object({ limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().min(0).optional() })
      .parse(request.query);
    if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'limit: between 1 and 100.', { httpStatus: 422 });
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    // "Oldest first, stable."
    const persons = (await state.persons.of(account.id)).sort((a, b) => a.seq - b.seq);
    const items = [];
    for (const person of persons.slice(offset, offset + limit)) items.push(await personView(person));
    return reply.send({ items, total: persons.length, limit, offset });
  });

  fastify.post<{ Params: { account_id: string } }>('/v1/accounts/:account_id/persons', async (request, reply) => {
    const actor = await ctx.actor(request);
    const account = await loadAccount(actor, request.params.account_id);
    const body = personSchema.parse(request.body ?? {});
    return withLock(`account:${account.id}`, async () => {
      const before = await outstandingOf(account);
      const person = await writePerson(account, null, body);
      await publish(account, before, []);
      return reply.status(201).send(await personView(person));
    });
  });

  fastify.get<{ Params: { account_id: string; person_id: string } }>(
    '/v1/accounts/:account_id/persons/:person_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const account = await loadAccount(actor, request.params.account_id);
      return reply.send(await personView(await loadPerson(account, request.params.person_id)));
    },
  );

  fastify.post<{ Params: { account_id: string; person_id: string } }>(
    '/v1/accounts/:account_id/persons/:person_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const account = await loadAccount(actor, request.params.account_id);
      const body = personSchema.parse(request.body ?? {});
      return withLock(`account:${account.id}`, async () => {
        await loadPerson(account, request.params.person_id);
        const before = await outstandingOf(account);
        const person = await writePerson(account, request.params.person_id, body);
        await publish(account, before, []);
        return reply.send(await personView(person));
      });
    },
  );

  fastify.delete<{ Params: { account_id: string; person_id: string } }>(
    '/v1/accounts/:account_id/persons/:person_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const account = await loadAccount(actor, request.params.account_id);
      return withLock(`account:${account.id}`, async () => {
        const person = await loadPerson(account, request.params.person_id);
        // "The representative cannot be removed — make another person representative first."
        if (person.relationship.representative) {
          throw fail(
            'validation_failed',
            'representative_cannot_be_removed',
            'The representative cannot be removed. Make another person the representative first.',
          );
        }
        const before = await outstandingOf(account);
        await state.persons.delete(person.id);
        await publish(account, before, []);
        return reply.status(204).send();
      });
    },
  );

  /* -------------------------------- documents -------------------------------- */

  /** An upload the platform or the account itself made, attached to this account. */
  async function attachUpload(account: StoredAccount, uploadId: string) {
    const upload = await state.uploads.get(uploadId);
    if (!upload || (upload.account !== undefined && upload.account !== account.id)) {
      throw fail('validation_failed', 'INVALID_UPLOAD_REFERENCE', `file: upload \`${uploadId}\` was not found.`);
    }
    if (upload.linkedResourceId !== null && upload.linkedResourceId !== account.id) {
      throw fail(
        'validation_failed',
        'INVALID_UPLOAD_REFERENCE',
        `file: upload \`${uploadId}\` is already attached to ${upload.linkedResourceType} ${upload.linkedResourceId}.`,
      );
    }
    await state.uploads.put({ ...upload, linkedResourceType: 'account', linkedResourceId: account.id, updatedAt: clock.nowISO() });
    return upload;
  }

  fastify.post<{ Params: { account_id: string; person_id: string } }>(
    '/v1/accounts/:account_id/persons/:person_id/documents',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const account = await loadAccount(actor, request.params.account_id);
      const body = documentSchema.parse(request.body);
      if (!['primary_verification', 'secondary_verification'].includes(body.document)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'document: primary_verification or secondary_verification.');
      }
      if (body.side !== undefined && !['front', 'back'].includes(body.side)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'side: front or back.');
      }
      return withLock(`account:${account.id}`, async () => {
        const person = await loadPerson(account, request.params.person_id);
        const upload = await attachUpload(account, body.file);
        const before = await outstandingOf(account);
        const document: StoredAccountDocument = {
          seq: await state.nextSeq(),
          id: hexId(ids, 'doc', 12),
          account: account.id,
          person: person.id,
          documentType: body.document,
          side: body.side ?? null,
          uploadId: upload.id,
          fileName: upload.fileName,
          uploadedAt: clock.nowISO(),
        };
        await state.accountDocuments.put(document);
        // "Attaching does not verify": a government ID puts the person in review.
        if (body.document === 'primary_verification' && person.verification.status !== 'verified') {
          await state.persons.put({
            ...person,
            verification: { status: 'pending', failureReason: null },
            updatedAt: clock.nowISO(),
          });
        }
        await publish(account, before, []);
        return reply.status(201).send({
          id: document.id,
          person: person.id,
          document_type: document.documentType,
          file_name: document.fileName,
          uploaded_at: document.uploadedAt,
        });
      });
    },
  );

  fastify.post<{ Params: { account_id: string } }>('/v1/accounts/:account_id/documents', async (request, reply) => {
    const actor = await ctx.actor(request);
    const account = await loadAccount(actor, request.params.account_id);
    const body = documentSchema.parse(request.body);
    return withLock(`account:${account.id}`, async () => {
      const upload = await attachUpload(account, body.file);
      const before = await outstandingOf(account);
      const document: StoredAccountDocument = {
        seq: await state.nextSeq(),
        id: hexId(ids, 'doc', 12),
        account: account.id,
        person: null,
        documentType: body.document,
        side: null,
        uploadId: upload.id,
        fileName: upload.fileName,
        uploadedAt: clock.nowISO(),
      };
      await state.accountDocuments.put(document);
      let current = (await state.accounts.get(account.id))!;
      if (body.document === 'certificate_of_incorporation') {
        current = await save({
          ...current,
          values: {
            ...current.values,
            'company.documents.registration': { value: document.id, status: 'pending_verification', code: null, reason: null },
          },
        });
      }
      await publish(current, before, []);
      return reply.status(201).send({
        id: document.id,
        document_type: document.documentType,
        file_name: document.fileName,
        uploaded_at: document.uploadedAt,
      });
    });
  });

  /* ------------------------------- capabilities ------------------------------ */

  fastify.get<{ Params: { account_id: string } }>('/v1/accounts/:account_id/capabilities', async (request, reply) => {
    const actor = await ctx.actor(request);
    if (!actor.account && request.params.account_id === platformId) {
      const view = await platformView(true);
      return reply.send({
        items: Object.entries(view.capabilities!).map(([name, entry]) => ({ name, ...entry })),
      });
    }
    const account = await loadAccount(actor, request.params.account_id);
    const items = Object.entries(capabilityView(account)).map(([name, entry]) => ({ name, ...entry }));
    // The spec's example lists `connect` too, which only a platform can hold.
    items.push({ name: 'connect', status: 'unrequested', requested: false, status_details: null });
    return reply.send({ items });
  });

  /* ------------------------------- account links ----------------------------- */

  fastify.post<{ Params: { account_id: string } }>('/v1/accounts/:account_id/account-links', async (request, reply) => {
    const actor = await ctx.actor(request);
    const account = await loadAccount(actor, request.params.account_id);
    const body = linkSchema.parse(request.body);
    if (!account.isActive) {
      throw fail('validation_failed', 'CONNECTED_ACCOUNT_NOT_ELIGIBLE_FOR_LINK', 'This account cannot be onboarded.');
    }
    const persons = await state.persons.of(account.id);
    const requirements = requirementsOf(account, persons, await state.accountDocuments.of(account.id));
    // An `update` link edits what was given; with nothing ever asked for there is nothing to edit.
    if (body.type === 'update' && requirements.length === 0 && Object.keys(account.values).length === 0 && persons.length === 0) {
      throw fail(
        'validation_failed',
        'CONNECTED_ACCOUNT_REQUIREMENTS_NOT_FOUND',
        'This account has no requirements to update.',
      );
    }
    return withLock(`account-links:${account.id}`, async () => {
      const now = clock.nowISO();
      // "A new link invalidates any outstanding active link of the same type."
      let superseded = false;
      for (const link of await state.accountLinks.of(account.id)) {
        if (link.type !== body.type || !usable(link)) continue;
        await state.accountLinks.put({ ...link, supersededAt: now });
        superseded = true;
      }
      const link: StoredAccountLink = {
        id: hexId(ids, 'alnk', 20),
        token: alnumId(ids, 'al', 32),
        account: account.id,
        type: body.type,
        refreshUrl: body.refresh_url,
        returnUrl: body.return_url,
        collectionOptions: body.collection_options ?? null,
        created: now,
        expiresAt: new Date(clock.now() + LINK_TTL_MS).toISOString(),
        usedAt: null,
        supersededAt: null,
      };
      await state.accountLinks.put(link);
      return reply.status(200).send({
        id: link.id,
        object: 'connected_account_link',
        account: account.id,
        type: link.type,
        created: link.created,
        expires_at: link.expiresAt,
        url: `${ctx.baseUrl}${ctx.basePath}/connect/setup/c/${account.id}/${link.token}`,
        previous_link_superseded: superseded,
      });
    });
  });

  function usable(link: StoredAccountLink): boolean {
    return link.usedAt === null && link.supersededAt === null && clock.now() < Date.parse(link.expiresAt);
  }

  /* ----------------------------- hosted onboarding ---------------------------- */

  async function openLink(accountId: string, token: string, reply: FastifyReply) {
    const link = await state.accountLinks.byToken(token);
    if (!link || link.account !== accountId) {
      reply.status(404).type('text/html').send(page('This link is not valid.', ''));
      return null;
    }
    // "Where an expired or used link lands; your handler mints a new link."
    if (!usable(link)) {
      reply.redirect(link.refreshUrl, 302);
      return null;
    }
    return link;
  }

  fastify.get<{ Params: { account_id: string; token: string } }>(
    '/connect/setup/c/:account_id/:token',
    async (request, reply) => {
      const link = await openLink(request.params.account_id, request.params.token, reply);
      if (!link) return reply;
      const account = (await state.accounts.get(link.account))!;
      const persons = await state.persons.of(account.id);
      const due = requirementsOf(account, persons, await state.accountDocuments.of(account.id)).filter(
        (entry) => entry.status !== 'pending_verification',
      );
      return reply.type('text/html').send(page(`Set up ${escapeHtml(account.displayName ?? account.contactEmail)}`, form(due)));
    },
  );

  /** The page submits what it asks for through the same path as `fields`, then sends the user back. */
  fastify.post<{ Params: { account_id: string; token: string }; Body: Record<string, string> }>(
    '/connect/setup/c/:account_id/:token',
    async (request, reply) => {
      const link = await openLink(request.params.account_id, request.params.token, reply);
      if (!link) return reply;
      const submitted = request.body ?? {};
      const fields: Record<string, unknown> = {};
      const group = (prefix: string) =>
        Object.fromEntries(
          Object.entries(submitted)
            .filter(([key, value]) => key.startsWith(`${prefix}.`) && value !== '')
            .map(([key, value]) => [key.slice(prefix.length + 1), value]),
        );
      for (const prefix of ['business_profile', 'company']) {
        const values = group(prefix);
        if (Object.keys(values).length > 0) fields[prefix] = values;
      }
      const destination = group('payout_destination');
      if (Object.keys(destination).length > 0) fields.payout_destination = destination;
      // One entry per person, by the requirement keys the inputs are named after.
      const persons = new Map<string, Record<string, string>>();
      for (const [key, value] of Object.entries(submitted)) {
        const match = /^persons\.(per_[0-9a-f]+|new)\.(first_name|last_name|dob|id_number)$/.exec(key);
        if (!match || value === '') continue;
        persons.set(match[1]!, { ...(persons.get(match[1]!) ?? {}), [match[2]!]: value });
      }
      if (persons.size > 0) {
        fields.persons = [...persons].map(([id, values]) =>
          id === 'new' ? { ...values, relationship: { representative: true } } : { id, ...values },
        );
      }
      return withLock(`account:${link.account}`, async () => {
        let account = (await state.accounts.get(link.account))!;
        const before = await outstandingOf(account);
        const plan = await planFields(account, fields);
        if (plan.errors.length > 0) {
          return reply
            .status(400)
            .type('text/html')
            .send(page('Check your details', `<p class="error">${escapeHtml(plan.errors.map((error) => `${error.field}: ${error.message}`).join('; '))}</p>`));
        }
        account = await save(await plan.apply(account));
        await state.accountLinks.put({ ...link, usedAt: clock.nowISO() });
        await publish(account, before, []);
        // "Lands on finish OR abandon — not proof of completion."
        return reply.redirect(link.returnUrl, 303);
      });
    },
  );

  function form(due: Requirement[]): string {
    const inputs = due
      .map((entry) => inputFor(entry.field))
      .filter((html): html is string => html !== null)
      .join('');
    const note = due.some((entry) => entry.resolution === 'review')
      ? '<p>Identity and company documents are attached through the API (paybox has no document upload on this page).</p>'
      : '';
    return `<form method="post">${inputs}${note}<button type="submit">Submit</button></form>`;
  }

  function inputFor(field: string): string | null {
    const text = (name: string, label: string) =>
      `<label>${escapeHtml(label)} <input name="${escapeHtml(name)}" /></label>`;
    // The first person, who represents the account.
    if (field === 'persons') {
      return text('persons.new.first_name', 'First name') + text('persons.new.last_name', 'Last name');
    }
    const person = /^persons\.(per_[0-9a-f]+)\.(first_name|last_name|dob|id_number)$/.exec(field);
    if (person) return text(field, `${labelOf(field)} (${person[1]})`);
    if (field.startsWith('business_profile.') || field.startsWith('company.') && !field.startsWith('company.documents')) {
      return text(field, labelOf(field));
    }
    if (field === 'payout_destination') {
      return (
        text('payout_destination.currency', 'Payout currency') +
        text('payout_destination.bank_code', 'Bank code') +
        text('payout_destination.account_number', 'Account number') +
        text('payout_destination.account_name', 'Account name')
      );
    }
    return null;
  }

  /* --------------------------- paybox review controls -------------------------- */

  /**
   * Emulator-only: a reviewer's decision on one requirement. A person's
   * `id_document` is decided by verifying (or failing) that person; anything
   * else submitted is accepted or rejected with a code and reason.
   */
  fastify.post<{ Params: { account_id: string } }>(
    '/v1/accounts/:account_id/requirements/review',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      assertPlatform(actor);
      const found = await loadAccount(actor, request.params.account_id);
      const body = reviewSchema.parse(request.body);
      return withLock(`account:${found.id}`, async () => {
        let account = (await state.accounts.get(found.id))!;
        const before = await outstandingOf(account);
        const document = /^persons\.(per_[0-9a-f]+)\.id_document$/.exec(body.field);
        if (document) {
          const person = await loadPerson(account, document[1]!);
          await state.persons.put({
            ...person,
            verification:
              body.outcome === 'accept'
                ? { status: 'verified', failureReason: null }
                : { status: 'failed', failureReason: body.reason ?? 'The document could not be verified.' },
            updatedAt: clock.nowISO(),
          });
        } else {
          const value = account.values[body.field];
          if (!value) {
            throw fail('validation_failed', 'VALIDATION_ERROR', `field: nothing has been submitted for ${body.field}.`);
          }
          account = await save({
            ...account,
            values: {
              ...account.values,
              [body.field]:
                body.outcome === 'accept'
                  ? { ...value, status: 'accepted', code: null, reason: null }
                  : { ...value, status: 'rejected', code: body.code ?? 'invalid', reason: body.reason ?? null },
            },
          });
        }
        await publish(account, before, []);
        return reply.send(await detail(account));
      });
    },
  );

  /** Emulator-only: an administrator enabling or restricting one capability. */
  fastify.post<{ Params: { account_id: string; capability: string } }>(
    '/v1/accounts/:account_id/capabilities/:capability',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      assertPlatform(actor);
      const found = await loadAccount(actor, request.params.account_id);
      const body = capabilityControlSchema.parse(request.body);
      const name = request.params.capability;
      if (!Object.values(PERSONA_CAPABILITIES).some((names) => names.includes(name))) {
        throw fail('validation_failed', 'unknown_capability', `Unknown capability \`${name}\`.`);
      }
      return withLock(`account:${found.id}`, async () => {
        const account = (await state.accounts.get(found.id))!;
        const next = await save({
          ...account,
          capabilities: {
            ...account.capabilities,
            [name]: {
              status: body.status,
              requested: account.capabilities[name]?.requested ?? true,
              disabled: body.status === 'restricted',
            },
          },
        });
        await publish(next, null, [name]);
        return reply.send(await detail(next));
      });
    },
  );

  /** A reviewer's or administrator's decision is the platform's (here, Bachs'), never the account's own. */
  function assertPlatform(actor: Actor): void {
    if (actor.account) throw fail('authentication_failed', 'FORBIDDEN', 'An account cannot review itself.');
  }

  /* -------------------------------- reference --------------------------------- */

  fastify.get('/v1/reference/business-structures', async (request, reply) => {
    await ctx.actor(request);
    const query = z.object({ country: z.string().regex(/^[A-Za-z]{2}$/).optional() }).parse(request.query);
    const country = (query.country ?? 'NG').toUpperCase();
    return reply.send({ country, structures: BUSINESS_STRUCTURES[country] ?? [] });
  });

  fastify.get('/v1/reference/product-categories', async (request, reply) => {
    await ctx.actor(request);
    return reply.send(PRODUCT_CATEGORIES);
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function labelOf(field: string): string {
  const last = field.split('.').at(-1) ?? field;
  return last.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function groupOf(field: string): string | null {
  if (field.startsWith('persons')) return 'identity_verification';
  if (field.startsWith('company')) return 'business_ownership';
  if (field.startsWith('business_profile')) return 'product_information';
  if (field === 'payout_destination') return 'bank_verification';
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input{display:block;width:100%;padding:.4rem;margin-top:.25rem}button{margin-top:1rem;padding:.5rem 1rem}.error{color:#b00020}.paybox{font-size:.8rem;color:#666}</style></head><body><h1>${title}</h1>${body}<p class="paybox">paybox's onboarding page. Bachs hosts its own at connect.bachs.io.</p></body></html>`;
}
