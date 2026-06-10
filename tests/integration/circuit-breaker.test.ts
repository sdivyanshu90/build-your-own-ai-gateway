import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../../src/circuit-breaker/index.js';
import { getRedis } from '../../src/database/redis.js';

const breaker = new CircuitBreaker(getRedis(), {
  failureThreshold: 3,
  successThreshold: 2,
  timeoutMs: 1_000,
  windowMs: 60_000,
  halfOpenMaxProbes: 1,
});

let providerId: string;

beforeEach(() => {
  providerId = `prov-${randomUUID()}`;
});

describe('distributed circuit breaker (real Redis)', () => {
  it('starts CLOSED and allows requests', async () => {
    const decision = await breaker.acquire(providerId);
    expect(decision.state).toBe('CLOSED');
    expect(decision.allowed).toBe(true);
  });

  it('stays CLOSED below the failure threshold', async () => {
    await breaker.recordFailure(providerId);
    await breaker.recordFailure(providerId);
    expect((await breaker.acquire(providerId)).state).toBe('CLOSED');
  });

  it('transitions CLOSED → OPEN at the threshold and rejects', async () => {
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId);
    }
    const decision = await breaker.acquire(providerId);
    expect(decision.state).toBe('OPEN');
    expect(decision.allowed).toBe(false);
  });

  it('transitions OPEN → HALF_OPEN after the timeout and admits one probe', async () => {
    const openedAt = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId, openedAt);
    }
    // Before timeout: still OPEN.
    expect((await breaker.acquire(providerId, openedAt + 500)).allowed).toBe(false);
    // After timeout: one probe admitted in HALF_OPEN.
    const probe = await breaker.acquire(providerId, openedAt + 1_001);
    expect(probe.state).toBe('HALF_OPEN');
    expect(probe.allowed).toBe(true);
    // Second concurrent probe is blocked (halfOpenMaxProbes = 1).
    expect((await breaker.acquire(providerId, openedAt + 1_002)).allowed).toBe(false);
  });

  it('HALF_OPEN → CLOSED after successThreshold successes', async () => {
    const openedAt = 2_000_000;
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId, openedAt);
    }
    await breaker.acquire(providerId, openedAt + 1_001); // enter HALF_OPEN, probe 1
    expect(await breaker.recordSuccess(providerId)).toBe('HALF_OPEN'); // 1st success
    await breaker.acquire(providerId, openedAt + 1_100); // probe 2
    expect(await breaker.recordSuccess(providerId)).toBe('CLOSED'); // 2nd success closes
    expect((await breaker.acquire(providerId, openedAt + 1_200)).state).toBe('CLOSED');
  });

  it('HALF_OPEN → OPEN on any probe failure', async () => {
    const openedAt = 3_000_000;
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId, openedAt);
    }
    await breaker.acquire(providerId, openedAt + 1_001); // HALF_OPEN
    expect(await breaker.recordFailure(providerId, openedAt + 1_002)).toBe('OPEN');
  });

  it('manual reset returns to CLOSED', async () => {
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId);
    }
    await breaker.reset(providerId);
    const decision = await breaker.acquire(providerId);
    expect(decision.state).toBe('CLOSED');
    expect(decision.allowed).toBe(true);
  });

  it('getAllStates includes a tripped provider', async () => {
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordFailure(providerId);
    }
    const states = await breaker.getAllStates();
    expect(states.some((s) => s.providerId === providerId && s.state === 'OPEN')).toBe(true);
  });

  it('a single success in CLOSED resets the consecutive-failure counter', async () => {
    await breaker.recordFailure(providerId);
    await breaker.recordFailure(providerId);
    await breaker.recordSuccess(providerId); // resets the counter
    await breaker.recordFailure(providerId);
    await breaker.recordFailure(providerId);
    // Only 2 consecutive failures since the reset → still CLOSED.
    expect((await breaker.acquire(providerId)).state).toBe('CLOSED');
  });
});
