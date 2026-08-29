import { createPrivateKey, createPublicKey, createSign, createVerify, type KeyObject } from 'node:crypto';

/**
 * Wise webhook verification — RSA, not HMAC.
 *
 * Wise is the only provider in paybox that signs **asymmetrically**. Its
 * documentation is explicit: *"Signatures are generated using an RSA key and
 * SHA256 digest of the message body. They are transmitted using the
 * X-Signature-SHA256 request header and are Base64 encoded."*
 * (docs.wise.com/guides/developer/webhooks/event-handling, read 2026-08-29.)
 *
 * Every other adapter here shares one secret between sender and receiver, so
 * "sign" and "verify" are the same operation. Wise does not: it holds a
 * private key, publishes the matching public key, and a consumer verifies
 * without ever holding anything secret. Reproducing that faithfully is what
 * makes it possible to test a real Wise verifier against the emulator — the
 * same `crypto.createVerify('RSA-SHA256')` call works against both.
 *
 * Three headers, all confirmed on that page:
 *
 *   X-Signature-SHA256  base64 RSA-SHA256 signature over the raw body
 *   X-Delivery-Id       a unique delivery UUID
 *   X-Test-Notification present, `true`, only on subscription test messages
 */
export const WISE_SIGNATURE_HEADER = 'X-Signature-SHA256';
export const WISE_DELIVERY_HEADER = 'X-Delivery-Id';
export const WISE_TEST_HEADER = 'X-Test-Notification';

/**
 * paybox's own keypair — **test-only, and public by construction**.
 *
 * This is not Wise's key and must never be confused for it. Wise's real
 * private key is theirs alone; paybox cannot sign as Wise and does not try.
 * What it does instead is what the other adapters do with their `sk_test_local_`
 * secrets: hold a credential that is deliberately worthless.
 *
 * The keypair is embedded rather than generated at boot for two reasons.
 * Generating 2048-bit RSA costs a few hundred milliseconds of startup, and —
 * the real reason — `generateKeyPairSync` cannot be seeded, so a fresh key per
 * run would make webhook signatures differ between two runs at the same seed.
 * That would break the one guarantee this project rests on (spec §7).
 *
 * Because the private key is published here, a signature from paybox proves
 * nothing about authenticity. It is not meant to: it exists so a developer's
 * verification code can be exercised end to end, against a key they can fetch
 * from `GET /wise/paybox/webhook-public-key`.
 */
export const WISE_TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbowHwvt8Ja3bj
ywFzk+PRW+BudYoVSJcnHnfpLH45U0XQDQporKJhc3hw6ugVtoDFyHGAY9jS/WoU
ViOYD8ovJFeKnlHRtU3FyCRyPgT5h2/l/0IT2UvHLnDaB5JDO8k3uwezrmBR6k3r
lEkKXDG4wJw5gNAajPkRozOVhWT1DjvIDQ+1AChxYeufAc/5MrMdKPnRi6dXAB6o
EjpwD9N28fjgqURXoAC0a5DxVsohf7vfKSNtMENYE1fT2lcy9UWuw1N8hk5VpBJF
1FTeekTIqgMCkqPtOTRxwlSUPKVH6ANWsnpI/u8TMbFg4ZpUv18c8Y8hlqHpC1CI
QTBHYNvlAgMBAAECggEABZ8cgFTHRetURtkRIIVseqY+E9n6AVfMYd+CBvGSTkFu
6ZthpLNA8D0qp1rMxDqsfw2vj9V2F5+LTS2+qQzqSXafai8wFwox7h1oYkSm4Fkf
K724Zh14qmVH3Trdx8DpPTKWY3aTyGb/+9eGJdzQ9505Z1hQQU1Akn2vF3eofwi/
RQnRUxT0jw9cSrgA4ODVTTl6pavpsZf9Fx3SE211d2kL+UHLdYTXIJTjyWG7O7op
MpW6hiBhITmUeWp3qVBzjlpW2kpeZjMyuyaDiR5H5zVnzqYuZmbs0GqPCkxDoXbf
2Lt0HWa27h6TTwJmGS7mTDHfcX/REtrP2rCKUiFx9wKBgQDaJPfC/gVaFKoU2jLP
ezZPuLR809guysoaH2XyqjAyRx06WY5EQxFG1zN56iJVV1i53Le+gmxO0YVmxhVc
3UDlI9YjKX2NLjOTlK+6QbcNFIF885UQ8Ipn2NLJ0wZiGnqJJamaiTekbxafdofJ
JvXj0ve4UCVRDBCBPWOT0j8nCwKBgQC2pSWEtZRgYDk7292pyiuFQQG9s0EDQzFP
vPillLelIVslfHErYH9xjxBJ09ViHvNN2PV3B3h+2e40yi80gUZ6hNh5fT3HmW7Y
F1Uo1AuMCnYrwCc5IGhx3KYiLMQ2Q+vnEK88xUIgt1+IxuR8IYx4oRG5eGRnDPkT
J2xTsVcezwKBgC/f8xwxQZ1ucZFX/dS5NscyQzIuEADc8pPfFjG2lhNCtjBrHSTw
Dyeb7SkxcE2IeOl5fj3qQ7jclMlkaaXSzP486i8XWP2WCS23cQWQjIrrWCvDDZEF
KWr3E/PFQ15eb0wQHvPSb4q/8pgWnGBSE57nWwRxWm86FZk3jtYPS1rXAoGAUe3m
1I73Tfwb8GQCHOXZe97bPxMnuKTte81S5EO/1U0PK9OUmFajFHeOYO+rKmaj0Wnf
QlORk6WCmx+O6UiMKu1ohabOjbif5kMhKj1kKJ+QvrNlZNTKxTirNW1LXuQ879um
H+aEcVSQgDRnzd7muj3WS5Jbx3YkTJlEmI5WfDUCgYAuy4CyxjF/G/CIZO5KX3Qc
YdWfOmk0NUrY44X0UXqNf5pBBi9gT8r/sqLBYDaU1fxCha+XAQ+BDlU95fATNHhc
JDAAG+zSl0E4KQW51GZUbTs6snYMXmTHeSCszfgEBNk54lD9GrdwmXebpbso1t6z
5FqRrhEmDm0N2p3sHxn7hw==
-----END PRIVATE KEY-----
`;

export const WISE_TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAm6MB8L7fCWt248sBc5Pj
0VvgbnWKFUiXJx536Sx+OVNF0A0KaKyiYXN4cOroFbaAxchxgGPY0v1qFFYjmA/K
LyRXip5R0bVNxcgkcj4E+Ydv5f9CE9lLxy5w2geSQzvJN7sHs65gUepN65RJClwx
uMCcOYDQGoz5EaMzlYVk9Q47yA0PtQAocWHrnwHP+TKzHSj50YunVwAeqBI6cA/T
dvH44KlEV6AAtGuQ8VbKIX+73ykjbTBDWBNX09pXMvVFrsNTfIZOVaQSRdRU3npE
yKoDApKj7Tk0ccJUlDylR+gDVrJ6SP7vEzGxYOGaVL9fHPGPIZah6QtQiEEwR2Db
5QIDAQAB
-----END PUBLIC KEY-----
`;

let cachedPrivate: KeyObject | null = null;
let cachedPublic: KeyObject | null = null;

function privateKey(): KeyObject {
  cachedPrivate ??= createPrivateKey(WISE_TEST_PRIVATE_KEY);
  return cachedPrivate;
}

function publicKey(): KeyObject {
  cachedPublic ??= createPublicKey(WISE_TEST_PUBLIC_KEY);
  return cachedPublic;
}

/** Sign the raw body exactly as Wise does: RSA-SHA256, base64. */
export function signWisePayload(rawBody: string, pem?: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(rawBody);
  signer.end();
  return signer.sign(pem ? createPrivateKey(pem) : privateKey(), 'base64');
}

/**
 * Verify a delivery the way a correct consumer would.
 *
 * This is the exact shape of Wise's own reference implementations, and it is
 * exported so a test — or a developer's own code — can call it against the
 * public key paybox publishes.
 */
export function verifyWiseSignature(signature: string, rawBody: string, pem?: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(pem ? createPublicKey(pem) : publicKey(), signature, 'base64');
  } catch {
    // A malformed signature is a failed verification, not a crash.
    return false;
  }
}

export function wiseSignatureHeaders(
  rawBody: string,
  deliveryId: string,
  options: { test?: boolean } = {},
): Record<string, string> {
  return {
    [WISE_SIGNATURE_HEADER]: signWisePayload(rawBody),
    [WISE_DELIVERY_HEADER]: deliveryId,
    ...(options.test ? { [WISE_TEST_HEADER]: 'true' } : {}),
  };
}
