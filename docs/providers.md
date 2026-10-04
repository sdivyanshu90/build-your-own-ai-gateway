# Provider adapters

Every upstream is wrapped by a subclass of `BaseProvider` (`src/providers/base.ts`). The adapter owns
the wire dialect; the router, load balancer and breaker only see the abstract interface.

```ts
chat(request, signal): Promise<ChatCompletionResponse>
chatStream(request, signal): AsyncIterable<ChatCompletionChunk>
embed(request, signal): Promise<EmbeddingResponse>
countTokens(messages, model): number
```

Adapters are constructed by `createAdapter` in `src/providers/registry.ts` from a `providers` row
(`adapter_type` enum). A new adapter is a subclass, an `ADAPTER_TYPES` entry, a migration adding the enum
label (pattern: `0002_add_cohere.sql`), a `createAdapter` case, and unit tests.

## Shared behaviour (`BaseProvider`)

**`upstreamFetch(url, init, signal, {streaming})`**

- Composes the caller's abort signal with the provider timeout using `AbortSignal.any`.
- Non-streaming: the timeout covers the whole exchange including the body read.
- Streaming: the timeout is disarmed as soon as response headers arrive, so it bounds
  time-to-first-response, not total generation time. (Before this was fixed, a 60 s `timeoutMs` silently
  truncated any generation longer than 60 s mid-stream.)
- Error classification: provider timeout -> `UpstreamTimeoutError` 504 (retryable); caller abort ->
  the original `AbortError` (not retryable, never counted against the provider); any other fetch
  failure -> `ProviderError` 502 (retryable).

**`mapHttpError(status, body)`**

| Upstream status              | Gateway error                                              | Retryable (fails over)  |
| ---------------------------- | ---------------------------------------------------------- | ----------------------- |
| 408                          | `UpstreamTimeoutError` 504                                 | yes                     |
| 429, 5xx                     | `ProviderError` with the upstream status                   | yes                     |
| 401, 402, 403, 404           | `ProviderError` **502** ("rejected the gateway's request") | yes                     |
| other 4xx (400, 413, 422...) | `ProviderError` with the upstream status                   | no - returned to client |

401/402/403/404 from an upstream mean the _gateway's_ credential, billing state or model mapping is
wrong. Returning them verbatim would show clients a bogus 401/404 and prevent failover to a healthy
provider, so they are surfaced as 502 and counted against the breaker.

The upstream error message (truncated to 500 characters) is embedded in the gateway error message.
Upstream error bodies can therefore reach API clients: do not put secrets in provider model names.

**Response validation.** The OpenAI adapter Zod-validates the upstream body; Anthropic validates the
envelope; Gemini and Cohere defensively parse unknown JSON with `isRecord` guards. A body that fails
validation becomes a retryable 502.

## Parameter support matrix

What the gateway forwards (anything else in the OpenAI request is **dropped** for non-OpenAI adapters).

| OpenAI field                                            | OpenAI                | Mistral       | Anthropic                                                          | Gemini                                  | Cohere (v2)        |
| ------------------------------------------------------- | --------------------- | ------------- | ------------------------------------------------------------------ | --------------------------------------- | ------------------ |
| `temperature`                                           | pass                  | pass          | clamped to <= 1                                                    | `temperature`                           | `temperature`      |
| `top_p`                                                 | pass                  | pass          | `top_p`                                                            | `topP`                                  | `p`                |
| `max_tokens` / `max_completion_tokens`                  | pass                  | pass          | `max_tokens` (required; falls back to model max output, then 4096) | `maxOutputTokens` (falls back likewise) | `max_tokens`       |
| `stop`                                                  | pass                  | pass          | `stop_sequences`                                                   | `stopSequences`                         | `stop_sequences`   |
| `seed`                                                  | pass                  | `random_seed` | dropped                                                            | dropped                                 | dropped            |
| `presence/frequency_penalty`, `logit_bias`, `n`, `user` | pass                  | **stripped**  | dropped                                                            | dropped                                 | dropped            |
| `response_format`                                       | pass                  | pass          | dropped                                                            | dropped                                 | dropped            |
| `tools` / `tool_choice`                                 | pass                  | pass          | translated                                                         | translated                              | translated         |
| `stream_options`                                        | pass (streaming only) | stripped      | handled by adapter                                                 | handled by adapter                      | handled by adapter |

Consequences: structured-output requests (`response_format`) silently lose the constraint on
Anthropic/Gemini/Cohere; `n > 1` returns a single choice from those; `seed` is not honoured outside
OpenAI/Mistral (the cache still requires `seed` to be present, see [caching.md](./caching.md)).

## OpenAI (`openai.ts`)

- `POST {baseUrl}/chat/completions`, `Authorization: Bearer`.
- Body is the request with `stream` forced; for non-streaming requests `stream_options` is removed
  (OpenAI rejects it when `stream` is false). Streaming requests keep `stream_options` (the router always
  sets `include_usage: true`).
- Usage backfill: if the upstream omits `usage`, prompt tokens are computed with tiktoken and
  completion tokens default to 0.
- Streaming: SSE frames are JSON-parsed and forwarded as `ChatCompletionChunk`; unparseable frames are
  skipped; `[DONE]` ends the stream. An upstream `{"error":...}` frame has no `choices`; the router
  tolerates it (`countDeltaTokens` guards the access).
- Reusable for any OpenAI-compatible endpoint (Azure, vLLM, Together, OpenRouter, local servers) by
  setting `base_url`.

## Mistral (`mistral.ts`)

Extends the OpenAI adapter. `buildChatBody` renames `seed` -> `random_seed`, strips `logit_bias`,
`presence_penalty`, `frequency_penalty`, `n`, `user` (to avoid 422s) and `stream_options`. Not verified
against the live Mistral API in this repository (no credentials were used); treat the stripped-field list as
the original author's assumption.

## Anthropic (`anthropic.ts`)

Messages API (`POST /v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`).

Request translation (`translateRequest`):

- `system` messages are concatenated (`\n\n`) into the top-level `system` field.
- `user` -> `user` with `text`/`image` blocks. `data:` URLs become `base64` sources, other URLs `url` sources.
- `assistant` -> `assistant` with `text` blocks plus one `tool_use` block per `tool_calls` entry
  (`arguments` JSON string parsed to an object; unparseable -> `{}`).
- `tool` -> `tool_result` block (with `tool_use_id`) inside a **user** turn.
- Consecutive same-role turns are merged because Anthropic requires strict alternation.
- `tool_choice`: `auto`->`{type:auto}`, `required`->`{type:any}`, named function -> `{type:tool,name}`,
  `none` -> the tools list is **omitted entirely** (Anthropic has no `none`).
- `temperature` is clamped to 1 (Anthropic rejects > 1; OpenAI allows up to 2).

Response translation:

- `text` blocks are concatenated; `tool_use` blocks become `tool_calls` with `JSON.stringify(input)`.
- `stop_reason`: `max_tokens` (and `model_context_window_exceeded`) -> `length`; `refusal` ->
  `content_filter`; `tool_use` (or any tool block seen) -> `tool_calls`; everything else -> `stop`.
  The validator accepts any string stop reason so a new Anthropic value is not turned into a 502.
- Usage: `input_tokens`/`output_tokens`; total is their sum. (Cache-read/creation tokens are not
  separately accounted.)

Streaming (`normaliseStream`): `message_start` -> role chunk and prompt tokens;
`content_block_start` (tool_use) -> tool-call opening chunk with a sequential OpenAI tool index mapped from
Anthropic's block index; `content_block_delta` `text_delta` -> content chunk, `input_json_delta` ->
argument-fragment chunk; `message_delta` -> stop reason + output tokens; `message_stop` -> finish chunk
and (when `include_usage`) usage chunk; an `error` event **throws** a retryable-502 `ProviderError`
so the router records a stream error instead of finishing "cleanly".

Embeddings: unsupported -> non-retryable 400.

## Gemini (`gemini.ts`)

`POST {baseUrl}/v1beta/models/{model}:generateContent` (or `:streamGenerateContent?alt=sse`), header
`x-goog-api-key` (the key never appears in a URL or log line); embeddings via `:batchEmbedContents`.

- Roles map to `user`/`model`; `system` messages become `systemInstruction.parts`.
- Images: `data:` URLs -> `inlineData`; plain URLs are sent as a text part `[image] <url>` (Gemini would
  need a File API upload for remote images - not implemented).
- Tool calls: assistant `tool_calls` -> `functionCall` parts (args parsed to object). Tool results ->
  `functionResponse` parts whose `name` is **recovered from the assistant turn** that issued the call
  (map of `tool_call_id` -> function name built from the whole history). Previously the opaque id was
  sent as the function name, which Gemini rejects whenever the id did not equal the function name (e.g.
  conversations that started on another provider).
- Gemini has no tool-call ids; the adapter mints unique ones (`call_<24 hex>`) so two calls to the same
  function in one turn do not collide.
- Usage: `promptTokenCount` + (`candidatesTokenCount` + `thoughtsTokenCount`) as completion (thinking
  tokens are billed as output but reported separately), total from `totalTokenCount`.
- `finishReason`: `MAX_TOKENS` -> `length`; `SAFETY`/`RECITATION` -> `content_filter`; tool calls ->
  `tool_calls`; else `stop`.
- Not handled: `promptFeedback.blockReason` (a blocked prompt yields an empty `stop` completion).

## Cohere v2 (`cohere.ts`)

`POST {baseUrl}/v2/chat`, `Authorization: Bearer`; embeddings `POST /v2/embed` with
`input_type: search_document` and `embedding_types: ['float']`.

- Messages map almost 1:1 (`system|user|assistant|tool`); assistant tool calls keep id/name/arguments;
  tool results keep `tool_call_id`.
- `top_p` -> `p`; `stop` -> `stop_sequences`; `tool_choice` `none` -> `NONE`, `auto` -> omitted (default),
  `required` **and a named function** -> `REQUIRED` (the specific function name cannot be forced).
- `finish_reason`: `MAX_TOKENS` -> `length`, `ERROR_TOXIC` -> `content_filter`, `TOOL_CALL` or tools seen ->
  `tool_calls`, else `stop`.
- Streaming events handled: `message-start`, `content-delta`, `tool-call-start`, `tool-call-delta`,
  `message-end` (carries `finish_reason` and `usage.tokens`). Tool-call stream `index` is Cohere's
  content-block index, not renumbered from 0.
- Embedding usage is **estimated** locally (heuristic token count) because the adapter does not read the
  upstream billed units.

## Token counting and cost accuracy

| Adapter family                                                     | Prompt token estimate (`countTokens`)                | Completion tokens           |
| ------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------- |
| OpenAI-style model ids (`gpt-*`, `o1/o3/o4*`, `text-embedding-3*`) | tiktoken, exact for those encodings                  | upstream usage              |
| Everything else                                                    | `ceil(chars/4)` + per-message overhead (approximate) | upstream usage when present |

The estimate is used for rate limiting (always) and for stream accounting only until the upstream
usage arrives. Because the gateway always requests usage on streams, billed numbers use the provider's
count wherever the provider reports one.
