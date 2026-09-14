import type { LngLat } from "./types";

export function computeBounds(points: LngLat[]): [LngLat, LngLat] | null {
  if (points.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

// Simple vertex-average centroid — fine for placing a badge marker inside a
// zone's polygon at city scale, not a true area-weighted centroid.
export function polygonCentroid(polygon: LngLat[]): LngLat {
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  const pts = polygon.length > 1 && first[0] === last[0] && first[1] === last[1] ? polygon.slice(0, -1) : polygon;
  let lng = 0;
  let lat = 0;
  for (const [pointLng, pointLat] of pts) {
    lng += pointLng;
    lat += pointLat;
  }
  return [lng / pts.length, lat / pts.length];
}

// Standard ray-casting point-in-polygon test.
export function isPointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
