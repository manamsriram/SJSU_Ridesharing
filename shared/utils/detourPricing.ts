/**
 * Single source of truth for shared-ride detour pricing.
 *
 * Both the search-time quote (trip-service) and the trip-completion settlement
 * (cost-calculation-service) call computeDetourPricing with the same four routed
 * legs, so the price a rider is quoted and the price they are charged converge
 * (modulo live-traffic drift and the search-time dropoff approximation).
 */

export const IRS_MILEAGE_RATE = 0.67;
export const DRIVER_HOURLY = 15.0;
export const DETOUR_SURCHARGE = 1.25;

export interface DetourPricingArgs {
  legPickupDistMiles: number;   // driver origin -> rider pickup
  legRideDistMiles: number;     // rider pickup -> rider dropoff/destination
  legRideDurationHours: number; // duration of the rider's own leg
  legResumeDistMiles: number;   // rider dropoff -> driver destination
  directDistanceMiles: number;  // driver origin -> driver destination, direct
}

export interface DetourPricingResult {
  riderBaseCost: number;
  detourMiles: number;
  detourCost: number;
}

/**
 * Price the rider's own ride leg plus the marginal detour the driver incurs to
 * serve them. Detour distance is the extra road distance over what the driver
 * would have driven directly, never negative.
 */
export function computeDetourPricing(args: DetourPricingArgs): DetourPricingResult {
  const riderBaseCost =
    args.legRideDistMiles * IRS_MILEAGE_RATE + args.legRideDurationHours * DRIVER_HOURLY;
  const detourMiles = Math.max(
    0,
    (args.legPickupDistMiles + args.legResumeDistMiles) -
      (args.directDistanceMiles - args.legRideDistMiles)
  );
  const detourCost = detourMiles > 0.1 ? detourMiles * IRS_MILEAGE_RATE * DETOUR_SURCHARGE : 0;
  return { riderBaseCost, detourMiles, detourCost };
}
