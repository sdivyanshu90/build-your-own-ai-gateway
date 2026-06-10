/**
 * Drizzle ORM schema.
 *
 * ARCHITECTURAL DECISIONS:
 *   • This file is the type-safe surface the application queries through. The
 *     authoritative DDL — partitions, triggers, partial indexes, the materialised
 *     view — lives in hand-written migrations (src/database/migrations/*.sql)
 *     because those features cannot be expressed in the ORM schema. The column
 *     shapes here mirror that DDL exactly so queries are fully typed.
 *   • `request_logs` is RANGE-partitioned by `created_at` at the database level.
 *     A partitioned parent table requires the partition key in its primary key,
 *     so its PK is the composite (id, created_at). Drizzle reflects that here.
 *   • `adapter_type` is a Postgres enum. Migration 0001 creates it with four
 *     values; 0002 demonstrates the additive pattern by appending `cohere`.
 *     This enum lists the final state after both migrations have run.
 *   • numeric/decimal columns surface as strings in pg (to avoid float rounding
 *     on currency); the cost tracker parses them with fixed-precision math.
 */
import { relations, type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Provider adapter implementations. See migration 0002 for the `cohere` add. */
export const adapterTypeEnum = pgEnum('adapter_type', [
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'cohere',
]);

// ── api_keys ─────────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** SHA-256 hex hash of the raw key — the raw key is NEVER stored. */
    keyHash: text('key_hash').notNull().unique(),
    name: text('name'),
    ownerId: uuid('owner_id'),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Monthly spend cap in USD; null means uncapped. */
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 10, scale: 4 }),
    /** Allow-list of model ids; null/empty means all models are permitted. */
    allowedModels: text('allowed_models').array(),
    rpmLimit: integer('rpm_limit').notNull().default(60),
    tpmLimit: integer('tpm_limit').notNull().default(100_000),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial index: the auth hot path only ever looks up active keys.
    activeKeyHashIdx: index('api_keys_active_key_hash_idx')
      .on(table.keyHash)
      .where(sql`${table.isActive} = true`),
    ownerIdx: index('api_keys_owner_idx').on(table.ownerId),
  }),
);

// ── providers ────────────────────────────────────────────────────────────────

export const providers = pgTable(
  'providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull().unique(),
    baseUrl: text('base_url').notNull(),
    adapterType: adapterTypeEnum('adapter_type').notNull(),
    /** AES-256-GCM envelope ciphertext of the upstream provider credential. */
    encryptedApiKey: text('encrypted_api_key').notNull(),
    weight: integer('weight').notNull().default(1),
    priority: integer('priority').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    healthCheckUrl: text('health_check_url'),
    timeoutMs: integer('timeout_ms').notNull().default(60_000),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeIdx: index('providers_active_idx')
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
    priorityIdx: index('providers_priority_idx').on(table.priority),
  }),
);

// ── provider_models ──────────────────────────────────────────────────────────

export const providerModels = pgTable(
  'provider_models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    inputPricePer1k: numeric('input_price_per_1k', { precision: 10, scale: 6 }),
    outputPricePer1k: numeric('output_price_per_1k', { precision: 10, scale: 6 }),
    supportsStreaming: boolean('supports_streaming').notNull().default(true),
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsVision: boolean('supports_vision').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerIdx: index('provider_models_provider_idx').on(table.providerId),
    // Hot path: resolve "which active providers serve model X".
    modelActiveIdx: index('provider_models_model_active_idx')
      .on(table.modelId)
      .where(sql`${table.isActive} = true`),
  }),
);

// ── provider_health ──────────────────────────────────────────────────────────

export const providerHealth = pgTable('provider_health', {
  providerId: uuid('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('unknown'),
  latencyMs: integer('latency_ms'),
  errorMessage: text('error_message'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── request_logs (RANGE-partitioned by created_at) ───────────────────────────

export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').notNull().defaultRandom(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    modelId: text('model_id'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    failoverCount: integer('failover_count').notNull().default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partitioned tables require the partition key in the primary key.
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
    apiKeyCreatedIdx: index('request_logs_api_key_created_idx').on(table.apiKeyId, table.createdAt),
    providerCreatedIdx: index('request_logs_provider_created_idx').on(
      table.providerId,
      table.createdAt,
    ),
  }),
);

// ── Relations ────────────────────────────────────────────────────────────────

export const providersRelations = relations(providers, ({ many, one }) => ({
  models: many(providerModels),
  health: one(providerHealth, {
    fields: [providers.id],
    references: [providerHealth.providerId],
  }),
  requestLogs: many(requestLogs),
}));

export const providerModelsRelations = relations(providerModels, ({ one }) => ({
  provider: one(providers, {
    fields: [providerModels.providerId],
    references: [providers.id],
  }),
}));

export const providerHealthRelations = relations(providerHealth, ({ one }) => ({
  provider: one(providers, {
    fields: [providerHealth.providerId],
    references: [providers.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ many }) => ({
  requestLogs: many(requestLogs),
}));

export const requestLogsRelations = relations(requestLogs, ({ one }) => ({
  apiKey: one(apiKeys, { fields: [requestLogs.apiKeyId], references: [apiKeys.id] }),
  provider: one(providers, { fields: [requestLogs.providerId], references: [providers.id] }),
}));

// ── Inferred row types ───────────────────────────────────────────────────────

export type ApiKeyRow = InferSelectModel<typeof apiKeys>;
export type NewApiKeyRow = InferInsertModel<typeof apiKeys>;
export type ProviderRow = InferSelectModel<typeof providers>;
export type NewProviderRow = InferInsertModel<typeof providers>;
export type ProviderModelRow = InferSelectModel<typeof providerModels>;
export type NewProviderModelRow = InferInsertModel<typeof providerModels>;
export type ProviderHealthRow = InferSelectModel<typeof providerHealth>;
export type NewProviderHealthRow = InferInsertModel<typeof providerHealth>;
export type RequestLogRow = InferSelectModel<typeof requestLogs>;
export type NewRequestLogRow = InferInsertModel<typeof requestLogs>;

/** Convenience aggregate used by the Drizzle client for relational queries. */
export const schema = {
  adapterTypeEnum,
  apiKeys,
  providers,
  providerModels,
  providerHealth,
  requestLogs,
  providersRelations,
  providerModelsRelations,
  providerHealthRelations,
  apiKeysRelations,
  requestLogsRelations,
};
