/**
 * OpenAI provider adapter.
 *
 * The gateway's public contract IS the OpenAI API, so this adapter is the
 * reference implementation: requests pass through largely untouched, but the
 * adapter still (a) enforces the per-provider timeout and auth header, (b)
 * validates the upstream response against a schema before trusting it — the spec
 * requires validating external inputs — and (c) backfills `usage` with tiktoken
 * if the provider omits it. Many "OpenAI-compatible" providers (Azure OpenAI,
 * local vLLM, Together, etc.) can reuse this adapter by pointing `base_url`
 * elsewhere, which is why it is intentionally generic.
 */
import { z } from 'zod';

import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from '../types/openai.js';
import { type AdapterType } from '../utils/constants.js';
import { ProviderError } from '../utils/errors.js';
import { createCompletionId, nowUnixSeconds, parseSSEStream } from '../utils/stream.js';
import { countChatTokens } from '../utils/tokens.js';

import { BaseProvider, joinUrl } from './base.js';

// ── Minimal upstream response schemas (defensive validation) ─────────────────

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const chatResponseSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        message: z.object({
          role: z.literal('assistant').optional(),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
        finish_reason: z
          .enum(['stop', 'length', 'tool_calls', 'content_filter'])
          .nullable()
          .optional(),
      }),
    )
    .min(1),
  usage: usageSchema.optional(),
  system_fingerprint: z.string().optional(),
});

const embeddingResponseSchema = z.object({
  object: z.literal('list').optional(),
  data: z
    .array(
      z.object({
        object: z.literal('embedding').optional(),
        index: z.number().int(),
        embedding: z.union([z.array(z.number()), z.string()]),
      }),
    )
    .min(1),
  model: z.string().optional(),
  usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }).optional(),
});

export class OpenAIProvider extends BaseProvider {
  public static readonly adapterType: AdapterType = 'openai';

  /**
   * Auth header for the provider. Protected so OpenAI-compatible subclasses
   * (e.g. Mistral) can reuse or adjust it.
   */
  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  /**
   * Build the chat request body sent upstream. Protected so OpenAI-compatible
   * subclasses can remap fields (e.g. Mistral's `seed` → `random_seed`).
   */
  protected buildChatBody(
    request: ChatCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    if (!stream) {
      return { ...request, stream: false };
    }
    const wantUsage = request.stream_options?.include_usage === true;
    return {
      ...request,
      stream: true,
      ...(wantUsage ? { stream_options: { include_usage: true } } : {}),
    };
  }

  /** Build the embedding request body sent upstream. Protected for subclasses. */
  protected buildEmbeddingBody(request: EmbeddingRequest): Record<string, unknown> {
    return { ...request };
  }

  public override countTokens(messages: readonly ChatMessage[], model: string): number {
    return countChatTokens(messages, model);
  }

  public override async chat(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildChatBody(request, false)),
      },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    const parsed = chatResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError('OpenAI returned an unexpected chat response shape.', 502, {
        providerId: this.id,
        retryable: true,
        context: { issues: parsed.error.issues },
      });
    }
    return this.normaliseChatResponse(parsed.data, request);
  }

  public override async *chatStream(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildChatBody(request, true)),
      },
      signal,
    );
    await this.ensureOk(response);
    if (response.body === null) {
      throw new ProviderError('OpenAI returned an empty stream body.', 502, {
        providerId: this.id,
        retryable: true,
      });
    }
    for await (const event of parseSSEStream(response.body)) {
      const data = event.data;
      if (data === '' || data === '[DONE]') {
        if (data === '[DONE]') {
          return;
        }
        continue;
      }
      // Upstream chunks are already OpenAI-shaped; parse to fail fast on garbage.
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        // Skip an unparseable keep-alive / comment frame rather than aborting.
        continue;
      }
      yield chunk as ChatCompletionChunk;
    }
  }

  public override async embed(
    request: EmbeddingRequest,
    signal: AbortSignal,
  ): Promise<EmbeddingResponse> {
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/embeddings'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildEmbeddingBody(request)),
      },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    const parsed = embeddingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError('OpenAI returned an unexpected embedding response shape.', 502, {
        providerId: this.id,
        retryable: true,
        context: { issues: parsed.error.issues },
      });
    }
    const promptTokens = parsed.data.usage?.prompt_tokens ?? 0;
    return {
      object: 'list',
      data: parsed.data.data.map((item) => ({
        object: 'embedding',
        index: item.index,
        embedding: item.embedding,
      })),
      model: parsed.data.model ?? request.model,
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: parsed.data.usage?.total_tokens ?? promptTokens,
      },
    };
  }

  /** Backfill id/created/usage and pin object type so the client sees clean data. */
  private normaliseChatResponse(
    data: z.infer<typeof chatResponseSchema>,
    request: ChatCompletionRequest,
  ): ChatCompletionResponse {
    const promptTokens =
      data.usage?.prompt_tokens ?? this.countTokens(request.messages, request.model);
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const response: ChatCompletionResponse = {
      id: data.id ?? createCompletionId(),
      object: 'chat.completion',
      created: data.created ?? nowUnixSeconds(),
      model: data.model ?? request.model,
      choices: data.choices.map((choice, index) => ({
        index: choice.index ?? index,
        message: {
          role: 'assistant',
          content: choice.message.content ?? null,
          ...(choice.message.tool_calls !== undefined
            ? { tool_calls: choice.message.tool_calls }
            : {}),
        },
        finish_reason: choice.finish_reason ?? 'stop',
        logprobs: null,
      })),
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
      },
    };
    return data.system_fingerprint !== undefined
      ? { ...response, system_fingerprint: data.system_fingerprint }
      : response;
  }
}
