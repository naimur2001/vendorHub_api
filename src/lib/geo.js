// Distances on the earth (Haversine). The same formula as the SQL in shops.service.js nearShops.
// A visitor's coordinates are only used for the answer: never stored and never logged.
import { z } from 'zod';

const EARTH_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

/** Kilometres between two points, rounded to 0.1; null when either point is missing. */
export function distanceKm(from, to) {
  if (!from || !to || to.latitude == null || to.longitude == null) return null;
  const dLat = rad(to.latitude - from.lat);
  const dLng = rad(to.longitude - from.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
}

/** Optional ?lat=&lng= (both or neither), validated ranges. */
export const optionalPoint = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
};
export const bothOrNeither = [
  (q) => (q.lat === undefined) === (q.lng === undefined),
  { message: 'Send both lat and lng, or neither', path: ['lat'] },
];
