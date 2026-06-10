/**
 * Token counting.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Exact counts for OpenAI-family models via tiktoken (the same BPE encoders
 *     OpenAI uses). gpt-4o / o1 / o3 use o200k_base; gpt-4 / gpt-3.5 / the
 *     text-embedding-3 family use cl100k_base.
 *   • Encoders are WASM objects that must not be re-created per request, so they
 *     are cached for the process lifetime (and never freed — they live as long
 *     as the process).
 *   • For non-OpenAI providers we cannot run their proprietary tokenizers, so we
 *     approximate with a calibrated chars-per-token heuristic plus the same
 *     per-message structural overhead OpenAI documents. This stays within ~10%
 *     of actual for typical English/code prompts, which is sufficient for
 *     pre-flight TPM rate limiting and cost estimation (the authoritative count
 *     always comes back in the provider's `usage` field for billing).
 *   • Chat token accounting follows OpenAI's documented formula:
 *     every message costs a fixed structural overhead, the reply is primed with
 *     a few tokens, and named messages cost one extra.
 */
import { get_encoding, type Tiktoken, type TiktokenEncoding } from 'tiktoken';

import { type ChatMessage } from '../types/openai.js';

/** Per-message and reply structural overheads, per OpenAI's cookbook formula. */
const TOKENS_PER_MESSAGE = 3;
const TOKENS_PER_NAME = 1;
const TOKENS_REPLY_PRIMER = 3;
/** Flat approximation for an image content part at low detail (OpenAI base cost). */
const IMAGE_TOKEN_COST = 85;
/** Calibrated average characters per token for the heuristic counter. */
const CHARS_PER_TOKEN = 4;

const encoderCache = new Map<TiktokenEncoding, Tiktoken>();

/** Lazily construct and cache a tiktoken encoder by encoding name. */
function getEncoder(encoding: TiktokenEncoding): Tiktoken {
  const cached = encoderCache.get(encoding);
  if (cached !== undefined) {
    return cached;
  }
  const encoder = get_encoding(encoding);
  encoderCache.set(encoding, encoder);
  return encoder;
}

/** Map an OpenAI model id to its tiktoken encoding. */
function encodingForModel(model: string): TiktokenEncoding {
  const id = model.toLowerCase();
  if (
    id.startsWith('gpt-4o') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.includes('o200k')
  ) {
    return 'o200k_base';
  }
  // gpt-4, gpt-3.5-turbo, text-embedding-3-* and unknown models fall back to
  // cl100k_base, the most broadly-correct modern encoding.
  return 'cl100k_base';
}

/** True when the model belongs to the OpenAI family and tiktoken is exact. */
export function isOpenAITokenizable(model: string): boolean {
  const id = model.toLowerCase();
  return (
    id.startsWith('gpt-') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.startsWith('text-embedding-3') ||
    id.startsWith('text-embedding-ada')
  );
}

/** Exact tiktoken count for a single string under the given model's encoding. */
export function countTextTokens(text: string, model: string): number {
  const encoder = getEncoder(encodingForModel(model));
  return encoder.encode(text).length;
}

/** Heuristic count for a single string (used for non-OpenAI providers). */
export function approximateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Internal: count a chat-message array using a supplied per-string counter so
 * exact (tiktoken) and approximate (heuristic) paths share one structure-aware
 * implementation and never drift.
 */
function countChat(messages: readonly ChatMessage[], count: (text: string) => number): number {
  let total = 0;
  for (const message of messages) {
    total += TOKENS_PER_MESSAGE;
    total += count(message.role);
    total += countContent(message.content, count);
    if ('name' in message && typeof message.name === 'string') {
      total += TOKENS_PER_NAME + count(message.name);
    }
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      for (const call of message.tool_calls) {
        total += count(call.function.name) + count(call.function.arguments);
      }
    }
    if (message.role === 'tool') {
      total += count(message.tool_call_id);
    }
  }
  return total + TOKENS_REPLY_PRIMER;
}

/** Count tokens in message content (string, typed parts, or null/undefined). */
function countContent(content: ChatMessage['content'], count: (text: string) => number): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === 'string') {
    return count(content);
  }
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') {
      total += count(part.text);
    } else {
      total += IMAGE_TOKEN_COST;
    }
  }
  return total;
}

/**
 * Count prompt tokens for a chat request. Uses tiktoken when the model is an
 * OpenAI-family model and the heuristic otherwise. This is the function provider
 * adapters delegate to from their `countTokens` implementation.
 */
export function countChatTokens(messages: readonly ChatMessage[], model: string): number {
  if (isOpenAITokenizable(model)) {
    const encoder = getEncoder(encodingForModel(model));
    return countChat(messages, (text) => encoder.encode(text).length);
  }
  return countChat(messages, approximateTextTokens);
}

/** Count tokens for embedding input(s). Accepts the OpenAI `input` union. */
export function countEmbeddingTokens(
  input: string | readonly string[] | readonly number[] | readonly (readonly number[])[],
  model: string,
): number {
  const exact = isOpenAITokenizable(model);
  const countOne = (text: string): number =>
    exact ? countTextTokens(text, model) : approximateTextTokens(text);
  if (typeof input === 'string') {
    return countOne(input);
  }
  let total = 0;
  for (const item of input) {
    if (typeof item === 'string') {
      total += countOne(item);
    } else if (typeof item === 'number') {
      // Pre-tokenized integer input: one token each.
      total += 1;
    } else {
      total += item.length;
    }
  }
  return total;
}
