/**
 * v4 resource ids.
 *
 * v4 uses prefixed, opaque, mixed-case strings -- `cus_J0PvwvJB2n`,
 * `pmd_wlVhaYmkl2`, `chg_VoUhmFMhmF` -- where v3 used bare integers. Verified
 * at developer.flutterwave.com/docs/charging-a-card (read 2026-08-29).
 *
 * Derived from the canonical id rather than generated, so the same resource
 * always serialises to the same string under a fixed seed. Deterministic ids
 * are what let the compat suite assert on them literally.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function toKoraLikeId(prefix: string, canonicalId: string): string {
  const body = canonicalId.replace(/^[a-z]+_/, '');
  let hash = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Ten characters, which is the length Flutterwave's own examples use.
  let seed = hash;
  for (let i = 0; i < 10; i++) {
    seed = Math.imul(seed ^ (seed >>> 13), 0x01000193) >>> 0;
    out.push(ALPHABET[seed % ALPHABET.length]!);
  }
  return `${prefix}_${out.join('')}`;
}
