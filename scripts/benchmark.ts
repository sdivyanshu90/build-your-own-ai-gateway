/**
 * Internal microbenchmarks for the two hottest pure computations: the semantic
 * cache key derivation and the load-balancer candidate-set fingerprint. These
 * run on the request hot path, so a regression here scales across every request.
 *
 * Requires ENCRYPTION_KEY and ADMIN_API_KEY in the environment (the imported
 * modules validate config at load). Run: npm run benchmark
 */
import { canonicalStringify } from '../src/cache/index.js';
import { candidateSetKey } from '../src/loadbalancer/shared.js';
import { type BaseProvider } from '../src/providers/base.js';
import { type ChatCompletionRequest } from '../src/types/openai.js';
import { sha256Hex } from '../src/utils/crypto.js';

function bench(name: string, fn: () => unknown, iterations: number): void {
  // Warm up the JIT before timing.
  for (let i = 0; i < Math.min(iterations, 10_000); i += 1) {
    fn();
  }
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const opsPerSec = (iterations / elapsedNs) * 1e9;
  const nsPerOp = elapsedNs / iterations;
  console.log(
    `${name.padEnd(26)} ${opsPerSec.toFixed(0).padStart(12)} ops/s   ${nsPerOp.toFixed(1).padStart(9)} ns/op`,
  );
}

const sampleRequest: ChatCompletionRequest = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Summarise the theory of relativity in three sentences.' },
  ],
  temperature: 0,
  top_p: 1,
  max_tokens: 512,
  seed: 42,
};

// Five minimal provider stand-ins; candidateSetKey only reads `.id`.
const candidates = Array.from({ length: 5 }, (_unused, i) => ({
  id: `provider-${i}`,
})) as unknown as BaseProvider[];

console.log('AI gateway microbenchmarks\n');
bench('cache key derivation', () => sha256Hex(canonicalStringify(sampleRequest)), 200_000);
bench('LB candidate-set key', () => candidateSetKey(candidates), 500_000);
console.log('\nDone.');
