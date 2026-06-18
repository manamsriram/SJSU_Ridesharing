# Infra TODO — Internal-Service Auth (pre-deploy)

Code for the shared-secret internal-service auth is committed (`f61eabb`) and verified
(197/197 unit tests, all TS services typecheck clean). The following are **cluster
configuration** tasks, not repo code, and must be done **before deploying to production**.

The auth middleware (`requireInternalService` in `shared/middleware/auth.ts`) is
**fail-closed in production**: if `INTERNAL_SERVICE_TOKEN` is not set, internal routes
return `503`. So provisioning the secret is a hard prerequisite, not optional.

## 1. Provision `INTERNAL_SERVICE_TOKEN` to all internal callers/callees

Every service that calls or serves an internal route must have the same secret in env:

- callers (send token via `internalServiceHeaders()`): trip-service (incl. the
  discount-freeze CronJob/Deployment and settlement-retry job), cost-calculation-service,
  matching flow
- callees (verify token via `requireInternalService`): booking-service, trip-service

Steps:
- create a k8s Secret holding the token (single shared value across services)
- inject it as env `INTERNAL_SERVICE_TOKEN` into each Deployment **and** any CronJob
  that performs internal calls
- generate a high-entropy random value (e.g. `openssl rand -hex 32`); never hardcode

Failure mode if skipped: freeze job + internal routes return `503` in prod and the
T-1h discount freeze never runs.

## 2. Strip inbound `x-internal-*` headers at the ingress / API gateway

The gateway/ingress must **delete** client-supplied `x-internal-token` and
`x-internal-service` headers on every external request before it reaches any service.

- without stripping, an external attacker can set these headers directly
- the constant-time token compare already blocks a forged `x-internal-token`, but
  stripping is defense-in-depth and fully closes the advisory-header spoof path
- implement via ingress controller header-removal annotation/rule, or an explicit
  strip in the api-gateway proxy layer

## Why this is the last step

The code fix is done and tested. Deploy is unsafe until (1) the secret is provisioned
(else fail-closed `503`) and (2) the ingress strips the inbound headers (else spoof
surface remains). Both are environment config owned by infra/deploy, outside this repo.
