/**
 * Google Gemini (Generative Language API) provider adapter.
 *
 * Gemini's contract differs from OpenAI's structurally:
 *   • Turns are `contents` with roles `user`/`model` (assistant → model), and
 *     the system prompt is a top-level `systemInstruction`.
 *   • Parts carry text or `inlineData` (base64 images); generation knobs live
 *     in `generationConfig` (camelCase).
 *   • Tools are `functionDeclarations`; calls/results are `functionCall` /
 *     `functionResponse` parts. We set each emitted tool-call id to the function
 *     name so a later OpenAI `tool` message round-trips to the right
 *     functionResponse.
 *   • Auth is the `x-goog-api-key` header (NOT a URL query param) so the key
 *     never appears in a URL or log line.
 *   • Streaming uses `:streamGenerateContent?alt=sse`, whose frames are partial
 *     GenerateContentResponses normalised to OpenAI chunks.
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

const DEFAULT_MAX_TOKENS = 4096;
const DATA_URL_RE = /^data:(?<media>[^;]+);base64,(?<data>.+)$/u;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] };
  };
}

export class GeminiProvider extends BaseProvider {
  public static readonly adapterType: AdapterType = 'gemini';

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey };
  }

  public override countTokens(messages: readonly ChatMessage[], model: string): number {
    return countChatTokens(messages, model);
  }

  public override async chat(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const body = this.translateRequest(request);
    const url = joinUrl(this.cfg.baseUrl, `/v1beta/models/${request.model}:generateContent`);
    const response = await this.upstreamFetch(
      url,
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
    const body = this.translateRequest(request);
    const url = joinUrl(
      this.cfg.baseUrl,
      `/v1beta/models/${request.model}:streamGenerateContent?alt=sse`,
    );
    const response = await this.upstreamFetch(
      url,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    if (response.body === null) {
      throw new ProviderError('Gemini returned an empty stream body.', 502, {
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
    const url = joinUrl(this.cfg.baseUrl, `/v1beta/models/${request.model}:batchEmbedContents`);
    const body = {
      requests: texts.map((text) => ({
        model: `models/${request.model}`,
        content: { parts: [{ text }] },
        ...(request.dimensions !== undefined ? { outputDimensionality: request.dimensions } : {}),
      })),
    };
    const response = await this.upstreamFetch(
      url,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    await this.ensureOk(response);
    const raw = await this.readJson(response);
    return this.translateEmbedding(raw, request, texts);
  }

  // ── Request translation (OpenAI → Gemini) ──────────────────────────────────

  private translateRequest(request: ChatCompletionRequest): GeminiRequestBody {
    const contents: GeminiContent[] = [];
    const systemParts: GeminiPart[] = [];

    const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
      if (parts.length === 0) {
        return;
      }
      const last = contents[contents.length - 1];
      if (last !== undefined && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    };

    for (const message of request.messages) {
      switch (message.role) {
        case 'system':
          systemParts.push({ text: flattenText(message.content) });
          break;
        case 'user':
          push('user', contentToParts(message.content));
          break;
        case 'assistant': {
          const parts: GeminiPart[] = [];
          if (message.content !== null && message.content !== undefined) {
            for (const part of textParts(message.content)) {
              parts.push(part);
            }
          }
          for (const call of message.tool_calls ?? []) {
            parts.push({
              functionCall: {
                name: call.function.name,
                args: asRecord(safeJsonParse(call.function.arguments)),
              },
            });
          }
          push('model', parts);
          break;
        }
        case 'tool':
          push('user', [
            {
              functionResponse: {
                name: message.tool_call_id,
                response: { content: flattenText(message.content) },
              },
            },
          ]);
          break;
        default:
          break;
      }
    }

    const body: GeminiRequestBody = { contents };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }
    const generationConfig = this.buildGenerationConfig(request);
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.function.name,
            ...(tool.function.description !== undefined
              ? { description: tool.function.description }
              : {}),
            ...(tool.function.parameters !== undefined
              ? { parameters: tool.function.parameters }
              : {}),
          })),
        },
      ];
      const toolConfig = translateToolConfig(request.tool_choice);
      if (toolConfig !== undefined) {
        body.toolConfig = toolConfig;
      }
    }
    return body;
  }

  private buildGenerationConfig(
    request: ChatCompletionRequest,
  ): NonNullable<GeminiRequestBody['generationConfig']> {
    const config: NonNullable<GeminiRequestBody['generationConfig']> = {};
    if (request.temperature !== undefined) {
      config.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      config.topP = request.top_p;
    }
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    config.maxOutputTokens =
      maxTokens ?? this.getModel(request.model)?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    if (request.stop !== undefined) {
      config.stopSequences = typeof request.stop === 'string' ? [request.stop] : request.stop;
    }
    return config;
  }

  // ── Response translation (Gemini → OpenAI) ─────────────────────────────────

  private translateResponse(raw: unknown, request: ChatCompletionRequest): ChatCompletionResponse {
    if (!isRecord(raw)) {
      throw this.shapeError();
    }
    const candidates = raw['candidates'];
    const candidate = firstElement(candidates);
    const { text, toolCalls } = extractParts(
      isRecord(candidate) ? candidate['content'] : undefined,
    );
    const usage = readUsage(raw['usageMetadata']);
    const finishReason = isRecord(candidate) ? candidate['finishReason'] : undefined;

    return {
      id: createCompletionId(),
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
          finish_reason: mapFinishReason(
            typeof finishReason === 'string' ? finishReason : null,
            toolCalls.length > 0,
          ),
          logprobs: null,
        },
      ],
      usage,
    };
  }

  private translateEmbedding(
    raw: unknown,
    request: ChatCompletionRequest | EmbeddingRequest,
    texts: string[],
  ): EmbeddingResponse {
    if (!isRecord(raw) || !Array.isArray(raw['embeddings'])) {
      throw this.shapeError();
    }
    const data = raw['embeddings'].map((entry: unknown, index: number) => {
      const values = isRecord(entry) ? entry['values'] : undefined;
      return {
        object: 'embedding' as const,
        index,
        embedding: toNumberArray(values),
      };
    });
    const promptTokens = texts.reduce(
      (sum, t) => sum + this.countTokens([toUserMessage(t)], request.model),
      0,
    );
    return {
      object: 'list',
      data,
      model: request.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  }

  // ── Streaming normalisation (Gemini events → OpenAI chunks) ─────────────────

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
    let toolIndex = 0;
    let finishReason: string | null = null;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for await (const event of parseSSEStream(body)) {
      if (event.data === '') {
        continue;
      }
      const parsed = safeJsonParse(event.data);
      if (!isRecord(parsed)) {
        continue;
      }
      const u = readUsage(parsed['usageMetadata']);
      if (u.total_tokens > 0) {
        usage = u;
      }
      const candidates = parsed['candidates'];
      const candidate = firstElement(candidates);
      if (!isRecord(candidate)) {
        continue;
      }
      if (typeof candidate['finishReason'] === 'string') {
        finishReason = candidate['finishReason'];
      }
      const content = candidate['content'];
      const parts = isRecord(content) && Array.isArray(content['parts']) ? content['parts'] : [];
      for (const part of parts) {
        if (!isRecord(part)) {
          continue;
        }
        if (!roleEmitted) {
          roleEmitted = true;
          yield makeRoleChunk(id, created, model);
        }
        if (typeof part['text'] === 'string') {
          yield makeContentChunk(id, created, model, part['text']);
        } else if (isRecord(part['functionCall'])) {
          const fc = part['functionCall'];
          sawToolUse = true;
          const index = toolIndex;
          toolIndex += 1;
          const name = typeof fc['name'] === 'string' ? fc['name'] : `tool_${index}`;
          yield makeToolCallChunk(id, created, model, {
            index,
            id: name,
            type: 'function',
            function: { name, arguments: JSON.stringify(fc['args'] ?? {}) },
          });
        }
      }
    }

    if (!roleEmitted) {
      yield makeRoleChunk(id, created, model);
    }
    yield makeFinishChunk(id, created, model, mapFinishReason(finishReason, sawToolUse));
    if (wantUsage) {
      yield makeUsageChunk(id, created, model, usage);
    }
  }

  private shapeError(): ProviderError {
    return new ProviderError('Gemini returned an unexpected response shape.', 502, {
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
  if (sawToolUse) {
    return 'tool_calls';
  }
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    case null:
    default:
      return 'stop';
  }
}

/** Coerce an unknown Redis/JSON value into a number[] without an `any` cast. */
function toNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

function translateToolConfig(
  choice: ChatCompletionRequest['tool_choice'],
): GeminiRequestBody['toolConfig'] | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (choice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (choice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (choice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
}

function extractParts(content: unknown): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let text = '';
  const parts = isRecord(content) && Array.isArray(content['parts']) ? content['parts'] : [];
  let index = 0;
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (typeof part['text'] === 'string') {
      text += part['text'];
    } else if (isRecord(part['functionCall'])) {
      const fc = part['functionCall'];
      const name = typeof fc['name'] === 'string' ? fc['name'] : `tool_${index}`;
      toolCalls.push({
        id: name,
        type: 'function',
        function: { name, arguments: JSON.stringify(fc['args'] ?? {}) },
      });
      index += 1;
    }
  }
  return { text, toolCalls };
}

function readUsage(usageMetadata: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  if (!isRecord(usageMetadata)) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const prompt = readNumber(usageMetadata['promptTokenCount']) ?? 0;
  const completion = readNumber(usageMetadata['candidatesTokenCount']) ?? 0;
  const total = readNumber(usageMetadata['totalTokenCount']) ?? prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function contentToParts(content: ChatMessage['content']): GeminiPart[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return content.length > 0 ? [{ text: content }] : [];
  }
  const parts: GeminiPart[] = [];
  for (const part of content) {
    parts.push(partToGeminiPart(part));
  }
  return parts;
}

function textParts(content: ChatMessage['content']): GeminiPart[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return content.length > 0 ? [{ text: content }] : [];
  }
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    }
  }
  return parts;
}

function partToGeminiPart(part: ContentPart): GeminiPart {
  if (part.type === 'text') {
    return { text: part.text };
  }
  const match = DATA_URL_RE.exec(part.image_url.url);
  if (match?.groups !== undefined) {
    return {
      inlineData: {
        mimeType: match.groups['media'] ?? 'image/png',
        data: match.groups['data'] ?? '',
      },
    };
  }
  // Gemini inlineData requires base64; a bare URL is surfaced as text so the
  // request still succeeds (degraded, documented) rather than 400-ing.
  return { text: `[image] ${part.image_url.url}` };
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

function toUserMessage(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** First element of an unknown array as `unknown` (avoids `any` from index access). */
function firstElement(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
