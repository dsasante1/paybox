import { fail } from './errors.js';
import type {
  Persona,
  StoredAccount,
  StoredAccountDocument,
  StoredCapability,
  StoredPerson,
  StoredRequirementValue,
} from './state.js';

/**
 * Bachs Connect: connected accounts, their capabilities and requirements.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (createConnectedAccount,
 * getAccount, updateAccount, listConnectedAccounts, getMyOrganization,
 * listCapabilities, createAccountLink, the persons and document operations)
 * and connect/{accounts, capabilities, requirements, onboarding, testing,
 * acting-as-an-account, guides/*}. docs/bachs.md records where they disagree.
 */

/** connect/capabilities: which persona permits which capability. */
export const PERSONA_CAPABILITIES: Record<Persona, readonly string[]> = {
  recipient: ['payouts', 'transfers', 'conversions'],
  merchant: ['card_collection', 'ngn_card_collection', 'bank_transfer', 'mobile_money', 'crypto', 'virtual_accounts'],
};
const MERCHANT_CAPABILITIES = PERSONA_CAPABILITIES.merchant;

export const PERSONAS: readonly Persona[] = ['merchant', 'recipient'];

/** reference/business-structures: only Nigeria's are published. */
export const BUSINESS_STRUCTURES: Record<string, Array<{ value: string; label: string; description: string }>> = {
  NG: [
    {
      value: 'business_name',
      label: 'Business Name (BN)',
      description: 'A sole trader or partnership registered with the CAC. No shareholders.',
    },
    {
      value: 'private_incorporated',
      label: 'Private Company (RC / LTD)',
      description: 'A company limited by shares, with directors and shareholders.',
    },
    {
      value: 'incorporated_trustees',
      label: 'Incorporated Trustees (IT)',
      description: 'An NGO, church, association or foundation registered as trustees.',
    },
  ],
};

/** reference/product-categories: the published example, and nothing invented beside it. */
export const PRODUCT_CATEGORIES = {
  categories: [
    { value: 'software_as_a_service_saas', label: 'Software as a service (SaaS)' },
    { value: 'mobile_or_web_app', label: 'Mobile or web app' },
  ],
  sections: [{ label: 'Software & technology', categories: ['software_as_a_service_saas', 'mobile_or_web_app'] }],
};

/* ---------------------------- the requirements ----------------------------- */

/**
 * paybox's requirement catalogue. Bachs publishes none ("Bachs publishes no
 * catalogue of requirement keys"); these are the keys its pages use, owed by
 * the personas and entity types its pages give them, and docs/bachs.md lists
 * them:
 *
 *   every persona  persons, persons.<id>.first_name, persons.<id>.last_name
 *   recipient      payout_destination
 *   merchant       persons.<id>.dob, .id_number, .id_document,
 *                  business_profile.product_description, .support_email,
 *                  .product_category
 *   company        company.registered_name, .registration_number, .structure,
 *                  company.documents.registration
 */
export interface Requirement {
  field: string;
  status: 'currently_due' | 'eventually_due' | 'past_due' | 'pending_verification';
  restricts: string[];
  resolution: 'api' | 'review';
  error: { code: string; reason: string | null } | null;
  provided: boolean;
}

const BUSINESS_FIELDS = ['product_description', 'support_email', 'product_category'] as const;
const COMPANY_FIELDS = ['registered_name', 'registration_number', 'structure'] as const;

/** Every capability the account has asked for, which a missing requirement holds back. */
function requested(account: StoredAccount, names: readonly string[]): string[] {
  return names.filter((name) => account.capabilities[name]?.requested);
}

export function requirementsOf(
  account: StoredAccount,
  persons: StoredPerson[],
  documents: StoredAccountDocument[],
): Requirement[] {
  if (account.personas.length === 0) return [];
  const out: Requirement[] = [];
  const merchant = account.personas.includes('merchant');
  const recipient = account.personas.includes('recipient');
  const all = Object.keys(account.capabilities).filter((name) => account.capabilities[name]?.requested);
  const merchantCaps = requested(account, MERCHANT_CAPABILITIES);

  const fromValue = (field: string, restricts: string[], resolution: 'api' | 'review' = 'api') => {
    const value = account.values[field];
    if (value?.status === 'accepted') return;
    out.push(entry(field, value, restricts, resolution));
  };

  const representative = persons.find((person) => person.relationship.representative) ?? persons[0];
  if (!representative) {
    out.push({ field: 'persons', status: 'currently_due', restricts: all, resolution: 'api', error: null, provided: false });
  }
  for (const person of persons) {
    const key = (name: string) => `persons.${person.id}.${name}`;
    if (!person.firstName) out.push(due(key('first_name'), requested(account, ['transfers', ...MERCHANT_CAPABILITIES])));
    if (!person.lastName) out.push(due(key('last_name'), requested(account, ['transfers', ...MERCHANT_CAPABILITIES])));
    if (!merchant) continue;
    const identity = [...merchantCaps, ...requested(account, ['payouts'])];
    if (!person.dob) out.push(due(key('dob'), identity));
    if (!person.idNumberProvided) out.push(due(key('id_number'), identity));
    const verification = person.verification.status;
    if (verification === 'verified') continue;
    if (verification === 'pending') {
      out.push({ ...due(key('id_document'), identity, 'review'), status: 'pending_verification', provided: true });
    } else if (verification === 'failed') {
      out.push({
        ...due(key('id_document'), identity, 'review'),
        provided: true,
        error: { code: 'verification_failed', reason: person.verification.failureReason },
      });
    } else {
      out.push(due(key('id_document'), identity, 'review'));
    }
  }
  if (recipient) fromValue('payout_destination', requested(account, ['payouts']));
  if (merchant) for (const field of BUSINESS_FIELDS) fromValue(`business_profile.${field}`, merchantCaps);
  if (account.entityType === 'company') {
    for (const field of COMPANY_FIELDS) fromValue(`company.${field}`, all);
    const registration = documents.find((document) => document.documentType === 'certificate_of_incorporation');
    const value = account.values['company.documents.registration'];
    if (value?.status !== 'accepted') {
      out.push(
        entry('company.documents.registration', registration ? (value ?? pendingValue()) : value, all, 'review'),
      );
    }
  }
  return out;
}

function due(field: string, restricts: string[], resolution: 'api' | 'review' = 'api'): Requirement {
  return { field, status: 'currently_due', restricts, resolution, error: null, provided: false };
}

function pendingValue(): StoredRequirementValue {
  return { value: null, status: 'pending_verification', code: null, reason: null };
}

function entry(
  field: string,
  value: StoredRequirementValue | undefined,
  restricts: string[],
  resolution: 'api' | 'review',
): Requirement {
  if (!value) return due(field, restricts, resolution);
  if (value.status === 'pending_verification') {
    return { field, status: 'pending_verification', restricts, resolution, error: null, provided: true };
  }
  // "A currently_due entry with provided: true = rejected."
  return {
    field,
    status: 'currently_due',
    restricts,
    resolution,
    error: value.status === 'rejected' ? { code: value.code ?? 'invalid', reason: value.reason } : null,
    provided: value.status === 'rejected',
  };
}

/** What `account.updated` lists as `outstanding`: every field still asked for. */
export function outstanding(requirements: Requirement[]): string[] {
  return requirements.filter((entry) => entry.status !== 'pending_verification').map((entry) => entry.field);
}

/** `AccountRequirements`. */
export function serializeRequirements(requirements: Requirement[]) {
  const bucket = (status: Requirement['status']) =>
    requirements.filter((entry) => entry.status === status).map((entry) => entry.field);
  return {
    currently_due: bucket('currently_due'),
    eventually_due: bucket('eventually_due'),
    past_due: bucket('past_due'),
    pending_verification: bucket('pending_verification'),
    errors: requirements
      .filter((entry) => entry.error)
      .map((entry) => ({ field: entry.field, code: entry.error!.code, reason: entry.error!.reason })),
    entries: requirements.map((entry) => ({
      field: entry.field,
      status: entry.status,
      restricts_capabilities: entry.restricts,
      errors: entry.error ? [{ code: entry.error.code, reason: entry.error.reason }] : [],
      resolution: entry.resolution,
      deadline: null,
    })),
    current_deadline: null,
  };
}

/* ---------------------------- the capabilities ----------------------------- */

export interface CapabilityRequest {
  [persona: string]: { capabilities?: Record<string, { requested: boolean }> } | undefined;
}

/**
 * Apply `configuration`. Personas only accumulate; capabilities are requested
 * and, in the sandbox, granted at once ("Granted capabilities are `active`
 * immediately"). Returns the capabilities whose stored status was written,
 * each of which is a `capability.updated`.
 */
export function applyConfiguration(
  account: StoredAccount,
  configuration: CapabilityRequest,
  mode: 'create' | 'update',
): string[] {
  const written: string[] = [];
  for (const [persona, body] of Object.entries(configuration)) {
    if (!(PERSONAS as readonly string[]).includes(persona)) {
      throw fail('validation_failed', 'invalid_configuration', `Unknown persona \`${persona}\`. Valid keys are \`merchant\` and \`recipient\`.`);
    }
    const allowed = PERSONA_CAPABILITIES[persona as Persona];
    const named = body?.capabilities;
    for (const [name, request] of Object.entries(named ?? {})) {
      if (!allowed.includes(name)) {
        const other = PERSONAS.find((candidate) => PERSONA_CAPABILITIES[candidate].includes(name));
        if (other) {
          throw fail(
            'validation_failed',
            'capability_configuration_mismatch',
            `\`${name}\` belongs to the \`${other}\` persona, not \`${persona}\`.`,
          );
        }
        throw fail('validation_failed', 'unknown_capability', `Unknown capability \`${name}\`.`);
      }
      if (mode === 'update' && request.requested === false) {
        throw fail(
          'validation_failed',
          'capability_unrequest_unsupported',
          'A capability cannot be withdrawn once requested.',
        );
      }
    }
  }
  for (const [persona, body] of Object.entries(configuration)) {
    const typed = persona as Persona;
    if (!account.personas.includes(typed)) account.personas.push(typed);
    const named = body?.capabilities;
    // "A persona with `capabilities` omitted requests every capability that
    // persona allows" -- on create only.
    const wanted =
      named === undefined
        ? mode === 'create'
          ? [...PERSONA_CAPABILITIES[typed]]
          : []
        : Object.entries(named)
            .filter(([, request]) => request.requested)
            .map(([name]) => name);
    // "`conversions` is granted automatically for recipient-capable accounts."
    if (typed === 'recipient' && !wanted.includes('conversions')) wanted.push('conversions');
    for (const name of wanted) {
      const current = account.capabilities[name];
      if (current?.status === 'active' || current?.disabled) continue;
      account.capabilities[name] = { status: 'active', requested: true, disabled: false } satisfies StoredCapability;
      written.push(name);
    }
  }
  return written;
}

/** Every capability applicable to the account, as listCapabilities shows it. */
export function capabilityView(account: StoredAccount) {
  const names = [
    ...new Set([...account.personas.flatMap((persona) => PERSONA_CAPABILITIES[persona]), ...Object.keys(account.capabilities)]),
  ];
  const view: Record<string, { status: string; requested: boolean; status_details: unknown[] | null }> = {};
  for (const name of names) {
    const stored = account.capabilities[name];
    if (!stored) {
      view[name] = {
        status: 'unrequested',
        requested: false,
        status_details: [{ code: 'requirements_outstanding', resolution: 'provide_info', message: 'Not requested.' }],
      };
      continue;
    }
    view[name] = {
      status: stored.status,
      requested: stored.requested,
      status_details:
        stored.status === 'active'
          ? null
          : stored.disabled
            ? [
                {
                  code: 'platform_disabled',
                  resolution: 'Contact support to re-enable this capability.',
                  message: 'This capability was disabled by the platform.',
                },
              ]
            : [
                {
                  code: 'requirements_outstanding',
                  resolution: 'provide_info',
                  message: "Outstanding requirements. See the account's requirements.",
                },
              ],
    };
  }
  return view;
}

export function activeCapabilities(account: StoredAccount): string[] {
  return Object.entries(account.capabilities)
    .filter(([, capability]) => capability.status === 'active')
    .map(([name]) => name);
}

/* -------------------------------- serialisers ------------------------------ */

/** `OrganizationResponse` for a connected account. `detail` adds the single-read blocks. */
export function serializeAccount(
  account: StoredAccount,
  detail: { requirements: Requirement[]; values?: unknown[]; persons?: unknown[] } | null,
) {
  const requirements = detail ? { ...serializeRequirements(detail.requirements) } : null;
  if (requirements && detail?.values) Object.assign(requirements, { values: detail.values });
  if (requirements && detail?.persons) Object.assign(requirements, { persons: detail.persons });
  return {
    id: account.id,
    name: account.displayName,
    owner_user_id: account.ownerUserId,
    parent_organization_id: account.parent,
    country: account.country,
    entity_type: account.entityType,
    fee_handling: 'account_pays_fee',
    enabled_payment_methods: null,
    adaptive_pricing: true,
    balance_currencies: account.balanceCurrencies,
    phone_number: account.phoneNumber,
    company_name: account.companyName,
    enabled_capabilities: activeCapabilities(account),
    capabilities: detail ? capabilityView(account) : null,
    requirements,
    is_active: account.isActive,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
    responsibilities: detail ? { fees: { collector: account.collector } } : null,
    configuration: detail ? Object.fromEntries(account.personas.map((persona) => [persona, {}])) : null,
  };
}

/** `PersonResponse`. */
export function serializePerson(person: StoredPerson, documents: StoredAccountDocument[]) {
  return {
    id: person.id,
    first_name: person.firstName,
    last_name: person.lastName,
    dob: person.dob,
    address: person.address,
    phone: person.phone,
    email: person.email,
    id_number_provided: person.idNumberProvided,
    relationship: person.relationship,
    verification: {
      status: person.verification.status,
      document_provided: documents.some((document) => document.person === person.id),
      failure_reason: person.verification.failureReason,
    },
    created_at: person.createdAt,
    updated_at: person.updatedAt,
  };
}

/** The merchant capability a collection corridor needs (connect/capabilities). */
export function corridorCapability(corridor: string): string {
  if (corridor === 'USD_CARD') return 'card_collection';
  if (corridor === 'NGN_CARD') return 'ngn_card_collection';
  if (corridor === 'NGN_BANK_TRANSFER') return 'bank_transfer';
  if (corridor === 'CRYPTO') return 'crypto';
  return 'mobile_money';
}

/** "Gate on `active` only." The platform holds every capability. */
export function hasCapability(account: StoredAccount | null, name: string): boolean {
  return account === null || account.capabilities[name]?.status === 'active';
}
