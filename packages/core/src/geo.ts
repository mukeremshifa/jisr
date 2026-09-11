/** Geofence matching for location pins. Sites are small, so a spherical earth is plenty. */

export interface SiteGeo {
  id: string;
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radiusM: number | null;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeoMatch {
  site: SiteGeo;
  distanceM: number;
}

/**
 * Nearest site whose radius contains the pin. Outside every radius returns null,
 * and the caller asks the worker which site — we never guess a location onto a case.
 */
export function matchSite(lat: number, lng: number, sites: readonly SiteGeo[]): GeoMatch | null {
  let best: GeoMatch | null = null;
  for (const site of sites) {
    if (site.lat == null || site.lng == null || site.radiusM == null) continue;
    const distanceM = haversineMeters(lat, lng, site.lat, site.lng);
    if (distanceM > site.radiusM) continue;
    if (best === null || distanceM < best.distanceM) best = { site, distanceM };
  }
  return best;
}

export function isValidCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}
