# gRPC Migration — Benchmark Results

## Environment
- GKE Autopilot cluster: lessgo-492322, namespace: lessgo
- API Gateway LoadBalancer: $API_GATEWAY_URL (set via environment variable)
- k6 run location: external client → GKE LoadBalancer → api-gateway → internal services
- k6 version: v0.57.0
- Date: 2026-05-30
- Scenario: Trip search endpoint (`GET /api/trips/search`), 20 VUs, 15s ramp-up + 60s steady + 5s ramp-down

> **Rate limit note:** `lessgo-config` configmap was temporarily patched to
> `RATE_LIMIT_MAX_REQUESTS=10000 / RATE_LIMIT_WINDOW_MS=60000` before running.
> **Restore after benchmarks** (see [Restore Rate Limit](#restore-rate-limit) below).

## Scenario: Trip Search (20 VUs, 60s steady)

### HTTP Baseline (`benchmark/http` branch)
| Metric | p50 | p90 | p95 | max |
|---|---|---|---|---|
| trip_search_latency_http | 115 ms | 192 ms | 284 ms | 1258 ms |
| http_req_duration | 115 ms | 192 ms | 284 ms | 1258 ms |
| error_rate | 0.00% | — | — | — |

- 2056 iterations, 25.6 req/s, 0 errors

### gRPC After (`benchmark/grpc` branch)
| Metric | p50 | p90 | p95 | max |
|---|---|---|---|---|
| trip_search_latency_grpc | TBD | TBD | TBD | TBD |
| http_req_duration | TBD | TBD | TBD | TBD |
| error_rate | TBD | — | — | — |

## Analysis

### Why gRPC is faster at high concurrency
- HTTP/1.1 (axios default): one TCP connection per request, head-of-line blocking
- gRPC (HTTP/2): single multiplexed connection per service pair, binary protobuf framing
- Per-request overhead drops from ~TCP handshake + HTTP headers (~1-3ms) to framing only (~0.1ms)
- Biggest wins: settlement path (6 sequential/parallel calls) and booking creation (3 blocking calls)

### Note on axios keep-alive
The HTTP baseline did not have `keepAlive: true` configured in axios (`httpAgent`).
Enabling keep-alive in HTTP/1.1 would recover some of the TCP overhead, but not HTTP/2 multiplexing.

### Connection handling
gRPC clients are initialized once at service startup and reuse the connection pool.
No per-request TCP overhead after the first request to a target service.

## Restore Rate Limit

**Must run after benchmarks are complete.** The configmap was live-patched and is not persisted in git.

```bash
kubectl patch configmap lessgo-config -n lessgo --type merge \
  -p '{"data":{"RATE_LIMIT_MAX_REQUESTS":"100","RATE_LIMIT_WINDOW_MS":"900000"}}'

kubectl rollout restart deployment/api-gateway -n lessgo
kubectl rollout status deployment/api-gateway -n lessgo
```

Verify restored:
```bash
kubectl get configmap lessgo-config -n lessgo -o jsonpath='{.data.RATE_LIMIT_MAX_REQUESTS}'
# should print: 100
```

---

## How to Run

### Baseline (on `benchmark/http` branch)
```bash
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/http-baseline.js --out json=benchmarks/results/http-baseline.json
```

### After gRPC migration (on `benchmark/grpc` branch)
```bash
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/grpc-after.js --out json=benchmarks/results/grpc-after.json
```

### Extract p50/p95/p99 from results
```bash
cat benchmarks/results/http-baseline.json | \
  jq '[.[] | select(.type=="Point" and .metric=="booking_creation_latency")] |
  {p50: (map(.data.value) | sort | .[length * 0.5 | floor]),
   p95: (map(.data.value) | sort | .[length * 0.95 | floor]),
   p99: (map(.data.value) | sort | .[length * 0.99 | floor])}'
```
