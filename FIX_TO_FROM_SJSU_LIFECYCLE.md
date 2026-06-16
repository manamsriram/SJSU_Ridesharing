# Fix TO/FROM-SJSU Lifecycle Issues

## Context

A prior audit (this session, cross-confirmed against two independent passes) traced the TO-SJSU / FROM-SJSU trip lifecycle across search, booking, and settlement after the recent drop-off-detour fix (commit `51e5a2d`). Settlement pricing is now correct and symmetric for both directions. Three residual issues were found and confirmed by reading the actual code:

1. **Search quote vs. settlement price drift** — the search-time detour estimate (`trip.service.ts`) uses haversine (straight-line) distance and a different formula shape than settlement (`cost.service.ts`), which uses Google-routed road distance with a net-extra-distance formula. In the Bay Area, routed distance can run 20–40% over haversine, so riders are quoted one number and charged a different one at settlement — for both directions equally, since this isn't direction-specific.
2. **No explicit trip direction field** — the system validates "origin or destination is near SJSU" but never records which one. Every consumer (matching, search, future features) has to re-derive direction from coordinates.
3. **Carpool "same direction" matching check is a destination-proximity proxy, not a real direction check** — `matching.service.ts`'s en-route/in-progress candidate query only checks that the driver's destination is within 8 km of the rider's destination. It does not verify the driver and rider are actually traveling the same way (TO vs FROM SJSU), so an edge case exists where opposite-direction trips could match.

This plan fixes all three, in order of impact.

**Build-order warning (applies to every fix below):** `@lessgo/shared`'s `package.json` points `main`/`types` at `dist/index.js`/`dist/index.d.ts`, not the TypeScript source — every consuming service resolves the *compiled* output. After editing anything under `shared/`, run `npm run build` inside `shared/` (or the repo's top-level build script, if one chains it) **before** touching the consuming services, otherwise `import { computeDetourPricing } from '@lessgo/shared'` etc. will fail to compile or resolve to stale exports.

---

## Fix 1 — Make search quote and settlement use identical detour math

**Root cause:** Same constants (`IRS_MILEAGE_RATE=0.67`, `DRIVER_HOURLY=15.00`, `DETOUR_SURCHARGE=1.25`) are already duplicated in both services, but the *distance source* (haversine vs. routed) and the *formula shape* differ:
- Search (`services/trip-service/src/services/trip.service.ts:1093-1124`): `detourMiles = haversine(pickup-side) + haversine(dropoff-side)`, no subtraction against the direct route.
- Settlement (`services/cost-calculation-service/src/cost.service.ts:178-206`): `detour_miles = max(0, (legPickupDist + legResumeDist) - (direct_distance_miles - legRideDist))`, all legs routed.

**Fix:** extract the settlement formula into a shared, single-source-of-truth function so both services literally call the same code:

- New file `shared/utils/detourPricing.ts`:
  ```ts
  export const IRS_MILEAGE_RATE = 0.67;
  export const DRIVER_HOURLY = 15.00;
  export const DETOUR_SURCHARGE = 1.25;

  export function computeDetourPricing(args: {
    legPickupDistMiles: number;   // driver origin -> rider pickup
    legRideDistMiles: number;     // rider pickup -> rider dropoff/destination
    legRideDurationHours: number;
    legResumeDistMiles: number;   // rider dropoff -> driver destination
    directDistanceMiles: number;  // driver origin -> driver destination, direct
  }): { riderBaseCost: number; detourMiles: number; detourCost: number } {
    const riderBaseCost = args.legRideDistMiles * IRS_MILEAGE_RATE + args.legRideDurationHours * DRIVER_HOURLY;
    const detourMiles = Math.max(
      0,
      (args.legPickupDistMiles + args.legResumeDistMiles) - (args.directDistanceMiles - args.legRideDistMiles)
    );
    const detourCost = detourMiles > 0.1 ? detourMiles * IRS_MILEAGE_RATE * DETOUR_SURCHARGE : 0;
    return { riderBaseCost, detourMiles, detourCost };
  }
  ```
- Export it from `shared/index.ts`.
- `services/cost-calculation-service/src/cost.service.ts:178-206` (drop-off-aware path): replace the inline formula with a call to `computeDetourPricing(...)`, passing the three already-fetched routed legs and `direct_distance_miles`. The file's local `IRS_MILEAGE_RATE`/`DRIVER_HOURLY`/`DETOUR_SURCHARGE` consts (lines 3-5) are also used elsewhere in the same file — line 45 (`total_trip_cost`, a different function) and line 160 (`trip_cost` in `settleTrip`'s per-trip base, used by the non-drop-off-aware split). Re-export these three constants from `shared/utils/detourPricing.ts` with the same names and import them at the top of `cost.service.ts` instead of declaring them locally, so there's exactly one definition repo-wide — don't just delete the local consts and leave lines 45/160 broken.
- **Out of scope, left as-is intentionally:** the `else if (pickupLoc)` legacy path at lines 207-226 (no `dropoff_location` on the booking) keeps its own older formula (`detour_miles = max(0, toPickupDist + fromPickupDist - direct_distance_miles)`), which is a different, simpler calculation than `computeDetourPricing`. This is fine — it's a fallback for old bookings made before migration 035 added `dropoff_location`, and Fix 1 only needs the two formulas (search vs. the drop-off-aware settlement path) to agree, not the legacy fallback too.
- `services/trip-service/src/services/trip.service.ts:1090-1146` (`searchTripsWithRerouting`): replace the haversine detour calc with three routed legs, mirroring settlement exactly:
  - Leg pickup: `candidate.origin -> rider origin` (this is already `leg1` fetched at line 1108 — reuse it, no extra call).
  - Leg ride: `rider origin -> rider destination` (already `leg2` at line 1109 — reuse it).
  - Leg resume (**new call**): `rider destination -> candidate.destination`, fetched via the existing `fetchLeg` helper (already defined at line 1070) with a haversine fallback (`dropoffDetourMiles` haversine calc kept only as the fallback value passed into `fetchLeg`, not as the final detour number).
  - Direct distance: existing `directLineMiles` haversine is currently used as the routing fallback only — fetch a fourth routed leg `candidate.origin -> candidate.destination` for the true direct distance (matches what settlement does at `cost.service.ts:144-156`), again via `fetchLeg`.
  - Call `computeDetourPricing({...})` with these four legs and use its `detourMiles`/`detourCost`/`riderBaseCost` to populate `cost_breakdown` instead of the current inline math at lines 1122-1124.
  - This adds 2 extra routing-service calls per candidate, applied only to the already-paginated `page` slice (post-ranking, line 1062), not the raw candidate pool — so it's 2→4 calls per *returned* result, not per scored candidate. Both new legs go through `fetchLeg`'s existing retry+fallback, so failure mode is unchanged (falls back to haversine-derived estimate, never zeroes the quote).
  - **Caveat on convergence:** search has no `dropoff_location` yet (that only exists once a booking is made — see `pickup_location`/`dropoff_location` on `bookings`), so search must approximate `legResume` as `rider's intended destination -> driver's destination`, while settlement uses the rider's *actual* recorded dropoff. These are usually the same point but aren't guaranteed to be — convergence is approximate, not exact, and any residual gap left after this fix is from that approximation, not from a formula/distance-source mismatch.

**Net effect:** search quote and settlement charge converge to the same number (modulo live-traffic drift between quote time and trip completion, and the dropoff-approximation caveat above) — eliminates the systematic haversine-vs-routed gap, which was the dominant source of drift.

---

## Fix 2 — Add explicit `direction` field to trips

**New migration** `db/migrations/036_add_trip_direction.sql` (follow the exact pattern of `035_add_dropoff_location.sql`):
```sql
BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10);

ALTER TABLE trips
  ADD CONSTRAINT check_trip_direction
  CHECK (direction IS NULL OR direction IN ('TO_SJSU', 'FROM_SJSU'));

CREATE INDEX IF NOT EXISTS idx_trips_direction ON trips (direction);

COMMENT ON COLUMN trips.direction IS 'TO_SJSU if destination is SJSU, FROM_SJSU if origin is SJSU — set at creation, used by matching to verify directional compatibility';

COMMIT;
```
Mirrors `035_add_dropoff_location.sql`'s structure exactly: `BEGIN/COMMIT` transactional wrapper, `CHECK` constraint, index (plain B-tree here since it's a VARCHAR/enum-like column, not GIN — GIN is only needed for the JSONB column in 035), and `COMMENT ON COLUMN`.

(Nullable so existing rows aren't broken; new rows always populate it going forward — no backfill needed since direction is only consumed by the new matching check in Fix 3, which can simply skip the check for `direction IS NULL` legacy rows. Note one more write path produces `direction IS NULL` rows by default: `services/trip-service/src/controllers/matching.controller.ts:269` has its own raw `INSERT INTO trips (...)` for a debug/seed endpoint that simulates historical trips — leave it un-migrated (NULL direction is fine, Fix 3's filter tolerates it), but don't forget it exists when testing.)

**New shared helper** `shared/utils/sjsuDirection.ts`:
```ts
export const SJSU_COORDS = { lat: 37.3352, lng: -121.8811 };
export const SJSU_RADIUS_METERS = 800; // ~0.5 miles

export function inferTripDirection(
  originLat: number, originLng: number,
  destLat: number, destLng: number
): 'TO_SJSU' | 'FROM_SJSU' | null {
  const originNearSJSU = haversineMeters(originLat, originLng, SJSU_COORDS.lat, SJSU_COORDS.lng) <= SJSU_RADIUS_METERS;
  const destNearSJSU   = haversineMeters(destLat, destLng, SJSU_COORDS.lat, SJSU_COORDS.lng) <= SJSU_RADIUS_METERS;
  if (destNearSJSU) return 'TO_SJSU';     // destination near SJSU wins ties (both-near edge case)
  if (originNearSJSU) return 'FROM_SJSU';
  return null;
}
```
(`haversineMeters` already exists in `services/trip-service/src/services/matching.service.ts:39-52` — move it to `shared/utils/` so both this helper and the existing call sites import one copy instead of duplicating it. **It is not just defined there — it's actively imported and used 5x in `trip.service.ts` via `import { haversineMeters } from './matching.service'` at line 14.** Relocating it requires: (a) updating that import in `trip.service.ts` to `from '@lessgo/shared'`, and (b) updating `tests/unit/trip-search-fare-breakdown.test.ts:31` which does `vi.mock('../../services/trip-service/src/services/matching.service', () => ({ haversineMeters: vi.fn(...), ... }))` — this mock path must either change to mock `@lessgo/shared` instead, or `matching.service.ts` must keep re-exporting `haversineMeters` from shared for backward compatibility so the existing mock keeps working. Prefer the re-export — smaller diff, no test churn.)

This also fixes a latent inconsistency: `trip.controller.ts:49` hardcodes `sjsuCoordinates = { lat: 37.3352, lng: -121.8811 }` inline — replace with the shared `SJSU_COORDS` constant so there's one source of truth for the campus location.

**Wire it in:**
- `services/trip-service/src/services/trip.service.ts` `createTrip` (around line 119-133): after `geocodeTripLocations` resolves `originPoint`/`destinationPoint`, call `inferTripDirection(originPoint.lat, originPoint.lng, destinationPoint.lat, destinationPoint.lng)` and include `direction` in the `INSERT INTO trips (...)` column list and `VALUES`.
- `shared/types/index.ts`: add `direction?: 'TO_SJSU' | 'FROM_SJSU';` to the `Trip` interface (line ~100-117).
- `services/trip-service/src/controllers/trip.controller.ts:48-65`: no functional change required (validation logic stays the same), but can optionally simplify by reusing `inferTripDirection` instead of two separate `isLocationNearSJSU` calls — not required for this fix, leave as-is unless doing so is trivial during implementation.

---

## Fix 3 — Carpool matching: verify actual direction, not just destination proximity

**File:** `services/trip-service/src/services/matching.service.ts`

- `CandidateTrip` interface (line 66-77): add `direction: 'TO_SJSU' | 'FROM_SJSU' | null;`.
- `TripRequestRow` interface (line 55-64): add `direction: 'TO_SJSU' | 'FROM_SJSU' | null;` — populated by the caller (see below), not the DB (rider trip_requests are ephemeral search params, not stored trips).
- Both SQL `SELECT`s in `fetchCandidates` (pending query ~line 92-123, carpool query ~line 128-166) add `t.direction` to the selected columns — this is just for visibility/debugging on the returned row shape. **The new directional filter and its `$5` bind param apply only to the carpool query** (line 128-166, which already uses `$1-$4` = `req.origin_lng, req.origin_lat, req.destination_lng, req.destination_lat`). The pending-trips query (line 92-123) is a separate statement with its own param list (`$1-$3` = `origin_lng, origin_lat, departure_time`) and does **not** get this filter — pending (not-yet-en-route) trips don't have the same opposite-direction mismatch risk since they haven't started yet and the origin-proximity filter already anchors them correctly (see Finding #4 in the original audit).
- Carpool query's "same direction" filter (line 157-162): replace the destination-proximity-only check with an explicit direction match, keeping destination proximity as a secondary tie-breaker rather than the sole signal:
  ```sql
  -- Require matching direction when both are known; fall back to destination
  -- proximity only for legacy rows where direction wasn't recorded (NULL).
  AND (
    t.direction IS NULL
    OR $5::text IS NULL
    OR t.direction = $5
  )
  AND ST_DWithin(
        t.destination_point::geography,
        ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
        8000
      )
  ```
  Add `req.direction` as the new `$5` bind param.
- `matchRider` (line 367-388): after loading `req` from `trip_requests`, compute `req.direction = inferTripDirection(req.origin_lat, req.origin_lng, req.destination_lat, req.destination_lng)` (import from `shared`) before calling `fetchCandidates(req)`.

This is the lowest-priority fix since `CLAUDE.md` notes on-demand matching (which `matchRider`/`fetchCandidates` carpool path serves) is being deprecated in favor of posted-trip search — but it's a real gap worth closing while the code is still live.

---

## Files touched (summary)

- `shared/utils/detourPricing.ts` (new)
- `shared/utils/sjsuDirection.ts` (new, also relocates `haversineMeters`)
- `shared/index.ts` (export new utils)
- `shared/types/index.ts` (add `direction` to `Trip`)
- `db/migrations/036_add_trip_direction.sql` (new)
- `services/trip-service/src/services/trip.service.ts` (createTrip direction insert; searchTripsWithRerouting routed-detour rewrite)
- `services/trip-service/src/controllers/trip.controller.ts` (use shared `SJSU_COORDS`)
- `services/trip-service/src/services/matching.service.ts` (direction-aware carpool filter; relocate haversineMeters import)
- `services/cost-calculation-service/src/cost.service.ts` (use shared `computeDetourPricing`)

## Verification

0. `cd shared && npm run build` after any `shared/` edit, before testing the consuming services — see build-order warning above.
1. `npm run bootstrap:db` to apply migration 036.
2. `npm run test` — existing settlement and search tests must still pass; update any test fixture that asserts exact detour-fee numbers, since Fix 1 changes the search-time formula (routed instead of haversine) and will shift quoted prices in existing fixtures with mocked routing-service responses.
3. Add a new test case in `tests/unit/` (follow existing booking-approval-flow / settlement test patterns) asserting that a search-time quote and a settlement charge for the *same* trip/rider/route produce the same detour fee when the routing-service mock returns identical leg distances both times — this is the regression guard for Fix 1.
4. Manually exercise both directions end-to-end via the API gateway (`API_GATEWAY_URL`): create one TO-SJSU trip and one FROM-SJSU trip, book a rider on each, confirm `direction` column populated correctly in `trips`, run settlement, and confirm fare breakdown matches the original search quote within rounding.
5. For Fix 3, manually insert one TO_SJSU en-route trip and issue a FROM_SJSU trip request with destinations within 8 km of each other; confirm it's no longer returned as a carpool candidate post-fix (was returned pre-fix).

---

## Backlog (issues found during implementation)

### B1 — SJSU longitude typo `-122.8811` vs correct `-121.8811` — FIXED
While implementing `SJSU_COORDS`, found the campus longitude was wrong in three spots. Real SJSU is `37.3352, -121.8811` (correctly used in iOS `Constants.swift`, geocoding/settle tests, migration `021`, `frequent_route.service.ts`). The bad `-122.8811` value points into the Santa Cruz mountains ~80 km away.
- `CLAUDE.md:56` — doc said `-122.8811`. **Fixed** → `-121.8811`.
- `docs/api/endpoints.md:364` — example `origin_lng: -122.8811`. **Fixed** → `-121.8811`.
- `tests/unit/trip-search-fare-breakdown.test.ts` — `SEARCH_ROW.destination_lng` and three search-call args used `-122.8811` to represent "SJSU". **Fixed** → `-121.8811` (routing is mocked, so no assertion values shifted).

No occurrence of the bad value remained in shipping code (the new `shared/utils/sjsuDirection.ts` `SJSU_COORDS` uses the correct `-121.8811`).

### Status
All three fixes (1, 2, 3) implemented; shared package built; both services typecheck clean; full suite **183 tests / 26 files pass**; migration `036_add_trip_direction` applied to Supabase project `bdefyxdpojqxxvaybfwk` (column verified present). Convergence regression test added (`tests/unit/search-settlement-convergence.test.ts`).
