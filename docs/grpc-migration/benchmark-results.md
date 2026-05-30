# gRPC Migration — Benchmark Results

## Environment
- GKE Autopilot cluster: lessgo-492322, namespace: lessgo
- API Gateway LoadBalancer: http://136.109.119.177/
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
| trip_search_latency_grpc | 139 ms | 582 ms | 832 ms | 2933 ms |
| http_req_duration | 139 ms | 582 ms | 832 ms | 2933 ms |
| error_rate | 0.05% | — | — | — |

- 1729 iterations, 21.5 req/s, 1 error (connection reset)

## Summary

| Metric | HTTP | gRPC | Delta |
|---|---|---|---|
| p50 | 115 ms | 139 ms | **+21%** |
| p90 | 192 ms | 582 ms | **+203%** |
| p95 | 284 ms | 832 ms | **+193%** |
| max | 1258 ms | 2933 ms | **+133%** |
| throughput | 25.6 req/s | 21.5 req/s | **-16%** |
| errors | 0.00% | 0.05% | — |

**Result: gRPC is slower for this endpoint.** The trip search path calls the embedding service for
ML-based ranking, which dominates latency (~200-500ms per call). Transport-layer savings from gRPC
(sub-millisecond) are invisible against that bottleneck. The gRPC benefit would be measurable on
lightweight, high-frequency inter-service calls (e.g. auth token validation, cost calculation)
where no ML inference is involved.

## Analysis

### Why gRPC was expected to be faster
- HTTP/1.1 (axios default): one TCP connection per request, head-of-line blocking
- gRPC (HTTP/2): single multiplexed connection per service pair, binary protobuf framing
- Per-request overhead drops from ~TCP handshake + HTTP headers (~1-3ms) to framing only (~0.1ms)

### Why it wasn't faster here
- Trip search calls `embedding-service` for ML ranking on every request
- Embedding inference takes 200-500ms and saturates the embedding pod under load
- At 20 VUs the embedding service queues requests, driving p90/p95 up regardless of transport
- gRPC adds slight serialization overhead (proto marshal/unmarshal) that isn't offset when the
  bottleneck is compute, not network

### Note on axios keep-alive
The HTTP baseline did not have `keepAlive: true` configured in axios (`httpAgent`).
Enabling keep-alive in HTTP/1.1 would recover some TCP overhead, but not HTTP/2 multiplexing.

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
BASE_URL=http://136.109.119.177 \
  k6 run benchmarks/http-baseline.js --out json=benchmarks/results/http-baseline.json
```

### After gRPC migration (on `benchmark/grpc` branch)
```bash
BASE_URL=http://136.109.119.177 \
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
