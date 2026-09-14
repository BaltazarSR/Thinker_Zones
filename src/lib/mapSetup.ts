import { addProtocol, setWorkerUrl } from "maplibre-gl";
import { Protocol } from "pmtiles";

// maplibre-gl's addProtocol/removeProtocol are global, not per-Map-instance.
// With more than one Map mounted at once (e.g. the main map plus a profile
// mini-map), tying registration to a single component's mount/unmount would
// let one instance rip the handler out from under the other. Register once,
// for the app's lifetime, instead.
let initialized = false;

export function ensurePmtilesProtocol() {
  if (initialized) return;
  initialized = true;
  // Turbopack doesn't emit maplibre-gl-worker.mjs's sibling chunk correctly;
  // `scripts/copy-maplibre-worker.mjs` copies both files into public/maplibre
  // at dev/build time. See maplibre-gl's v6 Turbopack installation docs.
  setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
}
