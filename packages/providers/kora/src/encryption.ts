import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PayboxError } from '@paybox/shared';

/**
 * Kora's card payload encryption.
 *
 * A card charge does not send card details as JSON. The payload is
 * AES-256-GCM encrypted under the merchant's **secret key** and sent as a
 * single `charge_data` field in the form `iv:ciphertext:authTag`, all hex.
 * Verified against the sample payloads in the Kora Public APIs Postman
 * collection (docs.korapay.com, collection 303979/SVzxXeSM, read 2026-08-29),
 * whose `charge_data` values carry exactly that colon-delimited hex shape.
 *
 * The emulator decrypts it for the same reason it decrypts Flutterwave's: a
 * developer's existing integration already encrypts, and demanding plaintext
 * would force them to change the very code they are trying to test.
 *
 * Nothing decrypted here is ever stored -- the PAN is masked at the API
 * boundary and discarded (spec §29).
 */

/** AES-256 takes a 32-byte key; Kora's secret keys are longer, so they are hashed down. */
function normaliseKey(secretKey: string): Buffer {
  const raw = Buffer.from(secretKey, 'utf8');
  const key = Buffer.alloc(32);
  raw.copy(key, 0, 0, Math.min(raw.length, 32));
  // A key shorter than 32 bytes is padded by repetition rather than with
  // zeroes, so two short keys that share a prefix do not collide.
  for (let i = raw.length; i < 32 && raw.length > 0; i++) {
    key[i] = raw[i % raw.length]!;
  }
  return key;
}

/** Encrypt a payload exactly as a Kora SDK would. Used by the tests. */
export function encryptChargeData(secretKey: string, payload: unknown): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', normaliseKey(secretKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [iv.toString('hex'), encrypted.toString('hex'), cipher.getAuthTag().toString('hex')].join(
    ':',
  );
}

/**
 * Decrypt a `charge_data` field back into the payload the caller sent.
 *
 * Answers with Kora's own wording for a bad payload -- "Unable to decrypt
 * charge data, please check encryption and try again" is what their API says,
 * and a developer matching on that string should find it here too.
 */
export function decryptChargeData(
  secretKey: string,
  chargeData: string,
): Record<string, unknown> {
  const parts = chargeData.split(':');
  if (parts.length !== 3) {
    throw new PayboxError(
      'validation_failed',
      'Unable to decrypt charge data, please check encryption and try again.',
      { details: { expected: 'iv:ciphertext:authTag, hex-encoded' } },
    );
  }

  let plaintext: string;
  try {
    const [iv, body, tag] = parts as [string, string, string];
    const decipher = createDecipheriv(
      'aes-256-gcm',
      normaliseKey(secretKey),
      Buffer.from(iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(body, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new PayboxError(
      'validation_failed',
      'Unable to decrypt charge data, please check encryption and try again.',
    );
  }

  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PayboxError('validation_failed', 'The decrypted charge data was not a JSON object.');
  }
}
