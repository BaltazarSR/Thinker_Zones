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

export function getCurrentPosition(): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new LocationError("unavailable", "Location isn't available on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new LocationError("denied", "Enable location access to do that."));
        } else if (err.code === err.TIMEOUT) {
          reject(new LocationError("timeout", "Couldn't get your location. Try again."));
        } else {
          reject(new LocationError("unavailable", "Couldn't get your location."));
        }
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}
