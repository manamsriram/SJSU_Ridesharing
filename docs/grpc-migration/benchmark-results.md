# gRPC Migration — Benchmark Results

## Environment
- GKE Autopilot cluster: lessgo-492322, namespace: lessgo
- API Gateway LoadBalancer: $API_GATEWAY_URL (set via environment variable)
- k6 run location: external client → GKE LoadBalancer → api-gateway → internal services
- k6 version: (fill in after running)
- Date: (fill in)
- Protocol under test: HTTP/1.1 (axios, no keep-alive configured) → gRPC/HTTP2 for all internal hops

## Scenario: Booking Creation (20 VUs, 60s)

### HTTP Baseline
| Metric | p50 | p95 | p99 |
|---|---|---|---|
| booking_creation_latency | TBD | TBD | TBD |
| http_req_duration | TBD | TBD | TBD |
| error_rate | TBD | — | — |

### gRPC After
| Metric | p50 | p95 | p99 |
|---|---|---|---|
| booking_creation_latency_grpc | TBD | TBD | TBD |
| http_req_duration | TBD | TBD | TBD |
| error_rate | TBD | — | — |

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

## How to Run

### Baseline (run BEFORE migration, or from a git stash of pre-migration code)
```bash
AUTH_TOKEN=<rider_jwt> TEST_TRIP_ID=<uuid> BASE_URL=$API_GATEWAY_URL \
  k6 run benchmarks/http-baseline.js --out json=benchmarks/results/http-baseline.json
```

### After gRPC migration (run after deploying migrated services to GKE)
```bash
AUTH_TOKEN=<rider_jwt> TEST_TRIP_ID=<uuid> BASE_URL=$API_GATEWAY_URL \
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
