# gRPC vs HTTP Inter-Service Analysis

## Background

After running benchmarks on the `trip search` endpoint, gRPC was **slower** than HTTP (p95: 832ms vs 284ms).
This prompted a full audit of all 34 inter-service calls to identify where gRPC actually provides benefit.

## Benchmark Results (Trip Search — Wrong Endpoint)

| Metric | HTTP Baseline | gRPC After | Delta |
|---|---|---|---|
| p50 | 115 ms | 139 ms | +21% |
| p90 | 192 ms | 582 ms | +203% |
| p95 | 284 ms | 832 ms | +193% |
| max | 1258 ms | 2933 ms | +133% |
| throughput | 25.6 req/s | 21.5 req/s | -16% |
| errors | 0.00% | 0.05% | — |

**Why gRPC lost here:** Trip search calls `embedding-service` for ML-based ranking (RShareForm).
Inference latency is 200–500ms per call. gRPC transport savings (~1ms) are invisible against that bottleneck.

---

## Where gRPC Wins

These calls are **lightweight, computation-bound, and on the hot path** — transport overhead is a meaningful % of total latency.

| Caller | Called | Endpoint | Purpose | Why gRPC Helps |
|---|---|---|---|---|
| booking-service | cost-service | POST /cost/calculate | Quote price at booking create | Pure math, tiny payload, ~5–20ms baseline — transport overhead is significant % |
| booking-service | payment-service | POST /payments/create-intent | Create Stripe PaymentIntent | Small payload, called on every booking confirm |
| trip-service | routing-service | POST /route/calculate | ETA + detour distance per trip search result | OSRM computation, called multiple times on hot path |
| cost-service | routing-service | POST /route/calculate | Route calc during settlement (2× per rider) | Same — repeated on settlement path |
| trip-service | booking-service | GET /bookings/trip/{id} | Passenger list lookup | Simple DB read, high frequency on hot path |

**Best benchmark candidate:** `booking-service → cost-service` — pure computation, no ML, called synchronously on every booking creation, short payload.

---

## Where gRPC Does NOT Help

| Caller | Called | Endpoint | Reason gRPC Won't Help |
|---|---|---|---|
| trip-service | embedding-service | POST /match | ML inference dominates (200–500ms). Transport saves ~1ms. |
| \* (9 calls) | notification-service | POST /notifications/\* | Fire-and-forget, not blocking, not latency-sensitive |
| settlement-retry | cost/booking/notification | various | Cold path — runs on trip completion only, not high-frequency |
| booking-service | trip-service | GET /trips/{id} | Single DB lookup on booking creation, not high-frequency |
| cost-service | trip-service | GET /trips/{id} | Same — cold settlement path |

---

## Full Inter-Service Call Inventory

| Caller | Called | Endpoint | Purpose | Hot Path | Latency Sensitivity |
|---|---|---|---|---|---|
| trip-service | user-service | GET /users/{id} | Verify driver profile on trip create | no | medium |
| trip-service | booking-service | GET /bookings/trip/{id} | Fetch trip passenger list | yes | high |
| trip-service | cost-service | GET /cost/settle/{id} | Settlement calculation | no | medium |
| trip-service | booking-service | GET /bookings/trip/{id}/settle | Fetch bookings for settlement | no | medium |
| trip-service | booking-service | PATCH /bookings/{id}/final-price | Write final price | no | low |
| trip-service | booking-service | POST /bookings/{id}/capture-payment | Capture payment | no | low |
| trip-service | notification-service | POST /notifications/admin-alert | Settlement failure alert | no | low |
| trip-service | notification-service | POST /notifications/send | Trip status notification | no | low |
| trip-service | booking-service | POST /bookings/internal | Create booking from match accept | yes | high |
| trip-service | embedding-service | POST /match | ML ranking (RShareForm) | yes | high |
| trip-service | notification-service | POST /notifications/driver-request | Notify driver of match | yes | high |
| trip-service | notification-service | POST /notifications/send/payment-deadline-cancelled | Rider auto-cancel notice | no | low |
| trip-service | payment-service | POST /payments/trip/{id}/cancel-intents | Cancel Stripe intents | no | low |
| trip-service | routing-service | POST /route/calculate | Detour ETA + distance | yes | high |
| booking-service | notification-service | POST /notifications/send | In-app notification | no | low |
| booking-service | notification-service | POST /notifications/send/booking-confirmation | Confirmation email | no | low |
| booking-service | notification-service | POST /notifications/send/driver-new-booking | Driver new booking email | no | low |
| booking-service | notification-service | POST /notifications/send/cancellation | Cancellation email | no | low |
| booking-service | cost-service | POST /cost/calculate | Quote price at booking | yes | high |
| booking-service | payment-service | POST /payments/create-intent | Create PaymentIntent | yes | high |
| booking-service | trip-service | GET /trips/{id} | Verify trip/driver ownership | no | medium |
| cost-service | trip-service | GET /trips/{id} | Fetch trip for settlement | no | medium |
| cost-service | booking-service | GET /bookings/trip/{id}/settle | Fetch confirmed bookings | no | medium |
| cost-service | routing-service | POST /route/calculate | Direct route distance | no | medium |
| cost-service | routing-service | POST /route/calculate | Per-rider detour (2 legs) | no | medium |
| settlement-retry | cost-service | GET /cost/settle/{id} | Retry settlement | no | low |
| settlement-retry | booking-service | GET /bookings/trip/{id}/settle | Fetch bookings on retry | no | low |
| settlement-retry | booking-service | PATCH /bookings/{id}/final-price | Write price on retry | no | low |
| settlement-retry | booking-service | POST /bookings/{id}/capture-payment | Capture on retry | no | low |
| settlement-retry | notification-service | POST /notifications/admin-alert | Permanent failure alert | no | low |

---

## Recommended Next Benchmark

Target: **booking creation flow** (`POST /api/bookings`)

This exercises `booking-service → cost-service → routing-service` in sequence — pure computation, no ML,
high concurrency sensitivity. Run with an authenticated rider JWT and a valid trip ID.

```bash
AUTH_TOKEN=<rider_jwt> TRIP_ID=<uuid> BASE_URL=http://136.109.119.177 \
  k6 run benchmarks/booking-http-baseline.js --out json=benchmarks/results/booking-http-baseline.json
```
