import { describe, expect, it } from 'vitest';

import { SSE_DONE_FRAME, parseSSEStream, serializeSSE } from '../../../src/utils/stream.js';

/** A ReadableStream that emits the given byte chunks one per read. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i];
      if (next === undefined) {
        controller.close();
        return;
      }
      i += 1;
      controller.enqueue(next);
    },
  });
}

const enc = new TextEncoder();

async function collect(chunks: Uint8Array[]): Promise<Array<{ event?: string; data: string }>> {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const e of parseSSEStream(streamOf(chunks))) {
    out.push({ ...(e.event !== undefined ? { event: e.event } : {}), data: e.data });
  }
  return out;
}

describe('parseSSEStream', () => {
  it('reassembles an event split across arbitrary read boundaries (byte by byte)', async () => {
    const bytes = enc.encode('data: {"a":1}\n\ndata: {"b":2}\n\n');
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    expect((await collect(chunks)).map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not corrupt a multi-byte UTF-8 character split between reads', async () => {
    const bytes = enc.encode('data: héllo wörld 😀\n\n');
    // split in the middle of the emoji's 4 bytes
    const cut = bytes.length - 4;
    const events = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events[0]?.data).toBe('héllo wörld 😀');
  });

  it('handles CRLF line endings and multi-line data fields', async () => {
    const events = await collect([enc.encode('event: ping\r\ndata: line1\r\ndata: line2\r\n\r\n')]);
    expect(events).toEqual([{ event: 'ping', data: 'line1\nline2' }]);
  });

  it('ignores comment lines (keep-alives) and unknown fields', async () => {
    const events = await collect([enc.encode(': keep-alive\n\nid: 7\nretry: 100\ndata: x\n\n')]);
    expect(events.map((e) => e.data)).toEqual(['x']);
  });

  it('emits a trailing event when the stream ends without a blank line', async () => {
    expect((await collect([enc.encode('data: tail')])).map((e) => e.data)).toEqual(['tail']);
  });

  it('strips exactly one leading space after the colon', async () => {
    expect((await collect([enc.encode('data:  two spaces\n\n')]))[0]?.data).toBe(' two spaces');
    expect((await collect([enc.encode('data:nospace\n\n')]))[0]?.data).toBe('nospace');
  });

  it('passes the [DONE] sentinel through as data', async () => {
    expect((await collect([enc.encode(SSE_DONE_FRAME)])).map((e) => e.data)).toEqual(['[DONE]']);
  });
});

describe('serializeSSE', () => {
  it('frames a JSON payload as a data event', () => {
    expect(serializeSSE({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
});
