/**
 * Server-Sent Events (SSE) transport and OpenAI chunk construction.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Streaming responses are NEVER buffered. We parse the upstream byte stream
 *     incrementally and re-emit normalised OpenAI chunks as they arrive, so
 *     memory stays flat regardless of response length and time-to-first-token
 *     is preserved.
 *   • This module owns the transport (byte-stream → SSE events) and the
 *     construction of OpenAI `chat.completion.chunk` objects. Each provider's
 *     native-event → OpenAI-chunk mapping lives in that provider's adapter, next
 *     to its request translation, rather than here — that keeps provider
 *     knowledge in one place per provider and avoids a utils→providers cycle.
 *   • The SSE parser correctly reassembles events that span multiple network
 *     reads (the classic partial-chunk bug) and supports multi-line `data:`
 *     fields per the SSE spec.
 */
import { randomUUID } from 'node:crypto';

import {
  type ChatCompletionChunk,
  type CompletionUsage,
  type ToolCallDelta,
} from '../types/openai.js';

import { SSE } from './constants.js';

/** A parsed SSE event: its optional `event:` name and concatenated `data:` payload. */
export interface SSEEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Parse a web ReadableStream of bytes into SSE events. Handles events split
 * across reads and multi-line data fields. Yields one {@link SSEEvent} per
 * blank-line-delimited record.
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (): SSEEvent | undefined => {
    if (dataLines.length === 0 && eventName === undefined) {
      return undefined;
    }
    const event: SSEEvent = { event: eventName, data: dataLines.join('\n') };
    dataLines = [];
    eventName = undefined;
    return event;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stripTrailingCR(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (line === '') {
          const event = flush();
          if (event !== undefined) {
            yield event;
          }
        } else if (!line.startsWith(':')) {
          const { field, value: fieldValue } = parseField(line);
          if (field === 'data') {
            dataLines.push(fieldValue);
          } else if (field === 'event') {
            eventName = fieldValue;
          }
          // `id` and `retry` fields are intentionally ignored by the gateway.
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // Emit any trailing event the stream ended without a blank line after.
    const tail = flush();
    if (tail !== undefined) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Convenience: iterate the `data:` payloads of an SSE response body. */
export async function* iterateSSEData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const event of parseSSEStream(body)) {
    yield event.data;
  }
}

function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseField(line: string): { field: string; value: string } {
  const colon = line.indexOf(':');
  if (colon === -1) {
    return { field: line, value: '' };
  }
  const field = line.slice(0, colon);
  // Per the SSE spec, a single leading space after the colon is stripped.
  let value = line.slice(colon + 1);
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }
  return { field, value };
}

// ── OpenAI chunk construction ────────────────────────────────────────────────

/** Generate an OpenAI-style completion id (`chatcmpl-<uuid>`). */
export function createCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, '')}`;
}

/** Current unix time in seconds, the OpenAI `created` convention. */
export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A chunk that opens the assistant message (role delta, no content yet). */
export function makeRoleChunk(id: string, created: number, model: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
  };
}

/** A chunk carrying a content delta. */
export function makeContentChunk(
  id: string,
  created: number,
  model: string,
  content: string,
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null, logprobs: null }],
  };
}

/** A chunk carrying a tool-call delta. */
export function makeToolCallChunk(
  id: string,
  created: number,
  model: string,
  toolCall: ToolCallDelta,
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null, logprobs: null }],
  };
}

/** A terminal chunk carrying the finish reason. */
export function makeFinishChunk(
  id: string,
  created: number,
  model: string,
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
  };
}

/** A usage-only chunk (empty choices), emitted when include_usage is requested. */
export function makeUsageChunk(
  id: string,
  created: number,
  model: string,
  usage: CompletionUsage,
): ChatCompletionChunk {
  return { id, object: 'chat.completion.chunk', created, model, choices: [], usage };
}

// ── SSE serialisation (gateway → client) ─────────────────────────────────────

/** Serialise an object as a single SSE `data:` frame. */
export function serializeSSE(payload: unknown): string {
  return `${SSE.DATA_PREFIX}${JSON.stringify(payload)}${SSE.EVENT_DELIMITER}`;
}

/** The terminal sentinel frame an OpenAI stream ends with. */
export const SSE_DONE_FRAME = `${SSE.DATA_PREFIX}${SSE.DONE}${SSE.EVENT_DELIMITER}`;
