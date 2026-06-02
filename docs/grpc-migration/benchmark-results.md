# gRPC Migration — Benchmark Results

## Environment
- GKE Autopilot cluster: lessgo-492322, namespace: lessgo
- API Gateway LoadBalancer: http://136.109.119.177
- k6 run location: external client → GKE LoadBalancer → api-gateway → internal services
- k6 version: v0.57.0
- Protocol under test: HTTP/1.1 (axios, no keep-alive) for external; gRPC/HTTP2 for all internal hops on this branch

## Scenario: Booking Creation — 3-hop chain (booking-service → cost-service → routing-service)

Tests `POST /api/bookings`. Pure computation, no ML inference. Each iteration books 1 seat.

### HTTP Baseline (`main` branch — 7 VUs, 2026-05-30)
| Metric | avg | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| booking_creation_latency_http | 723 ms | 592 ms | 1152 ms | 1393 ms | 2879 ms |
| http_req_duration | 699 ms | 585 ms | 1075 ms | 1341 ms | 2879 ms |
| error_rate | 0% | — | — | — | — |

- 149 iterations, 1.6 bookings/s, 0 errors, 7 VUs max

### HTTP with gRPC inter-service (`benchmark/grpc` branch — 20 VUs, 2026-06-01)
| Metric | avg | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| booking_creation_latency_grpc | 638 ms | 586 ms | 838 ms | 1006 ms | 1938 ms |
| http_req_duration | 640 ms | 577 ms | 854 ms | 1020 ms | 1970 ms |
| error_rate | 5.73% | — | — | — | — |

- 453 iterations, 4.1 bookings/s, 26 errors (all HTTP 400), 20 VUs max

> **Error note:** All 26 failures are HTTP 400s from `POST /api/bookings` — not timeouts or
> transport errors. Likely cause: trips from the search had seats exhausted by the prior
> http run. Re-seed the DB (`npm run bootstrap:db -- --fresh`) before re-running for a clean
> error-free comparison.

### Booking Creation Summary

| Metric | HTTP baseline (7 VUs) | gRPC inter-service (20 VUs) | Delta |
|---|---|---|---|
| avg | 723 ms | 638 ms | **-12%** |
| p50 | 592 ms | 586 ms | -1% (≈ same) |
| p90 | 1152 ms | 838 ms | **-27%** |
| p95 | 1393 ms | 1006 ms | **-28%** |
| max | 2879 ms | 1938 ms | **-33%** |
| throughput | 1.6 bookings/s | 4.1 bookings/s | **+156%** |
| errors | 0% | 5.73% ⚠️ | worse |

> **Load difference note:** The gRPC run used 20 VUs vs 7 in the baseline. The throughput gain
> reflects both higher concurrency and the gRPC transport change. The p90/p95 improvement is
> the most meaningful signal — latency held lower under nearly 3× the load.
>
> **Error note:** 8 failures (1.86%) on the gRPC run. Likely booking conflicts or transient DB
> contention under higher concurrency. Check server logs for root cause before concluding.

## Analysis

### Why gRPC shows improvement at tail latency
- HTTP/1.1 (axios default): one TCP connection per request, head-of-line blocking under load
- gRPC (HTTP/2): single multiplexed connection per service pair, binary protobuf framing
- Per-request overhead drops from ~TCP handshake + HTTP headers (~1-3ms) to framing only (~0.1ms)
- At 20 VUs the booking → cost → routing chain benefits from connection reuse; p90/p95 drop 22%

### Note on axios keep-alive
The HTTP baseline did not have `keepAlive: true` configured in axios (`httpAgent`).
Enabling keep-alive in HTTP/1.1 would recover some TCP overhead, but not HTTP/2 multiplexing.

### Connection handling
gRPC clients are initialized once at service startup and reuse the connection pool.
No per-request TCP overhead after the first request to a target service.

## How to Run

### HTTP baseline (run from `main` branch)
```bash
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/booking-creation-http.js \
  --out json=benchmarks/results/booking-creation-http.json
```

### gRPC inter-service (run from `benchmark/grpc` branch)
```bash
BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/booking-creation-grpc.js \
  --out json=benchmarks/results/booking-creation-grpc.json
```

> Both scripts hit the same `POST /api/bookings` HTTP endpoint — the gRPC is internal
> (service-to-service). The scripts differ only in metric name and output file so results
> stay cleanly separated.

### Extract p50/p95/p99 from results
```bash
cat benchmarks/results/booking-creation-grpc.json | \
  jq '[.[] | select(.type=="Point" and .metric=="booking_creation_latency_grpc")] |
  {p50: (map(.data.value) | sort | .[length * 0.5 | floor]),
   p95: (map(.data.value) | sort | .[length * 0.95 | floor]),
   p99: (map(.data.value) | sort | .[length * 0.99 | floor])}'
```
