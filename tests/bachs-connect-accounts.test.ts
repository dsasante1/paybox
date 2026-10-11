import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs Connect, phase one: connected accounts, persons, documents,
 * capabilities, requirements, onboarding links, and `X-Account-Id` scoping
 * every resource to its owner.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (the account,
 * person, document and link operations) and connect/* -- accounts,
 * capabilities, requirements, onboarding, testing, acting-as-an-account,
 * balances -- with the account-updated and capability-updated event pages.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
});

const PLATFORM_URL = 'https://platform.example.com/hooks';

/** Requests made as a connected account. */
function as(account: string) {
  const headers = () => ({
    authorization: `Bearer ${env.context.bachsKeys.secretKey}`,
    'content-type': 'application/json',
    'x-account-id': account,
  });
  return {
    get: (url: string) => env.app.inject({ method: 'GET', url: `/bachs${url}`, headers: headers() }),
    post: (url: string, body: unknown = {}) =>
      env.app.inject({ method: 'POST', url: `/bachs${url}`, headers: headers(), payload: body as object }),
    patch: (url: string, body: unknown) =>
      env.app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: headers(), payload: body as object }),
  };
}

async function createAccount(body: Record<string, unknown> = {}) {
  const response = await api.post('/v1/accounts', {
    contact_email: 'Seller@Example.com',
    display_name: 'Ada Stores',
    configuration: { recipient: {} },
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, any>;
}

const cents = (decimal: string) => Math.round(Number(decimal) * 100);

describe('creating an account', () => {
  it('answers 201 with the account, its capabilities granted at once, and what it owes', async () => {
    const account = await createAccount();
    expect(account).toMatchObject({
      id: expect.stringMatching(/^acct_[0-9A-Za-z]{16}$/),
      name: 'Ada Stores',
      owner_user_id: expect.stringMatching(/^usr_[0-9a-f]{12}$/),
      parent_organization_id: env.context.bachsKeys.organizationId,
      country: 'NG',
      entity_type: null,
      fee_handling: 'account_pays_fee',
      balance_currencies: [],
      is_active: true,
      responsibilities: { fees: { collector: 'bachs' } },
      configuration: { recipient: {} },
    });
    // "conversions is granted automatically for recipient-capable accounts".
    expect(account.enabled_capabilities).toEqual(['payouts', 'transfers', 'conversions']);
    expect(account.capabilities.payouts).toEqual({ status: 'active', requested: true, status_details: null });
    expect(account.requirements.currently_due).toEqual(['persons', 'payout_destination']);
    expect(account.requirements.entries[1]).toEqual({
      field: 'payout_destination',
      status: 'currently_due',
      restricts_capabilities: ['payouts'],
      errors: [],
      resolution: 'api',
      deadline: null,
    });
  });

  it('sends capability.updated on the account for each capability granted', async () => {
    const account = await createAccount();
    const events = await sent(env, 'capability.updated');
    expect(events.map((event) => event.data.capability)).toEqual(['payouts', 'transfers', 'conversions']);
    expect(events[0]).toMatchObject({
      organization_id: account.id,
      account: account.id,
      data: { account: account.id, capability: 'payouts', status: 'active', requested: true },
    });
  });

  it('requests a persona’s whole set when its capabilities are left out, and only those named otherwise', async () => {
    const merchant = await createAccount({ configuration: { merchant: {} } });
    expect(merchant.enabled_capabilities).toEqual([
      'card_collection',
      'ngn_card_collection',
      'bank_transfer',
      'mobile_money',
      'crypto',
      'virtual_accounts',
    ]);
    const named = await createAccount({
      contact_email: 'two@example.com',
      configuration: { merchant: { capabilities: { card_collection: { requested: true } } } },
    });
    expect(named.enabled_capabilities).toEqual(['card_collection']);
    expect(named.capabilities.crypto.status).toBe('unrequested');
  });

  it('refuses a bad configuration with the documented codes', async () => {
    const empty = await api.post('/v1/accounts', { contact_email: 'a@example.com', configuration: {} });
    expect(empty.statusCode).toBe(422);
    const persona = await api.post('/v1/accounts', { contact_email: 'a@example.com', configuration: { seller: {} } });
    expect(persona.json().error_code).toBe('invalid_configuration');
    const mismatch = await api.post('/v1/accounts', {
      contact_email: 'a@example.com',
      configuration: { merchant: { capabilities: { payouts: { requested: true } } } },
    });
    expect(mismatch.json().error_code).toBe('capability_configuration_mismatch');
    const unknown = await api.post('/v1/accounts', {
      contact_email: 'a@example.com',
      configuration: { merchant: { capabilities: { teleport: { requested: true } } } },
    });
    expect(unknown.json().error_code).toBe('unknown_capability');
  });

  it('lets no account create accounts of its own', async () => {
    const account = await createAccount();
    const response = await as(account.id).post('/v1/accounts', { contact_email: 'child@example.com' });
    expect(response.statusCode).toBe(403);
  });
});

describe('reading accounts', () => {
  it('reads a child by path, and never confirms an account that is not one', async () => {
    const account = await createAccount();
    expect((await api.get(`/v1/accounts/${account.id}`)).json().id).toBe(account.id);
    expect((await api.get('/v1/accounts/acct_0000000000000000')).statusCode).toBe(404);
  });

  it('lists accounts with the single-read blocks left null', async () => {
    const first = await createAccount();
    const second = await createAccount({ contact_email: 'b@example.com' });
    const list = (await api.get('/v1/accounts')).json();
    expect(list).toMatchObject({ total: 2, limit: 20, offset: 0 });
    expect(list.items.map((item: any) => item.id)).toEqual([second.id, first.id]);
    expect(list.items[0]).toMatchObject({ capabilities: null, requirements: null, responsibilities: null, configuration: null });
  });

  it('answers /me with the platform, which holds connect', async () => {
    const me = (await api.get('/v1/accounts/me')).json();
    expect(me).toMatchObject({
      id: env.context.bachsKeys.organizationId,
      parent_organization_id: null,
      capabilities: null,
      requirements: null,
    });
    expect(me.enabled_capabilities).toContain('connect');
  });

  it('adds requirements.values only when asked, and refuses an unknown include', async () => {
    const account = await createAccount();
    const plain = (await api.get(`/v1/accounts/${account.id}`)).json();
    expect(plain.requirements.values).toBeUndefined();
    const withValues = (await api.get(`/v1/accounts/${account.id}?include=requirements.values`)).json();
    expect(withValues.requirements.values).toEqual([]);
    const bad = await api.get(`/v1/accounts/${account.id}?include=requirements.secrets`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_code).toBe('invalid_include');
  });
});

describe('requirements', () => {
  it('takes requirement values through fields, creating the payout destination and clearing what they satisfy', async () => {
    const account = await createAccount();
    const updated = await api.post(`/v1/accounts/${account.id}`, {
      fields: {
        persons: [{ first_name: 'Ada', last_name: 'Obi', relationship: { representative: true } }],
        payout_destination: { currency: 'NGN', bank_code: '999', account_number: '0001112223', account_name: 'Ada Obi' },
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().requirements.currently_due).toEqual([]);

    const [event] = (await sent(env, 'account.updated')).slice(-1);
    expect(event).toMatchObject({ account: account.id, data: { account: account.id, outstanding: [] } });

    // The destination is the account's, not the platform's.
    const mine = (await as(account.id).get('/v1/payouts/destinations')).json();
    expect(mine.destinations).toHaveLength(1);
    expect(mine.destinations[0]).toMatchObject({ currency: 'NGN', is_default: true, status: 'approved' });
    expect((await api.get('/v1/payouts/destinations')).json().destinations).toHaveLength(0);
  });

  it('saves none of the fields when one is invalid, while what came first stays', async () => {
    const account = await createAccount({ configuration: { merchant: {} } });
    const response = await api.post(`/v1/accounts/${account.id}`, {
      display_name: 'Renamed',
      fields: {
        business_profile: { product_description: 'Shoes', product_category: 'not_a_category' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'INVALID_REQUIREMENT_FIELD',
      errors: [{ field: 'business_profile.product_category', code: 'invalid' }],
    });
    const read = (await api.get(`/v1/accounts/${account.id}`)).json();
    expect(read.name).toBe('Renamed');
    expect(read.requirements.currently_due).toContain('business_profile.product_description');
  });

  it('keeps an incomplete payout destination due, with a `required` error, without failing the call', async () => {
    const account = await createAccount();
    const response = await api.post(`/v1/accounts/${account.id}`, {
      fields: { payout_destination: { currency: 'NGN', bank_code: '999' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().requirements.errors).toEqual([
      { field: 'payout_destination', code: 'required', reason: 'account_number, account_name required' },
    ]);
  });

  it('names the destination rejections', async () => {
    const account = await createAccount();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bank_code: '999' }, 'currency_required'],
      [{ currency: 'GBP' }, 'currency_not_supported'],
      [{ currency: 'GHS', account_number: '1' }, 'type_required'],
      [{ currency: 'NGN', bank_code: '123', account_number: '0001112223', account_name: 'X' }, 'bank_code_unknown'],
      [{ currency: 'KES', type: 'mobile_money', phone_number: '+254700000000', mobile_provider: 'NOPE' }, 'mobile_provider_unknown'],
    ];
    for (const [destination, code] of cases) {
      const response = await api.post(`/v1/accounts/${account.id}`, { fields: { payout_destination: destination } });
      expect(response.json().errors?.[0]?.code, JSON.stringify(destination)).toBe(code);
    }
  });

  it('refuses withdrawing a capability once requested', async () => {
    const account = await createAccount();
    const response = await api.post(`/v1/accounts/${account.id}`, {
      configuration: { recipient: { capabilities: { payouts: { requested: false } } } },
    });
    expect(response.json().error_code).toBe('capability_unrequest_unsupported');
  });
});

describe('persons and documents', () => {
  it('reviews an identity document before the requirement clears', async () => {
    const account = await createAccount({ configuration: { merchant: {} } });
    const person = (
      await api.post(`/v1/accounts/${account.id}/persons`, {
        first_name: 'Ada',
        last_name: 'Obi',
        dob: '1990-01-31',
        id_number: '12345678901',
        relationship: { representative: true },
      })
    ).json();
    expect(person).toMatchObject({
      id: expect.stringMatching(/^per_[0-9a-f]{8}$/),
      id_number_provided: true,
      verification: { status: 'unverified', document_provided: false, failure_reason: null },
    });
    const due = (await api.get(`/v1/accounts/${account.id}`)).json().requirements.currently_due;
    expect(due).toContain(`persons.${person.id}.id_document`);

    const upload = await env.app.inject({
      method: 'POST',
      url: '/bachs/v1/utilities/uploads',
      headers: {
        authorization: `Bearer ${env.context.bachsKeys.secretKey}`,
        'content-type': 'multipart/form-data; boundary=x',
      },
      payload: Buffer.from(
        '--x\r\nContent-Disposition: form-data; name="file"; filename="nin.png"\r\nContent-Type: image/png\r\n\r\n' +
          '\x89PNG\r\n\x1a\n0000\r\n--x--\r\n',
        'latin1',
      ),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const attached = await api.post(`/v1/accounts/${account.id}/persons/${person.id}/documents`, {
      file: upload.json().upload_id,
      document: 'primary_verification',
      side: 'front',
    });
    expect(attached.statusCode, attached.body).toBe(201);
    expect(attached.json()).toMatchObject({ person: person.id, document_type: 'primary_verification', file_name: 'nin.png' });
    const pending = (await api.get(`/v1/accounts/${account.id}`)).json().requirements;
    expect(pending.pending_verification).toEqual([`persons.${person.id}.id_document`]);

    // paybox's review control: the reviewer fails it, then passes it.
    const failed = await api.post(`/v1/accounts/${account.id}/requirements/review`, {
      field: `persons.${person.id}.id_document`,
      outcome: 'reject',
      reason: 'The document image was too blurry to read.',
    });
    expect(failed.json().requirements.errors).toEqual([
      { field: `persons.${person.id}.id_document`, code: 'verification_failed', reason: 'The document image was too blurry to read.' },
    ]);
    await api.post(`/v1/accounts/${account.id}/requirements/review`, {
      field: `persons.${person.id}.id_document`,
      outcome: 'accept',
    });
    const read = (await api.get(`/v1/accounts/${account.id}/persons/${person.id}`)).json();
    expect(read.verification).toEqual({ status: 'verified', document_provided: true, failure_reason: null });
  });

  it('keeps the representative, lists persons oldest first, and removes the others', async () => {
    const account = await createAccount();
    const rep = (await api.post(`/v1/accounts/${account.id}/persons`, { first_name: 'A', relationship: { representative: true } })).json();
    const other = (await api.post(`/v1/accounts/${account.id}/persons`, { first_name: 'B' })).json();
    const list = (await api.get(`/v1/accounts/${account.id}/persons`)).json();
    expect(list.items.map((item: any) => item.id)).toEqual([rep.id, other.id]);
    const refused = await env.app.inject({
      method: 'DELETE',
      url: `/bachs/v1/accounts/${account.id}/persons/${rep.id}`,
      headers: { authorization: `Bearer ${env.context.bachsKeys.secretKey}` },
    });
    expect(refused.json().error_code).toBe('representative_cannot_be_removed');
    const removed = await env.app.inject({
      method: 'DELETE',
      url: `/bachs/v1/accounts/${account.id}/persons/${other.id}`,
      headers: { authorization: `Bearer ${env.context.bachsKeys.secretKey}` },
    });
    expect(removed.statusCode).toBe(204);
    expect((await api.get(`/v1/accounts/${account.id}/persons?limit=500`)).statusCode).toBe(422);
  });
});

describe('capabilities', () => {
  it('lists every applicable capability, and shows a restriction paybox’s control applied', async () => {
    const account = await createAccount();
    const restricted = await api.post(`/v1/accounts/${account.id}/capabilities/payouts`, { status: 'restricted' });
    expect(restricted.statusCode, restricted.body).toBe(200);
    const items = (await api.get(`/v1/accounts/${account.id}/capabilities`)).json().items;
    expect(items.find((item: any) => item.name === 'payouts')).toEqual({
      name: 'payouts',
      status: 'restricted',
      requested: true,
      status_details: [
        {
          code: 'platform_disabled',
          resolution: 'Contact support to re-enable this capability.',
          message: 'This capability was disabled by the platform.',
        },
      ],
    });
    expect(items.find((item: any) => item.name === 'connect')).toMatchObject({ status: 'unrequested' });
    const [event] = (await sent(env, 'capability.updated')).slice(-1);
    expect(event?.data).toEqual({ account: account.id, capability: 'payouts', status: 'restricted', requested: true });
  });
});

describe('onboarding links', () => {
  it('opens a single-use page that submits what is due, then returns', async () => {
    const account = await createAccount();
    const created = await api.post(`/v1/accounts/${account.id}/account-links`, {
      type: 'onboarding',
      refresh_url: 'https://platform.example.com/refresh',
      return_url: 'https://platform.example.com/return',
    });
    expect(created.statusCode).toBe(200);
    const link = created.json();
    expect(link).toMatchObject({
      id: expect.stringMatching(/^alnk_[0-9a-f]{20}$/),
      object: 'connected_account_link',
      account: account.id,
      type: 'onboarding',
      expires_at: '2026-07-14T12:00:00.000Z',
      previous_link_superseded: false,
    });
    const path = new URL(link.url).pathname;
    expect(path).toMatch(new RegExp(`^/bachs/connect/setup/c/${account.id}/al_[0-9A-Za-z]{32}$`));

    const page = await env.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="payout_destination.bank_code"');

    const submitted = await env.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        'persons.new.first_name': 'Ada',
        'persons.new.last_name': 'Obi',
        'payout_destination.currency': 'NGN',
        'payout_destination.bank_code': '999',
        'payout_destination.account_number': '0001112223',
        'payout_destination.account_name': 'Ada Obi',
      }).toString(),
    });
    expect(submitted.statusCode).toBe(303);
    expect(submitted.headers.location).toBe('https://platform.example.com/return');
    expect((await api.get(`/v1/accounts/${account.id}`)).json().requirements.currently_due).toEqual([]);

    // Used: the next visit is sent to refresh_url for a new link.
    const again = await env.app.inject({ method: 'GET', url: path });
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe('https://platform.example.com/refresh');
  });

  it('supersedes an open link of the same type, and expires', async () => {
    const account = await createAccount();
    const body = { type: 'onboarding', refresh_url: 'https://p.example.com/r', return_url: 'https://p.example.com/x' };
    const first = (await api.post(`/v1/accounts/${account.id}/account-links`, body)).json();
    const second = (await api.post(`/v1/accounts/${account.id}/account-links`, body)).json();
    expect(second.previous_link_superseded).toBe(true);
    expect((await env.app.inject({ method: 'GET', url: new URL(first.url).pathname })).statusCode).toBe(302);
    await api.advance('31d');
    expect((await env.app.inject({ method: 'GET', url: new URL(second.url).pathname })).statusCode).toBe(302);
  });
});

describe('acting as an account', () => {
  it('refuses an account that is not the platform’s own child with 403', async () => {
    const response = await as('acct_0000000000000000').get('/v1/products');
    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('FORBIDDEN');
  });

  it('keeps every resource to its owner', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const seller = as(account.id);

    const product = (await seller.post('/v1/products', { name: 'Shoes', price: { currency: 'USD', amount: '10.00' } })).json();
    expect(product.organization_id).toBe(account.id);
    expect((await api.get(`/v1/products/${product.id}`)).statusCode).toBe(404);
    expect((await seller.get(`/v1/products/${product.id}`)).statusCode).toBe(200);
    expect((await api.get('/v1/products')).json().items).toEqual([]);

    // One email can be a customer of the platform and of each account.
    const theirs = (await seller.post('/v1/customers', { email: 'jane@example.com' })).json();
    const ours = (await api.post('/v1/customers', { email: 'jane@example.com' })).json();
    expect(theirs.customer_id).not.toBe(ours.customer_id);
    expect((await api.get(`/v1/customers/${theirs.customer_id}`)).statusCode).toBe(404);

    const checkout = (await seller.post('/v1/checkout-sessions', { product_cart: [{ product_id: product.id }] })).json();
    expect((await api.get(`/v1/checkout-sessions/${checkout.checkout_id}`)).statusCode).toBe(404);
    // Another owner's product is not on the account's cart.
    const foreign = await api.product({ currency: 'USD', amount: '5.00' }, {});
    const refused = await seller.post('/v1/checkout-sessions', { product_cart: [{ product_id: foreign }] });
    expect(refused.json().error_code).toBe('PRODUCT_NOT_FOUND');
  });

  it('makes a checkout created as the account a direct charge: the account’s money and the account’s events', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const seller = as(account.id);
    // The platform listens to its accounts' events; the account has its own endpoint.
    await api.post('/v1/webhooks/endpoints', {
      url: PLATFORM_URL,
      name: 'connect',
      event_types: ['collection.succeeded'],
      event_source: 'connect',
    });
    await api.post('/v1/webhooks/endpoints', {
      url: 'https://platform.example.com/own',
      name: 'own',
      event_types: ['collection.succeeded'],
    });
    await seller.post('/v1/webhooks/endpoints', {
      url: 'https://seller.example.com/hooks',
      name: 'seller',
      event_types: ['collection.succeeded'],
    });
    const platformBefore = cents((await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);

    const session = (
      await seller.post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
      })
    ).json();
    const path = new URL(session.checkout_url).pathname;
    await api.pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await api.advance('1s');

    const balance = (await seller.get('/v1/balances')).json();
    expect(balance.account_id).toBe(account.id);
    const usd = cents(balance.balances.find((b: any) => b.currency === 'USD').available_balance);
    expect(usd).toBeGreaterThan(9_000);
    expect(usd).toBeLessThan(10_000);
    const platformAfter = cents((await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);
    expect(platformAfter).toBe(platformBefore);

    const [event] = await sent(env, 'collection.succeeded');
    expect(event).toMatchObject({ organization_id: account.id, account: account.id });
    // The payments list is the owner's.
    expect((await seller.get('/v1/payments')).json().items).toHaveLength(1);
    expect((await api.get('/v1/payments')).json().items).toHaveLength(0);

    await api.advance('1m');
    const urls = env.transport.sent
      .filter((request) => JSON.parse(request.body).type === 'collection.succeeded')
      .map((request) => request.url)
      .sort();
    expect(urls).toEqual([
      'https://merchant.example.com/webhooks/bachs',
      PLATFORM_URL,
      'https://seller.example.com/hooks',
    ]);
  });

  it('pays out of the account’s own balance, refused while that balance is in debt', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const seller = as(account.id);
    const destination = (
      await seller.post('/v1/payouts/destinations', { currency: 'NGN', bank_code: '999', account_number: '0001112223' })
    ).json();
    // An account starts at zero: "handing every connected account a free float" is not modelled.
    const empty = await seller.post('/v1/payouts', { destination: destination.id, amount: '10.00' });
    expect(empty.statusCode).toBe(400);
    // The platform's destination is not the account's.
    const platformDestination = (
      await api.post('/v1/payouts/destinations', { currency: 'NGN', bank_code: '999', account_number: '0001112223' })
    ).json();
    const foreign = await seller.post('/v1/payouts', { destination: platformDestination.id, amount: '10.00' });
    expect(foreign.json().error_code).toBe('DESTINATION_NOT_FOUND');
  });
});

describe('reference lists', () => {
  it('serves the published business structures and product categories', async () => {
    const structures = (await api.get('/v1/reference/business-structures?country=NG')).json();
    expect(structures.structures.map((entry: any) => entry.value)).toEqual([
      'business_name',
      'private_incorporated',
      'incorporated_trustees',
    ]);
    const categories = (await api.get('/v1/reference/product-categories')).json();
    expect(categories.sections).toEqual([
      { label: 'Software & technology', categories: ['software_as_a_service_saas', 'mobile_or_web_app'] },
    ]);
  });
});

describe('review findings', () => {
  async function payAsAccount(account: string, body: Record<string, unknown>, form: Record<string, string>) {
    const session = (await as(account).post('/v1/checkout-sessions', { customer: { email: 'buyer@example.com' }, ...body })).json();
    const path = new URL(session.checkout_url).pathname;
    const paid = await api.pagePost(`${path}/pay`, form);
    return { session, path, paid };
  }
  const usdOf = async (who: ReturnType<typeof as> | typeof api) =>
    cents((await who.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);

  it('keeps an overpayment on a direct charge in the account’s balance', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const platform = await usdOf(api);
    const { path } = await payAsAccount(account.id, { pricing: { currency: 'USD', amount: '29.00' } }, {
      corridor: 'CRYPTO',
      asset: 'USDT_TRC20',
    });
    await api.pagePost(`${path}/simulate`, { action: 'overpaid' });
    await api.advance('1s');
    expect(await usdOf(api)).toBe(platform);
    const ledger = (await env.context.storage.ledger.list({ provider: 'bachs', limit: 500 })).items;
    expect(ledger.find((entry) => entry.reason === 'overpayment')?.subaccountId).toBe(
      (await env.context.storage.subaccounts.byCode('bachs', account.id))?.id,
    );
  });

  it('keeps references to their owner', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    expect((await as(account.id).post('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '5.00' }, reference: 'ORDER-1' })).statusCode).toBe(201);
    expect((await api.post('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '5.00' }, reference: 'ORDER-1' })).statusCode).toBe(201);
  });

  it('keeps an account’s reference from colliding with a platform reference that looks like it', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const price = { pricing: { currency: 'USD', amount: '5.00' } };
    expect((await api.post('/v1/checkout-sessions', { ...price, reference: `${account.id}:ORDER-1` })).statusCode).toBe(201);
    expect((await as(account.id).post('/v1/checkout-sessions', { ...price, reference: 'ORDER-1' })).statusCode).toBe(201);
  });

  it('fails an account’s subscription renewal once its card capability is restricted', async () => {
    const account = await createAccount({ configuration: { merchant: {}, recipient: {} } });
    const seller = as(account.id);
    const product = (
      await seller.post('/v1/products', {
        name: 'Plan',
        price: { currency: 'USD', amount: '10.00' },
        billing_cycle: { interval: 'month', frequency: 1 },
      })
    ).json();
    const customer = (await seller.post('/v1/customers', { email: 'sub@example.com' })).json();
    const session = (
      await seller.post('/v1/checkout-sessions', {
        product_cart: [{ product_id: product.id }],
        customer: { customer_id: customer.customer_id },
      })
    ).json();
    await api.payByCard(new URL(session.checkout_url).pathname);
    await api.post(`/v1/accounts/${account.id}/capabilities/card_collection`, { status: 'restricted' });
    await api.advance('32d');
    const subscriptions = (await seller.get(`/v1/subscriptions?customer_id=${customer.customer_id}`)).json().items;
    expect(subscriptions[0].status).toBe('past_due');
  });

  it('enforces the account’s capabilities: a restricted payouts, a method it does not hold', async () => {
    const account = await createAccount({ configuration: { recipient: {} } });
    const destination = (
      await as(account.id).post('/v1/payouts/destinations', { currency: 'NGN', bank_code: '999', account_number: '0001112223' })
    ).json();
    await api.post(`/v1/accounts/${account.id}/capabilities/payouts`, { status: 'restricted' });
    const payout = await as(account.id).post('/v1/payouts', { destination: destination.id, amount: '1.00' });
    expect(payout.json().error_code).toBe('PAYOUTS_NOT_ENABLED');

    const { paid } = await payAsAccount(account.id, { pricing: { currency: 'USD', amount: '10.00' } }, {
      corridor: 'USD_CARD',
      card_number: '4242424242424242',
    });
    expect(paid.body).toContain('card_collection capability is not active');
  });

  it('lets the platform pay a direct charge’s fee when it collects fees', async () => {
    const account = await createAccount({
      configuration: { merchant: {}, recipient: {} },
      responsibilities: { fees: { collector: 'platform' } },
    });
    const platform = await usdOf(api);
    await payAsAccount(account.id, { pricing: { currency: 'USD', amount: '100.00' } }, {
      corridor: 'USD_CARD',
      card_number: '4242424242424242',
    });
    await api.advance('1s');
    expect(await usdOf(as(account.id))).toBe(10_000);
    expect(await usdOf(api)).toBeLessThan(platform);
  });

  it('takes several persons on the onboarding page', async () => {
    const account = await createAccount();
    const one = (await api.post(`/v1/accounts/${account.id}/persons`, { relationship: { representative: true } })).json();
    const two = (await api.post(`/v1/accounts/${account.id}/persons`, {})).json();
    const link = (
      await api.post(`/v1/accounts/${account.id}/account-links`, {
        type: 'onboarding',
        refresh_url: 'https://p.example.com/r',
        return_url: 'https://p.example.com/x',
      })
    ).json();
    const submitted = await env.app.inject({
      method: 'POST',
      url: new URL(link.url).pathname,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        [`persons.${one.id}.first_name`]: 'A',
        [`persons.${one.id}.last_name`]: 'B',
        [`persons.${two.id}.first_name`]: 'C',
        [`persons.${two.id}.last_name`]: 'D',
      }).toString(),
    });
    expect(submitted.statusCode).toBe(303);
    const due = (await api.get(`/v1/accounts/${account.id}`)).json().requirements.currently_due;
    expect(due.filter((field: string) => field.startsWith('persons.'))).toEqual([]);
  });

  it('keeps a control-API endpoint receiving everything after it is renamed', async () => {
    await api.patch('/v1/webhooks/endpoints/whe_all', { name: 'renamed' });
    expect((await api.get('/v1/webhooks/endpoints/whe_all')).json().event_source).toBe('all');
  });

  it('lets no account review itself', async () => {
    const account = await createAccount();
    const self = await as(account.id).post(`/v1/accounts/${account.id}/capabilities/payouts`, { status: 'active' });
    expect(self.statusCode).toBe(403);
  });

  it('lets the platform read and replay its accounts’ events', async () => {
    const account = await createAccount();
    const [event] = await sent(env, 'capability.updated');
    expect((await api.get(`/v1/webhooks/events/${event!.id}`)).statusCode).toBe(200);
    const listed = (await api.get('/v1/webhooks/events')).json().items;
    expect(listed.find((item: any) => item.event_id === event!.id)?.account).toBe(account.id);
    expect((await api.post('/v1/webhooks/replay', { event_id: event!.id })).statusCode).toBe(200);
  });
});
