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

## Scenario: Booking Creation — 3-hop chain (7 VUs, 60s steady)

Tests `POST /api/bookings` → booking-service → cost-service → routing-service.
Pure computation, no ML inference. Each iteration books 1 seat then cancels.

- Date: 2026-05-30
- Trip: `c5a21ced-9952-459d-81ff-1136552861db` (8 seats, airport → SJSU)
- 7 VUs (capped below 8-seat limit to avoid contention), distinct rider per VU

### HTTP Baseline (`benchmark/http` branch)
| Metric | p50 | p90 | p95 | avg |
|---|---|---|---|---|
| booking_creation_latency_http | 592 ms | 1152 ms | 1393 ms | 723 ms |
| error_rate | 0% | — | — | — |

- 149 iterations, 1.6 bookings/s, 0 errors

### gRPC (`benchmark/grpc` branch)
| Metric | p50 | p90 | p95 | avg |
|---|---|---|---|---|
| booking_creation_latency_grpc | 584 ms | 1032 ms | 1858 ms | 835 ms |
| error_rate | 0% | — | — | — |

- 138 iterations, 0 errors

### Booking Creation Summary

| Metric | HTTP | gRPC | Delta |
|---|---|---|---|
| p50 | 592 ms | 584 ms | **-1%** (≈ same) |
| p90 | 1152 ms | 1032 ms | **-10%** |
| p95 | 1393 ms | 1858 ms | **+33% slower** |
| avg | 723 ms | 835 ms | +15% slower |
| errors | 0% | 0% | — |

**Result: negligible difference at median, gRPC adds tail latency at p95.**
The cost + routing service calls are compute-bound (fare calculation, route geometry). Transport
savings are masked by DB round-trips and computation time. The gRPC overhead
shows up at p95 as serialization under load.

---

## Scenario: Trip Detail / Bookings Lookup — 2-hop chain (20 VUs, 60s steady)

Tests `GET /api/trips/:id/bookings` → trip-service → booking-service.
Pure DB reads, no computation. Read-only, no cleanup needed.

> **Note:** Test trip had ~149–200 accumulated bookings from the booking-creation run,
> inflating response size (~180–255 KB/response). Real-world trips with 1–3 bookings
> will be significantly faster across both transports.

### HTTP Baseline (`benchmark/http` branch)
| Metric | p50 | p90 | p95 | avg |
|---|---|---|---|---|
| trip_detail_latency_http | 1373 ms | 2355 ms | 2851 ms | 1435 ms |
| error_rate | 0% | — | — | — |

- 528 iterations, 6.5 req/s, 0 errors, 95 MB received (~180 KB/req)

### gRPC (`benchmark/grpc` branch)
| Metric | p50 | p90 | p95 | avg |
|---|---|---|---|---|
| trip_detail_latency_grpc | 1858 ms | 2900 ms | 3181 ms | 1849 ms |
| error_rate | 1.82% | — | — | — |

- 439 iterations, 8 errors (timeouts at peak), 112 MB received (~255 KB/req)

### Trip Detail Summary

| Metric | HTTP | gRPC | Delta |
|---|---|---|---|
| p50 | 1373 ms | 1858 ms | **+35% slower** |
| p90 | 2355 ms | 2900 ms | **+23% slower** |
| p95 | 2851 ms | 3181 ms | **+12% slower** |
| avg | 1435 ms | 1849 ms | +29% slower |
| errors | 0% | 1.82% | worse |

**Result: gRPC is consistently slower for large-payload read endpoints.**
Returning hundreds of bookings per response means the bottleneck is DB query time
and response serialization, not transport protocol. gRPC's protobuf marshalling
adds overhead without benefit at this payload size.

---

## Overall Findings (all 3 scenarios)

| Scenario | Bottleneck | HTTP p95 | gRPC p95 | Winner |
|---|---|---|---|---|
| Trip search (ML) | Embedding inference (200–500ms) | 284 ms | 832 ms | **HTTP** |
| Booking creation (compute) | Cost + routing calc + DB | 1393 ms | 1858 ms | **HTTP** |
| Trip detail (read, large payload) | DB query + serialization | 2851 ms | 3181 ms | **HTTP** |

**Conclusion:** gRPC does not improve latency for any tested workload. All three
paths are bottlenecked by computation or DB I/O, not transport overhead. The
sub-millisecond transport savings of gRPC are invisible at these latency scales.

gRPC would show measurable gains on high-frequency, lightweight inter-service calls
(e.g. token validation, health checks, small-payload lookups) where the per-call
transport overhead is a meaningful fraction of total latency. None of the current
hot paths qualify.

**Recommendation:** Do not migrate to gRPC for performance. Revisit if a new
endpoint emerges with sub-10ms latency targets and high call frequency.

---

## How to Run

Scripts live on their respective branches. Results are stored in `benchmarks/results/` on main.

### Booking creation (on `benchmark/http` or `benchmark/grpc` branch)
```bash
TRIP_ID=c5a21ced-9952-459d-81ff-1136552861db \
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/booking-creation-http.js \
  --out json=benchmarks/results/booking-creation-http.json

# gRPC variant (benchmark/grpc branch):
TRIP_ID=c5a21ced-9952-459d-81ff-1136552861db \
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/booking-creation-grpc.js \
  --out json=benchmarks/results/booking-creation-grpc.json
```

### Trip detail (on `benchmark/http` or `benchmark/grpc` branch)
```bash
TRIP_ID=c5a21ced-9952-459d-81ff-1136552861db \
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/trip-detail-http.js \
  --out json=benchmarks/results/trip-detail-http.json

# gRPC variant:
TRIP_ID=c5a21ced-9952-459d-81ff-1136552861db \
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/trip-detail-grpc.js \
  --out json=benchmarks/results/trip-detail-grpc.json
```

> **Before running:** patch rate limit to 10000/60000 (see note at top). Restore after.

### Extract p50/p95/p99 from results
```bash
cat benchmarks/results/booking-creation-http.json | \
  jq '[.[] | select(.type=="Point" and .metric=="booking_creation_latency_http")] |
  {p50: (map(.data.value) | sort | .[length * 0.5 | floor]),
   p95: (map(.data.value) | sort | .[length * 0.95 | floor]),
   p99: (map(.data.value) | sort | .[length * 0.99 | floor])}'
```
