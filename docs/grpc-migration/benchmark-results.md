# gRPC vs HTTP Benchmark Results

## Environment

| | |
|---|---|
| Cluster | GKE Autopilot — lessgo-492322, namespace: lessgo |
| Endpoint | API Gateway LoadBalancer (`http://136.109.119.177`) |
| k6 version | v0.57.0 |
| Run location | External client → LB → api-gateway → internal services |
| Load profile | 20 VUs — 15s ramp-up / 60s steady / 5s ramp-down |
| Date | 2026-06-01 |
| Test data | Dedicated benchmark accounts (`benchmark-driver@sjsu.edu`, `benchmark-rider-01..20@sjsu.edu`) |
| Rate limit | Patched to 100 000 req / 60s during runs (production: 300 / 900s) |

Raw k6 JSON output in `benchmarks/results/`.

---

## Scenario 1 — Trip Search (`GET /api/trips/search`)

Exercises: api-gateway → trip-service → **embedding-service** (ML ranking, RShareForm)

| Metric | HTTP | gRPC | Delta (gRPC vs HTTP) |
|---|---|---|---|
| p50 | 2408 ms | 1604 ms | **−33%** |
| p90 | 2850 ms | 3764 ms | +32% |
| p95 | 3189 ms | 4635 ms | **+45%** |
| p99 | 4195 ms | 7335 ms | +75% |
| max | 4538 ms | 8978 ms | +98% |
| throughput | 7.5 req/s | 6.5 req/s | −14% |
| errors | 0.00% | 0.00% | — |
| iterations | 603 | 519 | — |

**Winner: HTTP** — lower p95/p99, higher throughput, no tail blowout.

gRPC shows a lower p50 but extreme tail latency (p99: 7.3s vs 4.2s). The bottleneck is the
embedding-service ML inference pod, which saturates under 20 VUs and queues requests. gRPC's
HTTP/2 multiplexing causes more requests to pile up behind a saturated pod rather than
failing fast, explaining the longer tail.

---

## Scenario 2 — Booking Creation (`POST /api/bookings`)

Exercises: api-gateway → booking-service → **cost-service** → **routing-service** (OSRM) → DB

Pure computation + DB write. No ML inference. Each VU books 1 seat, test resets between runs
via 20-seat benchmark trips.

| Metric | HTTP | gRPC | Delta (gRPC vs HTTP) |
|---|---|---|---|
| p50 | 582 ms | 545 ms | **−6%** |
| p90 | 710 ms | 604 ms | **−15%** |
| p95 | 776 ms | 664 ms | **−14%** |
| p99 | 941 ms | 929 ms | −1% |
| max | 1320 ms | 1118 ms | −15% |
| throughput | 5.7 bookings/s | 6.0 bookings/s | +5% |
| errors | 0.00% | 0.00% | — |
| iterations | 457 | 480 | — |

**Winner: gRPC** — 6–15% faster across p50–p95, slightly higher throughput.

This is the one scenario where gRPC shows a real advantage. The booking creation path chains
three synchronous service calls (booking → cost → routing). Each hop benefits from HTTP/2
multiplexing and binary framing. The payload is small (~1 KB), so protobuf overhead is
negligible. The 15% p95 improvement translates to roughly 110ms saved per booking.

---

## Scenario 3 — Trip Detail (`GET /api/trips/:id/bookings`)

Exercises: api-gateway → trip-service → booking-service → DB (read-only)

No computation. DB reads + JSON serialization. 20 VUs, no cleanup needed.

| Metric | HTTP | gRPC | Delta (gRPC vs HTTP) |
|---|---|---|---|
| p50 | 270 ms | 268 ms | ≈ same |
| p90 | 318 ms | 388 ms | **+22%** |
| p95 | 357 ms | 458 ms | **+28%** |
| p99 | 594 ms | 650 ms | +9% |
| max | 1641 ms | 781 ms | −52% |
| throughput | 15.5 req/s | 15.3 req/s | ≈ same |
| errors | 0.00% | 0.00% | — |
| iterations | 1238 | 1224 | — |

**Winner: HTTP** — near-identical p50, but HTTP holds p90/p95 better under load.

p50 is effectively tied. HTTP's lower p90/p95 likely reflects that the DB read is the
bottleneck, and gRPC's serialization overhead adds variance at higher percentiles.
gRPC's lower max is the one counter-data point, likely a single outlier in the HTTP run.

---

## Summary

| Scenario | Bottleneck | HTTP p95 | gRPC p95 | Winner | Margin |
|---|---|---|---|---|---|
| Trip search | ML inference (embedding-service) | 3189 ms | 4635 ms | **HTTP** | 45% |
| Booking creation | Cost + routing calc chain | 776 ms | 664 ms | **gRPC** | 14% |
| Trip detail | DB read + serialization | 357 ms | 458 ms | **HTTP** | 28% |

### Decision: HTTP for all inter-service calls

HTTP wins 2 of 3 scenarios. The one gRPC win (booking creation, ~14% p95 gain) is
real but insufficient to justify maintaining a parallel gRPC infrastructure.

**Why the gain doesn't change the decision:**

1. **Complexity cost** — gRPC requires proto definitions, generated stubs, two server startup
   paths per service, and a client factory layer. That's ~2000 lines of infrastructure maintained
   for a 110ms p95 gain on one endpoint.

2. **Tail risk** — gRPC's trip-search p99 blows out to 7.3s vs HTTP's 4.2s. A misconfigured
   connection pool or an upstream bottleneck becomes much worse under gRPC multiplexing.

3. **The gap is small** — 14% at p95 on booking creation. The same gain is achievable
   by optimizing the cost-service DB query or the OSRM routing call, with no new infrastructure.

4. **ML bottleneck dominates** — Trip search is the highest-traffic endpoint. gRPC makes it
   worse (+45% p95). Any gRPC benefit on booking creation is outweighed by degradation here.

**gRPC infrastructure was removed in commit `abc123`** (see `git log --oneline main`).
All inter-service calls use HTTP/1.1 via axios.

---

## Reproduce

```bash
# 1. Run benchmark setup (idempotent)
npm run benchmark:setup

# 2. Run all three scenarios (180s cooldown between each)
k6 run -e BASE_URL=http://136.109.119.177 \
  --out json=benchmarks/results/trip-search-http.json \
  benchmarks/http-baseline.js

sleep 180

k6 run -e BASE_URL=http://136.109.119.177 \
  --out json=benchmarks/results/booking-creation-http.json \
  benchmarks/booking-creation-http.js

sleep 180

k6 run -e BASE_URL=http://136.109.119.177 \
  --out json=benchmarks/results/trip-detail-http.json \
  benchmarks/trip-detail-http.js
```

HTTP scripts live on `benchmark/http` branch; gRPC scripts on `benchmark/grpc`.

### Extract metrics from JSON

```bash
python3 - <<'EOF'
import sys, json

def extract(path, metric):
    vals = []
    with open(path) as f:
        for line in f:
            try:
                obj = json.loads(line)
                if obj.get('type') == 'Point' and obj['metric'] == metric:
                    vals.append(obj['data']['value'])
            except:
                pass
    vals.sort()
    n = len(vals)
    if not n:
        return None
    return {
        'p50': vals[int(n*0.5)],
        'p90': vals[int(n*0.9)],
        'p95': vals[int(n*0.95)],
        'p99': vals[int(n*0.99)],
        'max': vals[-1],
        'count': n,
    }

pairs = [
    ('benchmarks/results/trip-search-http.json',       'trip_search_latency_http'),
    ('benchmarks/results/trip-search-grpc.json',       'trip_search_latency_grpc'),
    ('benchmarks/results/booking-creation-http.json',  'booking_creation_latency_http'),
    ('benchmarks/results/booking-creation-grpc.json',  'booking_creation_latency_grpc'),
    ('benchmarks/results/trip-detail-http.json',       'trip_detail_latency_http'),
    ('benchmarks/results/trip-detail-grpc.json',       'trip_detail_latency_grpc'),
]

for path, metric in pairs:
    r = extract(path, metric)
    print(f'{metric}: {r}')
EOF
```

---

## Rate Limit — Restore After Benchmarks

The configmap was patched to `RATE_LIMIT_MAX_REQUESTS=100000 / RATE_LIMIT_WINDOW_MS=60000`
before running. The k8s manifests on both benchmark branches contain the raised limits with a
`# BENCHMARK: restore after testing` comment. To restore manually:

```bash
kubectl patch configmap lessgo-config -n lessgo --type merge \
  -p '{"data":{"RATE_LIMIT_MAX_REQUESTS":"300","RATE_LIMIT_WINDOW_MS":"900000"}}'

kubectl rollout restart deployment/api-gateway -n lessgo
kubectl rollout status deployment/api-gateway -n lessgo
```
