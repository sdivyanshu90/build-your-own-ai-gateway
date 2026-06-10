/**
 * Seed development data: one OpenAI-style provider with a few models, and a
 * sample API key. Idempotent — safe to run repeatedly. The raw API key is
 * printed once (it is never recoverable afterwards).
 *
 * Run: npm run db:seed  (after migrations)
 */
import { eq } from 'drizzle-orm';

import { closeDatabase, getDb } from '../src/database/index.js';
import { apiKeys, providerModels, providers } from '../src/database/schema.js';
import { encrypt, generateApiKey } from '../src/utils/crypto.js';

interface SeedModel {
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1k: string;
  outputPricePer1k: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}

const OPENAI_MODELS: SeedModel[] = [
  {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPricePer1k: '0.002500',
    outputPricePer1k: '0.010000',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPricePer1k: '0.000150',
    outputPricePer1k: '0.000600',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
  {
    modelId: 'text-embedding-3-small',
    displayName: 'Text Embedding 3 Small',
    contextWindow: 8_191,
    maxOutputTokens: 0,
    inputPricePer1k: '0.000020',
    outputPricePer1k: '0.000000',
    supportsStreaming: false,
    supportsTools: false,
    supportsVision: false,
  },
];

async function seed(): Promise<void> {
  const db = getDb();
  const upstreamKey = process.env['OPENAI_API_KEY'] ?? 'sk-dev-placeholder-key';

  // Provider (idempotent upsert keyed by unique name).
  const [provider] = await db
    .insert(providers)
    .values({
      name: 'openai-primary',
      baseUrl: 'https://api.openai.com/v1',
      adapterType: 'openai',
      encryptedApiKey: encrypt(upstreamKey),
      weight: 10,
      priority: 1,
      healthCheckUrl: 'https://api.openai.com/v1/models',
    })
    .onConflictDoUpdate({
      target: providers.name,
      set: { baseUrl: 'https://api.openai.com/v1', updatedAt: new Date() },
    })
    .returning();

  if (provider === undefined) {
    throw new Error('Failed to upsert provider.');
  }

  for (const model of OPENAI_MODELS) {
    await db
      .insert(providerModels)
      .values({ providerId: provider.id, ...model })
      .onConflictDoNothing({ target: [providerModels.providerId, providerModels.modelId] });
  }
  console.log(
    `Seeded provider "openai-primary" (${provider.id}) with ${OPENAI_MODELS.length} models.`,
  );

  // Sample API key (only created once; the raw value is printed here only).
  const existing = await db.query.apiKeys.findFirst({ where: eq(apiKeys.name, 'dev-key') });
  if (existing === undefined) {
    const { raw, hash } = generateApiKey();
    await db.insert(apiKeys).values({
      keyHash: hash,
      name: 'dev-key',
      rpmLimit: 600,
      tpmLimit: 1_000_000,
      monthlyBudgetUsd: '100.0000',
    });
    console.log('\nCreated dev API key (store it now — it will not be shown again):');
    console.log(`  ${raw}\n`);
  } else {
    console.log('Dev API key already exists; not recreating.');
  }
}

seed()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('Seed failed:', error);
    await closeDatabase();
    process.exit(1);
  });
