import type { LngLat } from "./types";

export type LocationErrorReason = "denied" | "timeout" | "unavailable";

export class LocationError extends Error {
  constructor(
    public reason: LocationErrorReason,
    message: string,
  ) {
    super(message);
  }
}

const POSITION_TIMEOUT_MS = 10_000;

export function getCurrentPosition(): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new LocationError("unavailable", "Location isn't available on this device."));
      return;
    }

    // Some WebKit builds silently drop both callbacks when a fresh
    // getCurrentPosition() call overlaps with the continuous watchPosition()
    // the map's geolocate control keeps running for the live dot — the
    // native `timeout` option above doesn't save us there, so this fallback
    // guarantees the promise always settles instead of hanging forever.
    let settled = false;
    const fallback = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LocationError("timeout", "Couldn't get your location. Try again."));
    }, POSITION_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve([pos.coords.longitude, pos.coords.latitude]);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (err.code === err.PERMISSION_DENIED) {
          reject(new LocationError("denied", "Enable location access to do that."));
        } else if (err.code === err.TIMEOUT) {
          reject(new LocationError("timeout", "Couldn't get your location. Try again."));
        } else {
          reject(new LocationError("unavailable", "Couldn't get your location."));
        }
      },
      { enableHighAccuracy: true, timeout: POSITION_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}
