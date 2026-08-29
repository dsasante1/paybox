import type { SimulatedOutcome } from '@paybox/simulator';

/**
 * Flutterwave v4's `X-Scenario-Key` header.
 *
 * v4 replaces v3's test-card table with a header that names the flow and the
 * issuer's answer directly:
 *
 *   X-Scenario-Key: scenario:auth_pin&issuer:insufficient_funds
 *
 * Verified at developer.flutterwave.com/docs/testing (read 2026-08-29).
 *
 * This is a much better fit for an emulator than a card table, and it is worth
 * being clear why paybox implements it rather than mapping it onto the shared
 * last-four convention: the header is what a v4 integration's own tests will
 * send, so honouring it is the difference between their suite running here
 * unchanged and not running at all.
 *
 * Omitting the header defaults to `noauth`, and Flutterwave documents that an
 * **invalid** key defaults to `pending` -- an incomplete payment -- rather
 * than erroring. Both are reproduced.
 */

/** The authentication flow to mock. `noauth` is the documented default. */
export type CardScenario = 'noauth' | 'auth_pin' | 'auth_pin_3ds' | 'auth_3ds' | 'auth_avs' | 'auth_redirect';

const CARD_SCENARIOS: ReadonlySet<string> = new Set([
  'noauth',
  'auth_pin',
  'auth_pin_3ds',
  'auth_3ds',
  'auth_avs',
  'auth_redirect',
]);

/**
 * Issuer responses, transcribed verbatim from the same page.
 *
 * Only `approved` succeeds. Everything else is a decline of some kind, and the
 * value is echoed back as the charge's `processor_response` so an integration
 * surfacing it to support staff sees the real string.
 */
export const ISSUER_RESPONSES: readonly string[] = [
  'already_reversed',
  'approved',
  'blocked_first_use',
  'cannot_complete_violation_of_law',
  'cannot_verify_pin',
  'do_not_honor',
  'error',
  'exceeds_approval_amount_limit',
  'exceeds_withdrawal_limit',
  'expired_card',
  'file_temporarily_not_available',
  'incorrect_pin',
  'insufficient_funds',
  'invalid_account_number',
  'invalid_amount',
  'invalid_cvv',
  'invalid_merchant',
  'invalid_restricted_service_code',
  'invalid_transaction',
  'issuer_unavailable',
  'lost_card_pick_up',
  'negative_cvv_result',
  'no_action_taken',
  'no_checking_account',
  'no_reason_to_decline',
  'no_savings_account',
  'no_such_issuer',
  'partial_approval',
  'pick_up_card_fraud',
  'pick_up_card_no_fraud',
  'pin_data_required',
  'pin_entry_tries_exceeded',
  'reenter_transaction',
  'refer_to_issuer',
  'refer_to_issuer_special_condition',
  'security_violation',
  'stolen_card_pick_up',
  'suspected_fraud',
  'system_error',
  'transaction_does_not_fulfill_aml_req',
  'transaction_not_permitted_card',
  'transaction_not_permitted_terminal',
  'unable_to_locate_record_in_file',
  'unable_to_route_transaction',
  'unsolicited_reversal',
];

const ISSUERS = new Set(ISSUER_RESPONSES);

/** Transfer scenarios, from the same page. */
export const TRANSFER_SCENARIOS: readonly string[] = [
  'successful',
  'reversed',
  'failed',
  'account_verification_failed',
  'transfer_amount_below_limit',
];

export interface ScenarioKey {
  scenario: CardScenario;
  issuer: string;
  /** Set when the header named something Flutterwave does not document. */
  invalid: boolean;
  /** The raw transfer scenario, where one was given. */
  transfer: string | null;
}

/**
 * Parse `scenario:<value>&issuer:<value>`.
 *
 * Deliberately tolerant of order and whitespace, and deliberately *not*
 * tolerant of unknown values: Flutterwave defaults an invalid key to a pending
 * charge, and silently treating a typo as `approved` would turn a developer's
 * failure test into a false pass.
 */
export function parseScenarioKey(header: string | undefined): ScenarioKey {
  const fallback: ScenarioKey = {
    scenario: 'noauth',
    issuer: 'approved',
    invalid: false,
    transfer: null,
  };
  if (!header || header.trim().length === 0) return fallback;

  const parts = new Map<string, string>();
  for (const chunk of header.split('&')) {
    const [rawKey, rawValue] = chunk.split(':');
    if (rawKey && rawValue) parts.set(rawKey.trim().toLowerCase(), rawValue.trim().toLowerCase());
  }

  const scenario = parts.get('scenario');
  const issuer = parts.get('issuer');

  // A transfer scenario shares the header but names an outcome, not a flow.
  if (scenario && TRANSFER_SCENARIOS.includes(scenario)) {
    return { scenario: 'noauth', issuer: 'approved', invalid: false, transfer: scenario };
  }

  const scenarioValid = scenario === undefined || CARD_SCENARIOS.has(scenario);
  const issuerValid = issuer === undefined || ISSUERS.has(issuer);

  return {
    scenario: scenarioValid ? ((scenario ?? 'noauth') as CardScenario) : 'noauth',
    issuer: issuerValid ? (issuer ?? 'approved') : 'approved',
    invalid: !scenarioValid || !issuerValid,
    transfer: null,
  };
}

/**
 * The canonical outcome an issuer response implies.
 *
 * Only `approved` moves money. The rest map onto the canonical failure
 * vocabulary as closely as each one honestly allows; anything without a closer
 * match becomes a plain decline rather than being invented into a category it
 * does not belong to.
 */
export function outcomeForIssuer(issuer: string): SimulatedOutcome {
  switch (issuer) {
    case 'approved':
    case 'partial_approval':
      return 'success';
    case 'insufficient_funds':
    case 'exceeds_approval_amount_limit':
    case 'exceeds_withdrawal_limit':
      return 'insufficient_funds';
    case 'expired_card':
      return 'expired_card';
    case 'incorrect_pin':
    case 'cannot_verify_pin':
    case 'pin_data_required':
    case 'pin_entry_tries_exceeded':
    case 'negative_cvv_result':
    case 'invalid_cvv':
      return 'authentication_failed';
    case 'error':
    case 'system_error':
    case 'issuer_unavailable':
    case 'file_temporarily_not_available':
    case 'unable_to_route_transaction':
      return 'processing_error';
    case 'reenter_transaction':
      return 'timeout';
    default:
      return 'declined';
  }
}

/** Which step-up a scenario demands before the charge can settle. */
export function nextActionFor(
  scenario: CardScenario,
): { type: 'authorize'; authorization: { type: string } } | { type: 'redirect_url' } | null {
  switch (scenario) {
    case 'auth_pin':
    case 'auth_pin_3ds':
      return { type: 'authorize', authorization: { type: 'pin' } };
    case 'auth_avs':
      return { type: 'authorize', authorization: { type: 'avs' } };
    case 'auth_3ds':
    case 'auth_redirect':
      return { type: 'redirect_url' };
    default:
      return null;
  }
}

/**
 * Whether a scenario steps up a *second* time after its first authorization.
 *
 * `auth_pin_3ds` is the documented failover: the customer enters a PIN and is
 * then redirected to 3-D Secure. Collapsing it into one step would hide the
 * exact case the scenario exists to test.
 */
export function fallsOverTo3ds(scenario: CardScenario): boolean {
  return scenario === 'auth_pin_3ds';
}

/** The mock PIN v4's documentation tells you to send. */
export const V4_MOCK_PIN = '12345';
export const V4_MOCK_OTP = '12345';
