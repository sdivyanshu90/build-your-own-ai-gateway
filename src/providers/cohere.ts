/**
 * Cohere (Chat API v2) provider adapter.
 *
 * Cohere v2 is closer to OpenAI than Gemini/Anthropic — roles are
 * system/user/assistant/tool and tools use the OpenAI `{type:'function', …}`
 * shape — but it differs in:
 *   • `top_p` is named `p`.
 *   • Assistant content is a list of typed blocks; tool results are `tool`
 *     messages with `tool_call_id`.
 *   • `tool_choice` is the coarse `REQUIRED`/`NONE` (no per-function forcing).
 *   • Streaming uses a typed event taxonomy (content-delta, tool-call-delta,
 *     message-end) that we normalise to OpenAI chunks.
 *   • Embeddings live at `/v2/embed` and REQUIRE an `input_type`.
 */
import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ContentPart,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ToolCall,
} from '../types/openai.js';
import { type AdapterType } from '../utils/constants.js';
import { ProviderError } from '../utils/errors.js';
import {
  createCompletionId,
  makeContentChunk,
  makeFinishChunk,
  makeRoleChunk,
  makeToolCallChunk,
  makeUsageChunk,
  nowUnixSeconds,
  parseSSEStream,
} from '../utils/stream.js';
import { countChatTokens } from '../utils/tokens.js';

import { BaseProvider, joinUrl } from './base.js';

const DEFAULT_EMBED_INPUT_TYPE = 'search_document';

export class CohereProvider extends BaseProvider {
  public static readonly adapterType: AdapterType = 'cohere';

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` };
  }

  public override countTokens(messages: readonly ChatMessage[], model: string): number {
    return countChatTokens(messages, model);
  }

  public override async chat(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const body = this.translateRequest(request, false);
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/v2/chat'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    return this.translateResponse(raw, request);
  }

  public override async *chatStream(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const body = this.translateRequest(request, true);
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/v2/chat'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    if (response.body === null) {
      throw new ProviderError('Cohere returned an empty stream body.', 502, {
        providerId: this.id,
        retryable: true,
      });
    }
    yield* this.normaliseStream(response.body, request);
  }

  public override async embed(
    request: EmbeddingRequest,
    signal: AbortSignal,
  ): Promise<EmbeddingResponse> {
    const texts = embeddingInputToStrings(request.input);
    const body = {
      model: request.model,
      texts,
      input_type: DEFAULT_EMBED_INPUT_TYPE,
      embedding_types: ['float'],
    };
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/v2/embed'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    return this.translateEmbedding(raw, request, texts);
  }

  // ── Request translation (OpenAI → Cohere) ──────────────────────────────────

  private translateRequest(
    request: ChatCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = request.messages.map((message) => this.translateMessage(message));
    const body: Record<string, unknown> = { model: request.model, messages, stream };
    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }
    if (request.top_p !== undefined) {
      body['p'] = request.top_p;
    }
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    if (maxTokens !== undefined) {
      body['max_tokens'] = maxTokens;
    }
    if (request.stop !== undefined) {
      body['stop_sequences'] = typeof request.stop === 'string' ? [request.stop] : request.stop;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({ type: 'function', function: tool.function }));
      const choice = translateToolChoice(request.tool_choice);
      if (choice !== undefined) {
        body['tool_choice'] = choice;
      }
    }
    return body;
  }

  private translateMessage(message: ChatMessage): Record<string, unknown> {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: contentToCohere(message.content) };
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant' };
        const text = flattenText(message.content);
        if (text.length > 0) {
          out['content'] = [{ type: 'text', text }];
        }
        if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
          out['tool_calls'] = message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          }));
        }
        return out;
      }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: flattenText(message.content),
        };
      default:
        return { role: 'user', content: '' };
    }
  }

  // ── Response translation (Cohere → OpenAI) ─────────────────────────────────

  private translateResponse(raw: unknown, request: ChatCompletionRequest): ChatCompletionResponse {
    if (!isRecord(raw)) {
      throw this.shapeError();
    }
    const message = isRecord(raw['message']) ? raw['message'] : {};
    const text = extractText(message['content']);
    const toolCalls = extractToolCalls(message['tool_calls']);
    const usage = readUsage(raw['usage']);
    const finishReason = typeof raw['finish_reason'] === 'string' ? raw['finish_reason'] : null;

    return {
      id: typeof raw['id'] === 'string' ? raw['id'] : createCompletionId(),
      object: 'chat.completion',
      created: nowUnixSeconds(),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text.length > 0 ? text : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapFinishReason(finishReason, toolCalls.length > 0),
          logprobs: null,
        },
      ],
      usage,
    };
  }

  private translateEmbedding(
    raw: unknown,
    request: EmbeddingRequest,
    texts: string[],
  ): EmbeddingResponse {
    const floats =
      isRecord(raw) && isRecord(raw['embeddings']) ? raw['embeddings']['float'] : undefined;
    if (!Array.isArray(floats)) {
      throw this.shapeError();
    }
    const data = floats.map((vector: unknown, index: number) => ({
      object: 'embedding' as const,
      index,
      embedding: toNumberArray(vector),
    }));
    const promptTokens = texts.reduce(
      (sum, t) => sum + this.countTokens([{ role: 'user', content: t }], request.model),
      0,
    );
    return {
      object: 'list',
      data,
      model: request.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  }

  // ── Streaming normalisation (Cohere events → OpenAI chunks) ─────────────────

  private async *normaliseStream(
    body: ReadableStream<Uint8Array>,
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionChunk> {
    const id = createCompletionId();
    const created = nowUnixSeconds();
    const model = request.model;
    const wantUsage = request.stream_options?.include_usage === true;

    let roleEmitted = false;
    let sawToolUse = false;
    let finishReason: string | null = null;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const emitRole = function* (): Generator<ChatCompletionChunk> {
      if (!roleEmitted) {
        roleEmitted = true;
        yield makeRoleChunk(id, created, model);
      }
    };

    for await (const event of parseSSEStream(body)) {
      if (event.data === '' || event.data === '[DONE]') {
        continue;
      }
      const parsed = safeJsonParse(event.data);
      if (!isRecord(parsed)) {
        continue;
      }
      const type = (typeof parsed['type'] === 'string' ? parsed['type'] : event.event) ?? '';
      const delta = isRecord(parsed['delta']) ? parsed['delta'] : undefined;
      const index = readNumber(parsed['index']) ?? 0;

      switch (type) {
        case 'message-start':
          yield* emitRole();
          break;
        case 'content-delta': {
          const text = readDeltaText(delta);
          if (text !== undefined) {
            yield* emitRole();
            yield makeContentChunk(id, created, model, text);
          }
          break;
        }
        case 'tool-call-start': {
          const call = readDeltaToolCall(delta);
          if (call !== undefined) {
            sawToolUse = true;
            yield* emitRole();
            yield makeToolCallChunk(id, created, model, {
              index,
              ...(call.id !== undefined ? { id: call.id } : {}),
              type: 'function',
              function: {
                ...(call.name !== undefined ? { name: call.name } : {}),
                arguments: call.arguments ?? '',
              },
            });
          }
          break;
        }
        case 'tool-call-delta': {
          const call = readDeltaToolCall(delta);
          if (call?.arguments !== undefined) {
            yield makeToolCallChunk(id, created, model, {
              index,
              function: { arguments: call.arguments },
            });
          }
          break;
        }
        case 'message-end': {
          if (delta !== undefined && typeof delta['finish_reason'] === 'string') {
            finishReason = delta['finish_reason'];
          }
          const u = readUsage(delta?.['usage']);
          if (u.total_tokens > 0) {
            usage = u;
          }
          break;
        }
        default:
          break;
      }
    }

    yield* emitRole();
    yield makeFinishChunk(id, created, model, mapFinishReason(finishReason, sawToolUse));
    if (wantUsage) {
      yield makeUsageChunk(id, created, model, usage);
    }
  }

  private shapeError(): ProviderError {
    return new ProviderError('Cohere returned an unexpected response shape.', 502, {
      providerId: this.id,
      retryable: true,
    });
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function mapFinishReason(
  reason: string | null,
  sawToolUse: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (sawToolUse || reason === 'TOOL_CALL') {
    return 'tool_calls';
  }
  switch (reason) {
    case null:
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'ERROR_TOXIC':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function translateToolChoice(choice: ChatCompletionRequest['tool_choice']): string | undefined {
  if (choice === undefined || choice === 'auto') {
    return undefined; // Cohere defaults to auto tool selection.
  }
  if (choice === 'none') {
    return 'NONE';
  }
  // 'required' or a specific function → REQUIRED (Cohere cannot force a name).
  return 'REQUIRED';
}

function contentToCohere(content: ChatMessage['content']): unknown {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part: ContentPart) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: part.image_url.url } },
  );
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  let out = '';
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      out += block['text'];
    }
  }
  return out;
}

function extractToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const out: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call) || !isRecord(call['function'])) {
      continue;
    }
    const fn = call['function'];
    const name = typeof fn['name'] === 'string' ? fn['name'] : '';
    const args = fn['arguments'];
    out.push({
      id: typeof call['id'] === 'string' ? call['id'] : createCompletionId(),
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
    });
  }
  return out;
}

function readUsage(usage: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const tokens = isRecord(usage) && isRecord(usage['tokens']) ? usage['tokens'] : undefined;
  const input = readNumber(tokens?.['input_tokens']) ?? 0;
  const output = readNumber(tokens?.['output_tokens']) ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function readDeltaText(delta: Record<string, unknown> | undefined): string | undefined {
  const message = delta !== undefined && isRecord(delta['message']) ? delta['message'] : undefined;
  const content =
    message !== undefined && isRecord(message['content']) ? message['content'] : undefined;
  return content !== undefined && typeof content['text'] === 'string' ? content['text'] : undefined;
}

function readDeltaToolCall(
  delta: Record<string, unknown> | undefined,
): { id?: string; name?: string; arguments?: string } | undefined {
  const message = delta !== undefined && isRecord(delta['message']) ? delta['message'] : undefined;
  const toolCalls = message !== undefined ? message['tool_calls'] : undefined;
  const call = isRecord(toolCalls) ? toolCalls : firstElement(toolCalls);
  if (!isRecord(call)) {
    return undefined;
  }
  const fn = isRecord(call['function']) ? call['function'] : undefined;
  const result: { id?: string; name?: string; arguments?: string } = {};
  if (typeof call['id'] === 'string') {
    result.id = call['id'];
  }
  if (fn !== undefined && typeof fn['name'] === 'string') {
    result.name = fn['name'];
  }
  if (fn !== undefined && typeof fn['arguments'] === 'string') {
    result.arguments = fn['arguments'];
  }
  return result;
}

function embeddingInputToStrings(input: EmbeddingRequest['input']): string[] {
  if (typeof input === 'string') {
    return [input];
  }
  const out: string[] = [];
  for (const item of input) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (typeof item === 'number') {
      out.push(String(item));
    } else {
      out.push(item.join(' '));
    }
  }
  return out;
}

function flattenText(content: ChatMessage['content']): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  let out = '';
  for (const part of content) {
    if (part.type === 'text') {
      out += part.text;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Coerce an unknown value into a number[] without an `any` cast. */
function toNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

/** First element of an unknown array as `unknown` (avoids `any` from index access). */
function firstElement(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
