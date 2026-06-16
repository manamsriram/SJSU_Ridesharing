import { haversineMeters } from './geo';

/** San Jose State University campus center — single source of truth for the SJSU anchor. */
export const SJSU_COORDS = { lat: 37.3352, lng: -121.8811 };
export const SJSU_RADIUS_METERS = 800; // ~0.5 miles

export type TripDirection = 'TO_SJSU' | 'FROM_SJSU';

/**
 * Infer a trip's direction relative to SJSU from its endpoints.
 * Destination-near-SJSU wins ties (a trip with both ends near campus is treated
 * as TO_SJSU). Returns null when neither endpoint is near campus.
 */
export function inferTripDirection(
  originLat: number, originLng: number,
  destLat: number, destLng: number
): TripDirection | null {
  const originNearSJSU =
    haversineMeters(originLat, originLng, SJSU_COORDS.lat, SJSU_COORDS.lng) <= SJSU_RADIUS_METERS;
  const destNearSJSU =
    haversineMeters(destLat, destLng, SJSU_COORDS.lat, SJSU_COORDS.lng) <= SJSU_RADIUS_METERS;
  if (destNearSJSU) return 'TO_SJSU';
  if (originNearSJSU) return 'FROM_SJSU';
  return null;
}
