# Plan: Settlement-Time Multi-Rider Discount (Option B)

## Context

Current system freezes individual detour quotes at booking time without accounting for route optimization savings when multiple riders are booked. This leaves money on the table:
- If driver picks up Sarah (1 mi detour) then Marcus (1 mi further, not 2 mi), total detour is 2 miles
- But Sarah quoted for 1 mi detour, Marcus quoted for 2 mi detour (assuming backtrack)
- Savings of 1 mile never reaches riders

**Goal:** Redistribute route optimization savings to riders at settlement time. Riders who enable shorter routes get proportional discounts.

## Approach

### Phase 1: Calculate Actual Route at Driver Confirmation
When driver approves/confirms all pending riders for a trip:
1. Fetch all confirmed bookings (pending → approved state)
2. Query Google Maps for actual optimized route through all pickup points
3. Calculate true total detour distance (difference from original posted route)

### Phase 2: Redistribute Savings to Riders
1. Calculate original expected detour (sum of individual quotes' detour distances)
2. Calculate actual detour (from optimized route)
3. Savings = Original Expected - Actual
4. Distribute savings proportionally based on each rider's share of original detour

**Formula per rider:**
```
rider_original_detour = quoted_detour_distance
total_original_detour = sum of all riders' quoted detours
rider_share = rider_original_detour / total_original_detour
rider_savings = total_savings * rider_share
rider_final_amount = rider_frozen_quote - rider_savings
```

### Phase 3: Apply Discount at Settlement
1. Before settleRider call, recalculate final amount with discount applied
2. Update settlement record with actual_detour_distance and discount_applied fields
3. Settle rider at discounted amount (still frozen, no further changes)

## Implementation Details

### Database Schema Changes
- `bookings` table: Add `actual_detour_distance` (float), `discount_amount` (numeric), `discount_reason` enum
- `trips` table: Add `confirmed_actual_distance` (float) to cache optimized route calculation

### Key Files to Modify

**Backend Services:**

1. **booking-service** (`services/booking/src/services/booking-service.ts`)
   - Add function `applyMultiRiderDiscounts(tripId)` called when driver confirms all riders
   - Calculates actual route distance, redistributes savings
   - Updates all confirmed bookings with discount amounts

2. **trip-service** (`services/trip/src/services/trip.service.ts`)
   - Extend `getTripPassengers()` to return frozen quote amounts
   - Add `calculateOptimizedRouteDistance(trip, riders)` to call Google Maps Directions API with waypoints

3. **settlement-service** (`services/settlement/src/services/settlement.service.ts`)
   - Modify `settleRider()` to use `discounted_settlement_amount` if discount applied
   - Log original amount vs final amount for transparency

4. **booking-controller** (`services/booking/src/controllers/booking.controller.ts`)
   - Add endpoint `PATCH /api/bookings/trip/:tripId/apply-discounts` (driver confirmation)
   - Calls `applyMultiRiderDiscounts()` when all riders confirmed

### Data Flow

```
Driver Confirms Riders
  ↓
applyMultiRiderDiscounts(tripId)
  ├─ Fetch all confirmed bookings for trip
  ├─ Calculate optimized route (Google Maps)
  ├─ Compare actual vs expected detour
  ├─ Redistribute savings proportionally
  └─ Update bookings with discount_amount
  ↓
Settlement Phase
  ↓
settleRider()
  └─ Use (frozen_quote - discount_amount) as final amount
```

### Edge Cases

1. **No savings:** If actual route = expected detour, discount = 0 (no change)
2. **Single rider:** No discount (no route optimization possible)
3. **Riders at same location:** All get same discount percentage
4. **Google Maps API fails:** Fall back to expected detour (no discount applied, log error)
5. **Driver cancels mid-trip:** Discount still applies (frozen at confirmation time)

## Verification

### Unit Tests
- `applyMultiRiderDiscounts()`: Verify discount calculation with 2/3/4 riders
- Proportional distribution: Ensure savings split correctly by detour weight
- Edge cases: Single rider, no savings, API failure

### Integration Tests
1. Book 2 riders on same trip
2. Driver confirms both
3. Verify `applyMultiRiderDiscounts()` called automatically
4. Check `discount_amount` populated in bookings
5. Settle both riders, verify final amounts include discount

### Manual Testing
1. Post trip: SJSU → Downtown
2. Rider A books (quoted $12, detour 1 mi)
3. Rider B books (quoted $8, detour 2 mi expected)
4. Driver confirms both
5. Check discount applied (expected: actual route 2.5 mi, saves 0.5 mi, split proportionally)
6. Settle both riders, verify amounts reduced by discount

## Files to Create/Modify

**New:**
- `services/booking/src/utils/discount-calculator.ts` — Discount logic

**Modified:**
- `services/booking/src/services/booking-service.ts`
- `services/trip/src/services/trip.service.ts`
- `services/settlement/src/services/settlement.service.ts`
- `services/booking/src/controllers/booking.controller.ts`
- Database migrations (add discount columns)
- Tests for discount calculation

## Rollback Plan

If discount calculation causes issues:
1. Revert discount columns (set all to 0)
2. Disable `applyMultiRiderDiscounts()` call
3. Settlement amounts revert to original frozen quotes (no change)
