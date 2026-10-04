import { EventEmitter } from 'node:events';

import { type FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { clientAbortSignal } from '../../../src/routes/http.js';

function fakeReply(raw: { destroyed: boolean; writableFinished: boolean }): FastifyReply {
  return { raw: Object.assign(new EventEmitter(), raw) } as unknown as FastifyReply;
}

describe('clientAbortSignal', () => {
  it('aborts when the client disconnects later', () => {
    const reply = fakeReply({ destroyed: false, writableFinished: false });
    const signal = clientAbortSignal(reply);
    expect(signal.aborted).toBe(false);
    (reply.raw as unknown as EventEmitter).emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('is already aborted if the client disconnected before the signal was created (regression)', () => {
    const signal = clientAbortSignal(fakeReply({ destroyed: true, writableFinished: false }));
    expect(signal.aborted).toBe(true);
  });

  it('does not abort after a normally finished response', () => {
    const reply = fakeReply({ destroyed: false, writableFinished: true });
    const signal = clientAbortSignal(reply);
    (reply.raw as unknown as EventEmitter).emit('close');
    expect(signal.aborted).toBe(false);
  });
});
