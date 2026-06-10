import { describe, expect, it } from 'vitest';

import {
  CryptoError,
  decrypt,
  encrypt,
  generateApiKey,
  generateMasterKey,
  hashApiKey,
  secureRandomInt,
  sha256Hex,
  timingSafeEqual,
} from '../../../src/utils/crypto.js';

describe('crypto: AES-256-GCM envelope', () => {
  it('round-trips encrypt → decrypt to the original plaintext', () => {
    const plaintext = 'sk-super-secret-provider-key';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const plaintext = 'same input';
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  it('decrypts under a caller-supplied key (rotation support)', () => {
    const key = Buffer.from(generateMasterKey(), 'hex');
    const envelope = encrypt('rotate me', key);
    expect(decrypt(envelope, key)).toBe('rotate me');
  });

  it('throws when decrypting with the wrong key', () => {
    const envelope = encrypt('secret', Buffer.from(generateMasterKey(), 'hex'));
    const otherKey = Buffer.from(generateMasterKey(), 'hex');
    expect(() => decrypt(envelope, otherKey)).toThrow(CryptoError);
  });

  it('throws when the ciphertext has been tampered with (GCM auth tag)', () => {
    const envelope = encrypt('secret');
    const parts = envelope.split('.');
    // Flip a character in the ciphertext segment.
    const ct = parts[3] ?? '';
    parts[3] = `${ct.slice(0, -1)}${ct.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decrypt(parts.join('.'))).toThrow(CryptoError);
  });

  it('rejects a malformed envelope', () => {
    expect(() => decrypt('not-a-valid-envelope')).toThrow(CryptoError);
  });
});

describe('crypto: hashing and keys', () => {
  it('SHA-256 is deterministic and hex-encoded', () => {
    const a = sha256Hex('hello');
    expect(a).toBe(sha256Hex('hello'));
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('generates API keys in the gw-{32 hex} format with a matching hash', () => {
    const { raw, hash } = generateApiKey();
    expect(raw).toMatch(/^gw-[0-9a-f]{32}$/u);
    expect(hash).toBe(hashApiKey(raw));
  });

  it('generates a 64-hex-character master key', () => {
    expect(generateMasterKey()).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('crypto: timing-safe comparison', () => {
  it('returns true for equal inputs', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for unequal inputs (including differing lengths)', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('crypto: secureRandomInt', () => {
  it('stays within [0, max)', () => {
    for (let i = 0; i < 1_000; i += 1) {
      const n = secureRandomInt(5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }
  });

  it('throws on a non-positive bound', () => {
    expect(() => secureRandomInt(0)).toThrow(CryptoError);
  });
});
