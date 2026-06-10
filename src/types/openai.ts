/**
 * OpenAI-compatible wire protocol — Zod schemas and TypeScript types.
 *
 * ARCHITECTURAL DECISION: the gateway's public contract is the OpenAI API, so
 * these schemas are the single source of truth for both request validation
 * (routes parse incoming bodies through them, rejecting with 422) and for the
 * types every provider adapter translates to and from. Putting them in their
 * own module (rather than in providers/base.ts as the tree suggests) lets
 * routes, cache, stream utilities, providers, and the token counter share one
 * definition without importing the provider layer.
 *
 * Request schemas use `.passthrough()` so vendor-specific or newly-added OpenAI
 * parameters survive translation to the upstream provider instead of being
 * silently stripped — important for a transparent drop-in proxy.
 *
 * Response/chunk shapes are plain interfaces (not Zod): the gateway CONSTRUCTS
 * these, so they need types, not runtime validation.
 */
import { z } from 'zod';

// ── Content parts (multimodal) ───────────────────────────────────────────────

/** A plain-text content part. */
export const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

/** An image content part supporting base64 data URLs and remote URLs (vision). */
export const imageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const contentPartSchema = z.discriminatedUnion('type', [
  textContentPartSchema,
  imageContentPartSchema,
]);

/** Message content is either a bare string or an array of typed parts. */
export const messageContentSchema = z.union([z.string(), z.array(contentPartSchema)]);

// ── Tool / function calling ──────────────────────────────────────────────────

export const functionCallSchema = z.object({
  name: z.string(),
  /** Arguments are a JSON-encoded STRING in the OpenAI wire format. */
  arguments: z.string(),
});

export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: functionCallSchema,
});

export const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
]);

// ── Messages (role-discriminated) ────────────────────────────────────────────

export const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([z.string(), z.array(textContentPartSchema)]),
  name: z.string().optional(),
});

export const userMessageSchema = z.object({
  role: z.literal('user'),
  content: messageContentSchema,
  name: z.string().optional(),
});

export const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z
    .union([z.string(), z.array(textContentPartSchema)])
    .nullable()
    .optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

export const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(textContentPartSchema)]),
  tool_call_id: z.string(),
});

export const chatMessageSchema = z.discriminatedUnion('role', [
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

// ── Chat completion request ──────────────────────────────────────────────────

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().min(1).max(128).optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    max_tokens: z.number().int().min(1).optional(),
    max_completion_tokens: z.number().int().min(1).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    logit_bias: z.record(z.number()).optional(),
    user: z.string().max(256).optional(),
    seed: z.number().int().optional(),
    tools: z.array(toolDefinitionSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    response_format: z
      .object({ type: z.enum(['text', 'json_object', 'json_schema']) })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── Embedding request ────────────────────────────────────────────────────────

export const embeddingRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union([
      z.string(),
      z.array(z.string()).min(1),
      z.array(z.number().int()).min(1),
      z.array(z.array(z.number().int()).min(1)).min(1),
    ]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().min(1).optional(),
    user: z.string().max(256).optional(),
  })
  .passthrough();

// ── Inferred request types ───────────────────────────────────────────────────

export type TextContentPart = z.infer<typeof textContentPartSchema>;
export type ImageContentPart = z.infer<typeof imageContentPartSchema>;
export type ContentPart = z.infer<typeof contentPartSchema>;
export type FunctionCall = z.infer<typeof functionCallSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type SystemMessage = z.infer<typeof systemMessageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type ToolMessage = z.infer<typeof toolMessageSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

// ── Response types (constructed by the gateway) ──────────────────────────────

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionResponseMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs: null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: CompletionUsage;
  system_fingerprint?: string;
}

// ── Streaming chunk types ────────────────────────────────────────────────────

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ToolCallDelta[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs: null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: CompletionUsage | null;
  system_fingerprint?: string;
}

// ── Embedding response types ─────────────────────────────────────────────────

export interface EmbeddingData {
  object: 'embedding';
  index: number;
  /** number[] for encoding_format=float; base64 string otherwise. */
  embedding: number[] | string;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ── Models endpoint types ────────────────────────────────────────────────────

export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: 'list';
  data: ModelObject[];
}
