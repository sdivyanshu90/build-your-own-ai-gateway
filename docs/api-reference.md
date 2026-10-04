# API reference

The gateway implements the OpenAI wire protocol under `/v1`, plus operational endpoints and an admin API. Examples assume the gateway at
`http://localhost:8080`, a user key in `$KEY` (`gw-...`) and the admin key in `$ADMIN`.

Authentication: `/v1/*` takes `Authorization: Bearer $KEY` (scheme case-insensitive) or `x-api-key: $KEY`; `/admin/*` takes the admin key the same two ways.
`/health`, `/ready`, `/metrics` are unauthenticated.

## Error envelope and codes

Every error is OpenAI-shaped:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_request"
  }
}
```

| HTTP | `type`                  | `code`                               | When                                                                                                                                                                                             |
| ---- | ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400  | `invalid_request_error` | `invalid_request` / `provider_error` | Malformed JSON body (`FST_ERR_CTP*`); or an upstream 400-class error that is a genuine client error is passed through with the **upstream status** (400, 413, 422...) and code `provider_error`. |
| 401  | `authentication_error`  | `invalid_api_key`                    | Missing/invalid/inactive/expired key.                                                                                                                                                            |
| 403  | `permission_error`      | `permission_denied`                  | Model not allowed for the key; any bad/missing **admin** credential.                                                                                                                             |
| 404  | `not_found_error`       | `not_found`                          | Unknown model (`param: model`); unknown route; missing admin resource.                                                                                                                           |
| 413  | `invalid_request_error` | `payload_too_large`                  | Body larger than `MAX_REQUEST_BODY_BYTES`.                                                                                                                                                       |
| 422  | `invalid_request_error` | `invalid_request`                    | Zod validation failure; the message lists the first three failing paths (`messages.0.role: ...`) and `param` is the first path.                                                                  |
| 429  | `rate_limit_error`      | `rate_limit_exceeded`                | RPM/TPM window exhausted; `Retry-After` (seconds) set.                                                                                                                                           |
| 429  | `rate_limit_error`      | `insufficient_quota`                 | Monthly budget reached.                                                                                                                                                                          |
| 500  | `api_error`             | `internal_error`                     | Anything unexpected (message is generic); also Redis outage while the rate limiter is enabled.                                                                                                   |
| 502  | `server_error`          | `provider_error`                     | Upstream rejected the gateway's credential/billing/model (401/402/403/404 upstream); malformed upstream body. Only seen when the failing provider is the last one tried.                         |
| 503  | `server_error`          | `all_providers_failed`               | Every candidate failed or has an OPEN circuit.                                                                                                                                                   |
| 503  | `server_error`          | `service_unavailable`                | Event-loop back-pressure (`Retry-After: 50`).                                                                                                                                                    |

Errors after the first streamed byte cannot change the status; the stream just ends (no `[DONE]`).

## Response headers

| Header                                        | Where                                   | Meaning                                                                                                        |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `X-Request-Id`                                | all                                     | Echo of a valid inbound `X-Request-Id` (`[A-Za-z0-9._-]{1,128}`), else a UUID. Appears in logs as `requestId`. |
| `X-Gateway-Provider`                          | chat, embeddings (absent on cache hits) | Provider **name** that served the request.                                                                     |
| `X-Gateway-Model`                             | same                                    | Canonical model id after alias resolution.                                                                     |
| `X-Gateway-Latency-Ms`                        | same                                    | **Upstream** latency (stream: time to first chunk). Not the gateway overhead.                                  |
| `X-Gateway-Cache-Status`                      | same                                    | `HIT`, `MISS`, `SKIP` (ineligible or streaming), `BYPASS` (`X-Gateway-Cache-Control: no-cache`).               |
| `X-Gateway-Failover-Count`                    | same                                    | Providers attempted minus one.                                                                                 |
| `X-RateLimit-Limit` / `-Remaining` / `-Reset` | chat, embeddings (incl. 429)            | RPM limit, RPM remaining, epoch seconds when the oldest in-window request expires.                             |
| `Retry-After`                                 | 429, under-pressure 503                 | Seconds.                                                                                                       |

## POST /v1/chat/completions

Body fields the gateway validates (`chatCompletionRequestSchema`; additional OpenAI fields pass through to OpenAI-style upstreams, and are dropped by the other adapters -
[providers.md](./providers.md#parameter-support-matrix)):

| Field                                   | Type / limit              | Notes                                                                                                                                               |
| --------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------- |
| `model`                                 | string, 1-256             | Resolved via exact match then aliases.                                                                                                              |
| `messages`                              | array, >= 1               | Roles `system`, `user`, `assistant`, `tool`. `content` string or parts (`text`, `image_url`); `assistant.tool_calls`; `tool.tool_call_id` required. |
| `temperature`                           | 0-2                       | `0` + `seed` makes the request cacheable.                                                                                                           |
| `top_p`                                 | 0-1                       |                                                                                                                                                     |
| `n`                                     | 1-128                     | Only OpenAI-style upstreams return multiple choices.                                                                                                |
| `stream`                                | bool                      | SSE; see below.                                                                                                                                     |
| `stream_options.include_usage`          | bool                      | Emit a final usage chunk (the gateway always collects usage internally).                                                                            |
| `stop`                                  | string or up to 4 strings |                                                                                                                                                     |
| `max_tokens`, `max_completion_tokens`   | int >= 1                  | Anthropic/Gemini default to the model's `max_output_tokens`, else 4096.                                                                             |
| `presence_penalty`, `frequency_penalty` | -2..2                     |                                                                                                                                                     |
| `logit_bias`, `user`, `seed`            |                           | `seed` is also the cache opt-in flag.                                                                                                               |
| `tools`, `tool_choice`                  | function tools            | `none                                                                                                                                               | auto               | required` or a named function.   |
| `response_format`                       | `{type: text              | json_object                                                                                                                                         | json_schema, ...}` | Honoured by OpenAI/Mistral only. |

```bash
# Non-streaming
curl -sS localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'

# Streaming (-N disables curl buffering). Frames are `data: {chunk}` blocks ending with `data: [DONE]`.
curl -N localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hi"}]}'

# Cacheable: temperature 0 + seed. Repeat the call -> X-Gateway-Cache-Status: HIT
curl -si localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","temperature":0,"seed":1,"messages":[{"role":"user","content":"2+2?"}]}' | grep -i x-gateway

# Bypass the cache for one call
curl -s localhost:8080/v1/chat/completions -H "Authorization: Bearer $KEY" -H "X-Gateway-Cache-Control: no-cache" \
  -H "Content-Type: application/json" -d '{"model":"gpt-4o","temperature":0,"seed":1,"messages":[{"role":"user","content":"2+2?"}]}'

# Tool calling
curl -s localhost:8080/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "model":"claude-sonnet-4","messages":[{"role":"user","content":"Weather in Paris?"}],
  "tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}'
```

Success body: standard `chat.completion` (`id`, `object`, `created`, `model` (provider's echo or the requested id), `choices[]` with `message`, `finish_reason` in
`stop|length|tool_calls|content_filter`, `logprobs: null`, and `usage`). Streaming chunks are `chat.completion.chunk` with `delta.role` first, then `delta.content` / `delta.tool_calls`,
a finish chunk, then (if requested) a usage chunk with `choices: []`.

Statuses: 200, 401, 403 (model not allowed), 404 (unknown model), 422, 429, 503 (and the others in the table above).

## POST /v1/embeddings

| Field             | Type                                     | Notes                                              |
| ----------------- | ---------------------------------------- | -------------------------------------------------- |
| `model`           | string                                   | required                                           |
| `input`           | string, string[], number[] or number[][] | required (non-empty arrays)                        |
| `encoding_format` | `float` or `base64`                      | passed through to OpenAI-style upstreams           |
| `dimensions`      | int >= 1                                 | OpenAI `dimensions`; Gemini `outputDimensionality` |

```bash
curl -s localhost:8080/v1/embeddings -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":["hello","world"]}'
```

Returns `{object:"list", data:[{object:"embedding", index, embedding:[...]}], model, usage:{prompt_tokens,total_tokens}}`. Anthropic has no embeddings (400). Embeddings are not cached.

## GET /v1/models

```bash
curl -s localhost:8080/v1/models -H "Authorization: Bearer $KEY"
```

`{object:"list", data:[{id, object:"model", created:0, owned_by:<adapter type>}]}`, sorted by id, restricted to the key's `allowed_models` when set.

## Operational endpoints (no auth)

```bash
curl localhost:8080/health    # {"status":"ok"} - liveness, dependency-free
curl localhost:8080/ready     # 200 {"status":"ready","checks":{"database":true,"redis":true}} | 503 {"status":"not_ready",...}
curl localhost:8080/metrics   # Prometheus text exposition (if METRICS_ENABLED)
```

## Admin API (`Authorization: Bearer $ADMIN`)

All bodies are JSON validated by Zod (422 on error); unknown ids -> 404. Responses never contain provider credentials, API-key hashes or raw keys (except the one-time `key` on create).

### Keys

| Method + path               | Body / query                                                                                                                                           | Result                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/keys`          | `name?`, `ownerId?` (uuid), `monthlyBudgetUsd?` >= 0, `allowedModels?` string[], `rpmLimit?` int >= 1, `tpmLimit?` int >= 1, `expiresAt?` ISO datetime | `201` key metadata + `key` (**shown once**)                                                                               |
| `GET /admin/keys`           |                                                                                                                                                        | `{data:[...]}`                                                                                                            |
| `GET /admin/keys/:id`       |                                                                                                                                                        | metadata                                                                                                                  |
| `PATCH /admin/keys/:id`     | any of `name`, `isActive`, `monthlyBudgetUsd` (nullable), `allowedModels` (nullable), `rpmLimit`, `tpmLimit`, `expiresAt` (nullable)                   | metadata; invalidates the auth cache                                                                                      |
| `DELETE /admin/keys/:id`    |                                                                                                                                                        | soft delete (`isActive=false`) -> `{id, deleted:true}`; invalidates the auth cache                                        |
| `GET /admin/keys/:id/usage` |                                                                                                                                                        | `{apiKeyId, totalRequests, totalTokens, totalCostUsd, cacheHits, monthToDateSpendUsd}` (SQL totals + Redis month-to-date) |

```bash
curl -s -X POST localhost:8080/admin/keys -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"team-a","rpmLimit":120,"tpmLimit":200000,"monthlyBudgetUsd":500,"allowedModels":["gpt-4o"]}'
curl -s -X PATCH localhost:8080/admin/keys/$ID -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"rpmLimit":200}'
```

### Providers and models

| Method + path                                      | Body                                                                                                                                                                             | Result                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST /admin/providers`                            | `name`, `baseUrl` (URL), `adapterType` (`openai                                                                                                                                  | anthropic                                                       | gemini | cohere | mistral`), `apiKey`, `weight?`>= 0,`priority?`>= 1,`isActive?`, `healthCheckUrl?`, `timeoutMs?` | `201` provider (no secret; `hasApiKey`) - reloads the registry |
| `GET /admin/providers`, `GET /admin/providers/:id` |                                                                                                                                                                                  | provider(s)                                                     |
| `PATCH /admin/providers/:id`                       | any of the above (+ `healthCheckUrl` nullable)                                                                                                                                   | provider - reloads the registry                                 |
| `DELETE /admin/providers/:id`                      |                                                                                                                                                                                  | soft delete -> `{id, deleted:true}`                             |
| `POST /admin/providers/:id/models`                 | `modelId`, `displayName?`, `contextWindow?`, `maxOutputTokens?`, `inputPricePer1k?`, `outputPricePer1k?`, `supportsStreaming?`, `supportsTools?`, `supportsVision?`, `isActive?` | `201` model row                                                 |
| `GET /admin/providers/:id/models`                  |                                                                                                                                                                                  | `{data:[...]}`                                                  |
| `DELETE /admin/providers/:id/models/:modelId`      |                                                                                                                                                                                  | hard delete -> `{modelId, deleted:true}`                        |
| `GET /admin/providers/:id/health`                  |                                                                                                                                                                                  | health row (`status`, `latencyMs`, `errorMessage`, `checkedAt`) |

```bash
curl -s -X POST localhost:8080/admin/providers -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"openai-primary","baseUrl":"https://api.openai.com/v1","adapterType":"openai","apiKey":"sk-...","weight":10,"priority":1,"timeoutMs":30000}'
curl -s -X POST localhost:8080/admin/providers/$PID/models -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"modelId":"gpt-4o","inputPricePer1k":0.0025,"outputPricePer1k":0.01,"maxOutputTokens":16384}'
```

Only the replica that handled the write reloads immediately; others converge within `REGISTRY_CACHE_TTL_SECONDS`.

### Circuit breakers, cache, logs, health

| Method + path                                                                          | Result                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/circuit-breakers`                                                          | `{data:[{providerId, providerName, state, failures, openedAt}]}` - only providers with breaker state in Redis (a never-failed provider is absent = CLOSED) |
| `POST /admin/circuit-breakers/:providerId/reset`                                       | `{providerId, state:"CLOSED", reset:true}`                                                                                                                 |
| `GET /admin/cache`                                                                     | `{hits, misses, hitRate, entries}`                                                                                                                         |
| `POST /admin/cache/flush`                                                              | `{flushed:<n>}`                                                                                                                                            |
| `DELETE /admin/cache/:fingerprint`                                                     | 64-hex key -> `{fingerprint, removed}`                                                                                                                     |
| `GET /admin/logs?apiKeyId&providerId&modelId&statusCode&cacheHit&from&to&limit&offset` | `{data:[request_logs rows], pagination}` (limit 1-1000, default 50; newest first)                                                                          |
| `GET /admin/health`                                                                    | `200 {status:"ok", components:{database,redis}}` or `503 {status:"degraded",...}`                                                                          |

The admin and operational endpoints are not rate limited by the application; restrict them at the ingress.
