/**
 * Anthropic (Claude Messages API) provider adapter.
 *
 * This is the most involved adapter because Anthropic's API diverges from
 * OpenAI's in several structural ways, each handled explicitly here:
 *   • System prompt is a top-level `system` field, not a message — so OpenAI
 *     `system` messages are extracted and concatenated.
 *   • `max_tokens` is REQUIRED — we derive it from the request, else the model's
 *     configured max output, else a safe default.
 *   • Messages must strictly alternate user/assistant — consecutive same-role
 *     turns are merged, and OpenAI `tool` messages become `tool_result` blocks
 *     inside a user turn.
 *   • Tool calls are `tool_use` content blocks (input is a JSON object, not a
 *     JSON string) — translated in both directions.
 *   • Images use `source` blocks (base64 or url) rather than `image_url`.
 *   • Streaming emits typed events (message_start, content_block_delta, …) that
 *     are normalised into OpenAI `chat.completion.chunk`s.
 */
import { z } from 'zod';

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
import { ProviderError, toErrorMessage } from '../utils/errors.js';
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

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DATA_URL_RE = /^data:(?<media>[^;]+);base64,(?<data>.+)$/u;

// ── Anthropic wire types ─────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
}

// ── Response validation ──────────────────────────────────────────────────────

const responseBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
  })
  .passthrough();

const messageResponseSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  content: z.array(responseBlockSchema),
  stop_reason: z
    .enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'])
    .nullable()
    .optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export class AnthropicProvider extends BaseProvider {
  public static readonly adapterType: AdapterType = 'anthropic';

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
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
      joinUrl(this.cfg.baseUrl, '/v1/messages'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    const parsed = messageResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError('Anthropic returned an unexpected response shape.', 502, {
        providerId: this.id,
        retryable: true,
        context: { issues: parsed.error.issues },
      });
    }
    return this.translateResponse(parsed.data, request);
  }

  public override async *chatStream(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const body = this.translateRequest(request, true);
    const response = await this.upstreamFetch(
      joinUrl(this.cfg.baseUrl, '/v1/messages'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    if (response.body === null) {
      throw new ProviderError('Anthropic returned an empty stream body.', 502, {
        providerId: this.id,
        retryable: true,
      });
    }
    yield* this.normaliseStream(response.body, request);
  }

  public override embed(
    _request: EmbeddingRequest,
    _signal: AbortSignal,
  ): Promise<EmbeddingResponse> {
    // Anthropic does not offer an embeddings endpoint. Surfacing a clear,
    // non-retryable error is safer than silently routing elsewhere.
    return Promise.reject(
      new ProviderError('Anthropic does not support the embeddings API.', 400, {
        providerId: this.id,
      }),
    );
  }

  // ── Request translation (OpenAI → Anthropic) ───────────────────────────────

  private translateRequest(request: ChatCompletionRequest, stream: boolean): AnthropicRequestBody {
    const systemParts: string[] = [];
    const messages: AnthropicMessage[] = [];

    const push = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]): void => {
      if (blocks.length === 0) {
        return;
      }
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === role) {
        last.content.push(...blocks);
      } else {
        messages.push({ role, content: blocks });
      }
    };

    for (const message of request.messages) {
      switch (message.role) {
        case 'system':
          systemParts.push(flattenText(message.content));
          break;
        case 'user':
          push('user', contentToBlocks(message.content));
          break;
        case 'assistant': {
          const blocks: AnthropicContentBlock[] = [];
          if (message.content !== null && message.content !== undefined) {
            blocks.push(...textOnlyBlocks(message.content));
          }
          for (const call of message.tool_calls ?? []) {
            blocks.push({
              type: 'tool_use',
              id: call.id,
              name: call.function.name,
              input: safeJsonParse(call.function.arguments),
            });
          }
          push('assistant', blocks);
          break;
        }
        case 'tool':
          push('user', [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: flattenText(message.content),
            },
          ]);
          break;
        default:
          // Exhaustiveness: the discriminated union has no other roles.
          break;
      }
    }

    const maxTokens =
      request.max_completion_tokens ??
      request.max_tokens ??
      this.getModel(request.model)?.maxOutputTokens ??
      DEFAULT_MAX_TOKENS;

    const body: AnthropicRequestBody = {
      model: request.model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      body.top_p = request.top_p;
    }
    if (request.stop !== undefined) {
      body.stop_sequences = typeof request.stop === 'string' ? [request.stop] : request.stop;
    }
    if (stream) {
      body.stream = true;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description !== undefined
          ? { description: tool.function.description }
          : {}),
        input_schema: tool.function.parameters ?? { type: 'object' },
      }));
      const choice = translateToolChoice(request.tool_choice);
      if (choice !== undefined) {
        body.tool_choice = choice;
      }
    }
    return body;
  }

  // ── Response translation (Anthropic → OpenAI) ──────────────────────────────

  private translateResponse(
    data: z.infer<typeof messageResponseSchema>,
    request: ChatCompletionRequest,
  ): ChatCompletionResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    const content = textParts.length > 0 ? textParts.join('') : null;
    const promptTokens = data.usage.input_tokens;
    const completionTokens = data.usage.output_tokens;
    return {
      id: createCompletionId(),
      object: 'chat.completion',
      created: nowUnixSeconds(),
      model: data.model ?? request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapStopReason(data.stop_reason ?? null, toolCalls.length > 0),
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  // ── Streaming normalisation (Anthropic events → OpenAI chunks) ──────────────

  private async *normaliseStream(
    body: ReadableStream<Uint8Array>,
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionChunk> {
    const id = createCompletionId();
    const created = nowUnixSeconds();
    const model = request.model;
    const wantUsage = request.stream_options?.include_usage === true;

    let promptTokens = 0;
    let completionTokens = 0;
    let stopReason: AnthropicStopReason = null;
    let sawToolUse = false;
    let nextToolIndex = 0;
    // Map Anthropic content-block index → OpenAI tool_call index (tool blocks only).
    const toolIndexByBlock = new Map<number, number>();
    let roleEmitted = false;

    for await (const event of parseSSEStream(body)) {
      if (event.data === '') {
        continue;
      }
      const parsed = safeJsonParse(event.data);
      if (typeof parsed !== 'object' || parsed === null) {
        continue;
      }
      const evt = parsed as Record<string, unknown>;
      const type = (typeof evt['type'] === 'string' ? evt['type'] : event.event) ?? '';

      switch (type) {
        case 'message_start': {
          promptTokens = readUsageField(evt['message'], 'input_tokens') ?? promptTokens;
          if (!roleEmitted) {
            roleEmitted = true;
            yield makeRoleChunk(id, created, model);
          }
          break;
        }
        case 'content_block_start': {
          const block = evt['content_block'];
          const index = readNumber(evt['index']) ?? 0;
          if (isRecord(block) && block['type'] === 'tool_use') {
            const toolIndex = nextToolIndex;
            nextToolIndex += 1;
            toolIndexByBlock.set(index, toolIndex);
            sawToolUse = true;
            const blockId = typeof block['id'] === 'string' ? block['id'] : undefined;
            const blockName = typeof block['name'] === 'string' ? block['name'] : undefined;
            yield makeToolCallChunk(id, created, model, {
              index: toolIndex,
              type: 'function',
              ...(blockId !== undefined ? { id: blockId } : {}),
              function: { arguments: '', ...(blockName !== undefined ? { name: blockName } : {}) },
            });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = evt['delta'];
          const index = readNumber(evt['index']) ?? 0;
          if (isRecord(delta)) {
            if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              yield makeContentChunk(id, created, model, delta['text']);
            } else if (
              delta['type'] === 'input_json_delta' &&
              typeof delta['partial_json'] === 'string'
            ) {
              const toolIndex = toolIndexByBlock.get(index) ?? 0;
              yield makeToolCallChunk(id, created, model, {
                index: toolIndex,
                function: { arguments: delta['partial_json'] },
              });
            }
          }
          break;
        }
        case 'message_delta': {
          const delta = evt['delta'];
          if (isRecord(delta) && typeof delta['stop_reason'] === 'string') {
            stopReason = delta['stop_reason'] as AnthropicStopReason;
          }
          completionTokens = readUsageField(evt['usage'], 'output_tokens') ?? completionTokens;
          break;
        }
        case 'message_stop': {
          yield makeFinishChunk(id, created, model, mapStopReason(stopReason, sawToolUse));
          if (wantUsage) {
            yield makeUsageChunk(id, created, model, {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            });
          }
          return;
        }
        default:
          // ping, content_block_stop, and unknown events carry no client payload.
          break;
      }
    }
  }
}

// ── Pure translation helpers ─────────────────────────────────────────────────

type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;

function mapStopReason(
  reason: AnthropicStopReason,
  sawToolUse: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (reason === 'max_tokens') {
    return 'length';
  }
  if (reason === 'tool_use' || sawToolUse) {
    return 'tool_calls';
  }
  return 'stop';
}

function translateToolChoice(
  choice: ChatCompletionRequest['tool_choice'],
): AnthropicRequestBody['tool_choice'] | undefined {
  if (choice === undefined || choice === 'none') {
    return undefined;
  }
  if (choice === 'auto') {
    return { type: 'auto' };
  }
  if (choice === 'required') {
    return { type: 'any' };
  }
  return { type: 'tool', name: choice.function.name };
}

/** Convert OpenAI message content (string | parts) into Anthropic blocks. */
function contentToBlocks(content: ChatMessage['content']): AnthropicContentBlock[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    blocks.push(partToBlock(part));
  }
  return blocks;
}

/** Only text parts (assistant/system content arrays cannot carry images). */
function textOnlyBlocks(content: ChatMessage['content']): AnthropicContentBlock[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    }
  }
  return blocks;
}

function partToBlock(part: ContentPart): AnthropicContentBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  const url = part.image_url.url;
  const match = DATA_URL_RE.exec(url);
  if (match?.groups !== undefined) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match.groups['media'] ?? 'image/png',
        data: match.groups['data'] ?? '',
      },
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

/** Flatten content to a plain string (system messages and tool results). */
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

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUsageField(usage: unknown, field: string): number | undefined {
  if (isRecord(usage)) {
    return readNumber(usage[field]);
  }
  return undefined;
}

// Re-export for unit tests that exercise the pure translation helpers directly.
export const __testing = {
  mapStopReason,
  translateToolChoice,
  contentToBlocks,
  flattenText,
  partToBlock,
  toErrorMessage,
};
