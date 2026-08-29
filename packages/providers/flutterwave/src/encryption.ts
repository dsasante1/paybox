import { createDecipheriv, createCipheriv } from 'node:crypto';
import { PayboxError } from '@paybox/shared';

/**
 * Flutterwave's direct-card payload encryption.
 *
 * A direct card charge does not send card details as JSON. The payload is
 * serialised, encrypted with **3DES-ECB** under the merchant's encryption key,
 * base64-encoded, and sent as a single `client` field. Verified against
 * developer.flutterwave.com/v3.0.0/docs/encryption (read 2026-08-29), whose
 * reference implementation is `forge.cipher.createCipher("3DES-ECB", key)`
 * followed by `encode64`.
 *
 * The emulator has to decrypt it for one reason: a developer's existing
 * integration already encrypts, and an emulator that demanded plaintext would
 * force them to change the very code they are trying to test. Reproducing the
 * scheme is what makes their real client work unmodified.
 *
 * 3DES is long obsolete and this is not an endorsement of it -- but it is what
 * the provider does, and inventing something stronger would break every
 * caller. Nothing decrypted here is ever stored: the PAN is masked at the API
 * boundary and discarded (spec §29).
 */

/** 3DES-EDE3 takes a 24-byte key. Flutterwave's encryption keys are 24 chars. */
const KEY_LENGTH = 24;

function normaliseKey(encryptionKey: string): Buffer {
  const raw = Buffer.from(encryptionKey, 'utf8');
  if (raw.length === KEY_LENGTH) return raw;
  // Node requires exactly 24 bytes. Shorter keys are padded and longer ones
  // truncated so a hand-made test key still works rather than throwing an
  // error about key length that means nothing to the caller.
  const key = Buffer.alloc(KEY_LENGTH);
  raw.copy(key, 0, 0, Math.min(raw.length, KEY_LENGTH));
  return key;
}

/** Encrypt a payload exactly as a Flutterwave SDK would. Used by the tests. */
export function encryptPayload(encryptionKey: string, payload: unknown): string {
  const cipher = createCipheriv('des-ede3', normaliseKey(encryptionKey), null);
  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

/**
 * Decrypt a `client` field back into the payload the caller sent.
 *
 * Throws a validation error rather than letting a crypto exception escape: a
 * mismatched encryption key is a mistake a developer makes constantly, and
 * "Bad decrypt" tells them nothing about which key to fix.
 */
export function decryptPayload(encryptionKey: string, client: string): Record<string, unknown> {
  let plaintext: string;
  try {
    const decipher = createDecipheriv('des-ede3', normaliseKey(encryptionKey), null);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(client, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new PayboxError(
      'validation_failed',
      'Could not decrypt the `client` payload. Check that you encrypted it with 3DES-ECB ' +
        'under this environment’s encryption key — `paybox status` prints it.',
    );
  }

  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PayboxError(
      'validation_failed',
      'The decrypted `client` payload was not a JSON object.',
    );
  }
}
