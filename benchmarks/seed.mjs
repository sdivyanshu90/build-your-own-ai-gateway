// Seeds providers, models and API keys through the gateway's own admin API.
// Requires a running gateway (see run-gateway.sh). Idempotent per database:
// run it once after a fresh `docker compose up`.
import { ADMIN_KEY, GATEWAY, MOCK_A, MOCK_B, admin, saveState } from './lib.mjs';

const mk = (name, adapterType, baseUrl, extra = {}) =>
  admin('POST', '/providers', {
    name,
    adapterType,
    baseUrl,
    apiKey: 'mock-upstream-key',
    ...extra,
  });
const model = (providerId, modelId, extra = {}) =>
  admin('POST', `/providers/${providerId}/models`, {
    modelId,
    supportsStreaming: true,
    supportsTools: true,
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    maxOutputTokens: 4096,
    ...extra,
  });

const openaiA = await mk('bench-openai-a', 'openai', `${MOCK_A}/v1`, { timeoutMs: 10000 });
const anthropicA = await mk('bench-anthropic-a', 'anthropic', MOCK_A, { timeoutMs: 10000 });
const haA = await mk('bench-ha-a', 'openai', `${MOCK_A}/v1`, { timeoutMs: 1500, priority: 1 });
const haB = await mk('bench-ha-b', 'openai', `${MOCK_B}/v1`, { timeoutMs: 1500, priority: 2 });
await model(openaiA.id, 'bench-chat');
await model(openaiA.id, 'bench-embed');
await model(anthropicA.id, 'bench-claude');
await model(haA.id, 'bench-ha');
await model(haB.id, 'bench-ha');

const key = (body) => admin('POST', '/keys', body);
const fast = await key({ name: 'bench-fast', rpmLimit: 2_000_000_000, tpmLimit: 2_000_000_000 });
const limited = await key({ name: 'bench-limited', rpmLimit: 60, tpmLimit: 2_000_000_000 });
saveState({ fastKey: fast.key, limitedKeyId: limited.id, gateway: GATEWAY, adminKey: ADMIN_KEY });
console.log('seeded: 4 providers, 5 model bindings, 2 keys');
