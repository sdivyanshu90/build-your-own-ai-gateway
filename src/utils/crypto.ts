/**
 * Cryptographic primitives.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Provider credentials are encrypted at rest with AES-256-GCM (authenticated
 *     encryption: confidentiality + integrity in one pass). Each ciphertext
 *     carries its own random 12-byte IV — the GCM-recommended nonce size — so
 *     encrypting the same plaintext twice yields different ciphertexts and a
 *     reused (key, IV) pair is impossible in normal operation.
 *   • Envelope format is versioned (`v1.<iv>.<tag>.<ct>`, all base64url) so a
 *     future algorithm change is a non-breaking, detectable migration rather
 *     than an ambiguous blob.
 *   • API keys are never stored in plaintext: only their SHA-256 hash is
 *     persisted, and lookups compare hashes. Equality checks that touch secrets
 *     use a constant-time comparison to avoid timing side channels.
 *   • All key material is handled as Buffers and the master key is parsed once.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto';

import { config } from '../config/index.js';

/** Raised on any encryption/decryption failure (wrong key, tampered ciphertext). */
export class CryptoError extends Error {
  public override readonly name = 'CryptoError';
}

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const AUTH_TAG_BYTES = 16; // 128-bit authentication tag.
const MASTER_KEY_BYTES = 32; // AES-256.
const API_KEY_RANDOM_BYTES = 16; // → 32 hex chars, matching the `gw-{32 hex}` format.

/**
 * The master key, parsed once from the validated hex config value. Parsing here
 * (module load) means a malformed key fails fast rather than on first encrypt.
 */
const MASTER_KEY: Buffer = (() => {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new CryptoError(
      `ENCRYPTION_KEY must decode to ${MASTER_KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
  return key;
})();

/**
 * Encrypt UTF-8 plaintext with AES-256-GCM, returning a self-describing,
 * versioned envelope string safe to store in a text column.
 *
 * @param plaintext  the secret to protect (e.g. a provider API key)
 * @param key        the 32-byte key; defaults to the configured master key.
 *                   Accepting a key parameter keeps the function pure and lets
 *                   the rotation script encrypt under a new key.
 */
export function encrypt(plaintext: string, key: Buffer = MASTER_KEY): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt an envelope produced by {@link encrypt}. Throws {@link CryptoError} on
 * a malformed envelope, a wrong key, or a tampered ciphertext (the GCM auth tag
 * verification fails and is surfaced as an error, never silently ignored).
 */
export function decrypt(envelope: string, key: Buffer = MASTER_KEY): string {
  assertKeyLength(key);
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new CryptoError('Malformed ciphertext envelope: expected 4 segments.');
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== ENVELOPE_VERSION) {
    throw new CryptoError(`Unsupported ciphertext version: ${version}.`);
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new CryptoError('Malformed ciphertext envelope: bad IV or auth tag length.');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (cause) {
    // A failed auth tag (tamper or wrong key) lands here; never leak details.
    throw new CryptoError('Decryption failed: wrong key or tampered ciphertext.', { cause });
  }
}

/** Deterministic, hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash a raw API key for storage/lookup. Alias of {@link sha256Hex} for intent. */
export function hashApiKey(rawKey: string): string {
  return sha256Hex(rawKey);
}

/**
 * Generate a new API key. The raw value (`gw-` + 32 hex chars) is returned ONCE
 * to the caller; only its hash is ever persisted.
 */
export function generateApiKey(): { readonly raw: string; readonly hash: string } {
  const raw = `gw-${randomBytes(API_KEY_RANDOM_BYTES).toString('hex')}`;
  return { raw, hash: hashApiKey(raw) };
}

/** Generate a fresh 32-byte master key, hex-encoded, for ENCRYPTION_KEY rotation. */
export function generateMasterKey(): string {
  return randomBytes(MASTER_KEY_BYTES).toString('hex');
}

/**
 * Constant-time string comparison. Returns false for differing lengths without
 * short-circuiting in a way that leaks length via timing beyond the unavoidable
 * minimum (we hash both inputs to equal-length digests first).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Compare fixed-length SHA-256 digests so timing does not depend on input
  // length or content position; both branches do identical work.
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return nodeTimingSafeEqual(da, db);
}

/**
 * Cryptographically secure integer in [0, maxExclusive). Wraps `crypto.randomInt`
 * so the RANDOM load-balancer strategy never depends on `Math.random`.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
    throw new CryptoError('secureRandomInt requires a positive integer bound.');
  }
  return randomInt(maxExclusive);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new CryptoError(`Key must be ${MASTER_KEY_BYTES} bytes for ${ALGORITHM}.`);
  }
}
