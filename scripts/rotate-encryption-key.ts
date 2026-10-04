/**
 * Rotate the master encryption key.
 *
 * Re-encrypts every provider credential under NEW_ENCRYPTION_KEY. Credentials
 * are decrypted with ENCRYPTION_KEY and, if set, ENCRYPTION_KEY_PREVIOUS, so the
 * script is idempotent and safe to re-run. The whole re-encryption runs in a
 * single transaction with row locks, so the table is never left half-rotated.
 *
 * Zero-downtime procedure (see docs/security.md):
 *   1. openssl rand -hex 32            -> NEW
 *   2. roll the gateway with ENCRYPTION_KEY=NEW and ENCRYPTION_KEY_PREVIOUS=OLD
 *      (rows are still under OLD; replicas decrypt them via the previous key)
 *   3. ENCRYPTION_KEY=NEW ENCRYPTION_KEY_PREVIOUS=OLD NEW_ENCRYPTION_KEY=NEW \
 *        npm run key:rotate
 *   4. roll again without ENCRYPTION_KEY_PREVIOUS
 *
 * Without step 2, replicas that reload the provider registry after step 3 cannot
 * decrypt and would drop every provider from rotation.
 */
import { eq } from 'drizzle-orm';

import { closeDatabase, getDb } from '../src/database/index.js';
import { providers } from '../src/database/schema.js';
import { decrypt, encrypt } from '../src/utils/crypto.js';

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/u;

async function rotate(): Promise<void> {
  const newKeyHex = process.env['NEW_ENCRYPTION_KEY'];
  if (newKeyHex === undefined || !HEX_32_BYTES.test(newKeyHex)) {
    throw new Error('NEW_ENCRYPTION_KEY must be a 32-byte key as 64 hex chars.');
  }
  const newKey = Buffer.from(newKeyHex, 'hex');

  const db = getDb();

  let rotated = 0;
  await db.transaction(async (tx) => {
    // Read inside the transaction with row locks, so a provider created or
    // edited concurrently cannot be missed (and left under the old key).
    const rows = await tx
      .select({ id: providers.id, encryptedApiKey: providers.encryptedApiKey })
      .from(providers)
      .for('update');
    console.log(`Rotating ${rows.length} provider credential(s)…`);
    for (const row of rows) {
      // Decrypt with the CURRENT key (the module default), re-encrypt with NEW.
      const plaintext = decrypt(row.encryptedApiKey);
      const reEncrypted = encrypt(plaintext, newKey);
      await tx
        .update(providers)
        .set({ encryptedApiKey: reEncrypted, updatedAt: new Date() })
        .where(eq(providers.id, row.id));
      rotated += 1;
    }
  });

  console.log(
    `Rotated ${rotated} credential(s). Now set ENCRYPTION_KEY to the new value and redeploy.`,
  );
}

rotate()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('Key rotation failed (no changes committed):', error);
    await closeDatabase();
    process.exit(1);
  });
