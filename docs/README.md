# AI Gateway handbook

Start here. The documents are written to be read in order the first time and used as a reference afterwards. Every behavioural claim cites the file that implements it;
every number comes from a run recorded in `benchmarks/results/` ([benchmarks.md](./benchmarks.md)).

## Suggested reading order

| #   | Document                                                         | Read it to learn                                                                                                      |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | [overview.md](./overview.md)                                     | The problem, goals, non-goals, system shape                                                                           |
| 2   | [architecture.md](./architecture.md)                             | Layers, component and sequence diagrams (streaming and non-streaming), failover and breaker diagrams, state placement |
| 3   | [code-walkthrough.md](./code-walkthrough.md)                     | Every directory and key file/function                                                                                 |
| 4   | [providers.md](./providers.md)                                   | Each adapter's translation rules, parameter support matrix, quirks                                                    |
| 5   | [routing-and-load-balancing.md](./routing-and-load-balancing.md) | Model -> candidates, aliases, the five strategies, what `priority` really does                                        |
| 6   | [reliability.md](./reliability.md)                               | Failover semantics, what is (not) retried, circuit breaker state machine, health monitor, shutdown                    |
| 7   | [rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md)     | Sliding-window limiter, token accounting, the Lua script, limits of the design                                        |
| 8   | [caching.md](./caching.md)                                       | Eligibility, key derivation, tenancy, TTL                                                                             |
| 9   | [cost-tracking.md](./cost-tracking.md)                           | Cost math, token sources, budgets as soft limits, reporting                                                           |
| 10  | [security.md](./security.md)                                     | Threat model, API-key and credential handling, rotation, hardening                                                    |
| 11  | [data-model.md](./data-model.md)                                 | Every table and column, partitions, migrations, Redis keyspace                                                        |
| 12  | [configuration.md](./configuration.md)                           | Every environment variable: type, default, effect, whether it is inert                                                |
| 13  | [api-reference.md](./api-reference.md)                           | Endpoints with curl examples, error codes, headers                                                                    |
| 14  | [benchmarks.md](./benchmarks.md)                                 | Methodology, hardware, results, reproduction, interpretation, limitations                                             |
| 15  | [testing.md](./testing.md)                                       | Suites, how to run them, gaps                                                                                         |
| 16  | [deployment.md](./deployment.md)                                 | Docker, Compose, Kubernetes, Helm, CI/CD                                                                              |
| 17  | [operations-runbook.md](./operations-runbook.md)                 | Day-2 procedures and the production checklist                                                                         |
| 18  | [incident-response.md](./incident-response.md)                   | One runbook per alert                                                                                                 |
| 19  | [troubleshooting.md](./troubleshooting.md)                       | Symptom-first diagnosis and FAQ                                                                                       |
| 20  | [design-decisions.md](./design-decisions.md)                     | ADRs and the open-issues list                                                                                         |
| 21  | [audit.md](./audit.md)                                           | What the 2026-10-04 audit found and fixed, with commits                                                               |
| 22  | [glossary.md](./glossary.md)                                     | Terms                                                                                                                 |

The original system document, [../GATEWAY.md](../GATEWAY.md), remains as the narrative overview; where it and these documents disagree, these documents reflect the code.

## Where to look when...

- _A request failed:_ [api-reference.md](./api-reference.md#error-envelope-and-codes) then [troubleshooting.md](./troubleshooting.md).
- _You are adding a provider:_ [providers.md](./providers.md) and `GATEWAY.md` section 5.
- _You are tuning latency or throughput:_ [benchmarks.md](./benchmarks.md), then [rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md#cost-of-a-check).
- _You are reviewing security:_ [security.md](./security.md) and the open items in [design-decisions.md](./design-decisions.md#known-limitations-and-open-issues).
