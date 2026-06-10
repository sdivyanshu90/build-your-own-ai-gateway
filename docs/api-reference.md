# API Reference

The gateway implements the OpenAI wire protocol. Authenticate `/v1/*` with a user key
(`Authorization: Bearer gw-…` or `x-api-key`). Authenticate `/admin/*` with `ADMIN_API_KEY`.
All errors use the OpenAI envelope:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": null, "code": "…" } }
```

Common response headers: `X-Request-Id`, and for chat/embeddings `X-Gateway-Provider`,
`X-Gateway-Model`, `X-Gateway-Latency-Ms`, `X-Gateway-Cache-Status` (HIT|MISS|SKIP|BYPASS),
`X-Gateway-Failover-Count`, `X-RateLimit-Limit|Remaining|Reset`.

---

## POST /v1/chat/completions

**Request body** (key fields; unknown OpenAI params pass through):

| Field                                  | Type                 | Notes                                                                    |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `model`                                | string               | required (1–256 chars)                                                   |
| `messages`                             | array                | required; roles system/user/assistant/tool; multimodal content supported |
| `temperature`                          | number 0–2           | optional                                                                 |
| `top_p`                                | number 0–1           | optional                                                                 |
| `stream`                               | boolean              | optional; SSE when true                                                  |
| `stream_options.include_usage`         | boolean              | emit a final usage chunk                                                 |
| `max_tokens` / `max_completion_tokens` | int                  | optional                                                                 |
| `stop`                                 | string \| string[]   | optional                                                                 |
| `seed`                                 | int                  | optional; required for cache eligibility                                 |
| `tools` / `tool_choice`                | array / enum\|object | function calling                                                         |
| `response_format`                      | object               | `text`\|`json_object`\|`json_schema`                                     |

**Status codes:** 200 (ok), 401 (auth), 404 (unknown model), 422 (invalid body), 429
(rate limit or budget), 503 (all providers failed). Streaming is `text/event-stream` ending
with `data: [DONE]`.

```bash
# Non-streaming
curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Cacheable (temperature 0 + seed) — second identical call returns X-Gateway-Cache-Status: HIT
curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","temperature":0,"seed":1,"messages":[{"role":"user","content":"2+2?"}]}'
```

**Success body** — standard OpenAI `chat.completion` (`id`, `object`, `created`, `model`,
`choices[].message`, `usage`). Tool calls appear in `choices[0].message.tool_calls`.

---

## POST /v1/embeddings

| Field             | Type                                         | Notes             |
| ----------------- | -------------------------------------------- | ----------------- |
| `model`           | string                                       | required          |
| `input`           | string \| string[] \| number[] \| number[][] | required          |
| `encoding_format` | enum                                         | `float`\|`base64` |
| `dimensions`      | int                                          | optional          |

```bash
curl localhost:8080/v1/embeddings \
  -H "Authorization: Bearer gw-..." -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hello world"}'
```

Returns `{ "object": "list", "data": [{ "object":"embedding","index":0,"embedding":[…] }], "model", "usage" }`.

---

## GET /v1/models

```bash
curl localhost:8080/v1/models -H "Authorization: Bearer gw-..."
```

Returns `{ "object":"list", "data":[{ "id","object":"model","created","owned_by" }] }`.

---

## Operational endpoints (no auth)

```bash
curl localhost:8080/health    # {"status":"ok"} — liveness, dependency-free
curl localhost:8080/ready     # 200 {"status":"ready","checks":{"database":true,"redis":true}} or 503
curl localhost:8080/metrics   # Prometheus exposition
```

---

## Admin API (`Authorization: Bearer $ADMIN_API_KEY`)

### Keys

```bash
# Create (returns the raw key ONCE)
curl -X POST localhost:8080/admin/keys -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"team-a","rpmLimit":120,"tpmLimit":200000,"monthlyBudgetUsd":500,"allowedModels":["gpt-4o"]}'

curl localhost:8080/admin/keys/$ID -H "Authorization: Bearer $ADMIN"            # metadata (no key/hash)
curl -X PATCH localhost:8080/admin/keys/$ID -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" -d '{"rpmLimit":200}'                     # update limits
curl -X DELETE localhost:8080/admin/keys/$ID -H "Authorization: Bearer $ADMIN" # soft delete
curl localhost:8080/admin/keys/$ID/usage -H "Authorization: Bearer $ADMIN"     # usage report
```

### Providers & models

```bash
curl -X POST localhost:8080/admin/providers -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"openai-primary","baseUrl":"https://api.openai.com/v1","adapterType":"openai","apiKey":"sk-...","weight":10,"priority":1,"healthCheckUrl":"https://api.openai.com/v1/models"}'

curl -X POST localhost:8080/admin/providers/$PID/models -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"modelId":"gpt-4o","inputPricePer1k":0.0025,"outputPricePer1k":0.01,"supportsStreaming":true,"supportsTools":true}'

curl localhost:8080/admin/providers -H "Authorization: Bearer $ADMIN"             # list (no secrets)
curl localhost:8080/admin/providers/$PID/health -H "Authorization: Bearer $ADMIN" # health record
```

### Circuit breakers, cache, logs

```bash
curl localhost:8080/admin/circuit-breakers -H "Authorization: Bearer $ADMIN"
curl -X POST localhost:8080/admin/circuit-breakers/$PID/reset -H "Authorization: Bearer $ADMIN"
curl localhost:8080/admin/cache -H "Authorization: Bearer $ADMIN"                 # stats
curl -X POST localhost:8080/admin/cache/flush -H "Authorization: Bearer $ADMIN"
curl "localhost:8080/admin/logs?apiKeyId=$ID&limit=50&offset=0" -H "Authorization: Bearer $ADMIN"
```

**Rate limiting:** `/v1/*` endpoints are limited per key (RPM + TPM sliding window). The admin
and operational endpoints are not rate-limited by the app (protect them at the ingress).
