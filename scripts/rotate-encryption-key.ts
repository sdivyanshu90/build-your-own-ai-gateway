/**
 * Rotate the master encryption key.
 *
 * Re-encrypts every provider credential from the CURRENT key (ENCRYPTION_KEY) to
 * a NEW key (NEW_ENCRYPTION_KEY). The whole re-encryption runs in a single
 * transaction, so the table is never left half-rotated. After this completes
 * successfully, update ENCRYPTION_KEY to the new value and redeploy.
 *
 * Generate a new key first:  openssl rand -hex 32
 * Run:  ENCRYPTION_KEY=<old> NEW_ENCRYPTION_KEY=<new> npm run key:rotate
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
  const rows = await db
    .select({ id: providers.id, encryptedApiKey: providers.encryptedApiKey })
    .from(providers);
  console.log(`Rotating ${rows.length} provider credential(s)…`);

  let rotated = 0;
  await db.transaction(async (tx) => {
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
