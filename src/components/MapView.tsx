"use client";

import { useEffect, useRef, useState } from "react";
import { Map, NavigationControl, GeolocateControl } from "maplibre-gl";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { GeoJSONSource } from "maplibre-gl";
import { ensurePmtilesProtocol } from "@/lib/mapSetup";
import { computeBounds } from "@/lib/geo";
import type { LngLat, Tier } from "@/lib/types";
import "maplibre-gl/dist/maplibre-gl.css";

// Guadalajara Metropolitan Zone
const INITIAL_CENTER: [number, number] = [-103.3496, 20.6597];
const INITIAL_ZOOM = 12;

// Floor before the actual playzone-fit zoom is computed on load (see
// `computeBounds` below) — kept low so it never clamps the real value.
const MIN_ZOOM = 0;

// Extra breathing room (px) so the boundary isn't flush against the screen
// edge at the most-zoomed-out view.
const FIT_PADDING = 48;

const VERTEX_SOURCE_ID = "playzone-points";
const VERTEX_LAYER_ID = "playzone-vertices";

const ZONES_SOURCE_ID = "game-zones";
const ZONES_FILL_LAYER_ID = "game-zones-fill";
const ZONES_OUTLINE_LAYER_ID = "game-zones-outline";

const DRAFT_LINE_SOURCE_ID = "zone-draft-line";
const DRAFT_LINE_LAYER_ID = "zone-draft-line-layer";
const DRAFT_FILL_SOURCE_ID = "zone-draft-fill";
const DRAFT_FILL_LAYER_ID = "zone-draft-fill-layer";
const DRAFT_VERTEX_SOURCE_ID = "zone-draft-vertices";
const DRAFT_VERTEX_LAYER_ID = "zone-draft-vertex-layer";
const DRAFT_PLACES_SOURCE_ID = "zone-draft-places";
const DRAFT_PLACES_LAYER_ID = "zone-draft-places-layer";
const DRAFT_PLACES_LABEL_LAYER_ID = "zone-draft-places-label";

type ZoneToolMode = "off" | "polygon" | "places" | "editing";

export interface MapZoneInput {
  id: string;
  color: string;
  polygon: LngLat[];
  // Set (2+ entries) while the zone has an actual fight going — cycles the
  // fill/outline through each contestant's color with a pulsing opacity
  // instead of the static owner color.
  contestColors?: string[];
  tier?: Tier;
  // 0–1, only meaningful for tier "home" — drives the fill's "cracked at
  // low HP" look. Omitted/undefined reads as a full-health 1.
  bossHpRatio?: number;
}

// Contested-zone pulse, driven via setFeatureState + paint-property
// transitions rather than re-uploading the whole GeoJSON source on a
// timer (setData() re-parses/re-indexes everything, which visibly stutters
// at this frequency). setFeatureState only touches the affected feature and
// lets MapLibre interpolate the change on the GPU over the transition
// duration, so a lower tick rate still reads as a smooth, continuous pulse.
const CONTEST_COLOR_STEP_MS = 700;
const CONTEST_COLOR_TRANSITION_MS = 650;
const CONTEST_PULSE_STEP_MS = 500;
const CONTEST_PULSE_TRANSITION_MS = 480;
const CONTEST_FILL_OPACITY_LOW = 0.28;
const CONTEST_FILL_OPACITY_HIGH = 0.6;
const CONTEST_LINE_WIDTH_LOW = 2;
const CONTEST_LINE_WIDTH_HIGH = 4;

// id: null => a newly-dropped pin with no backing Place yet.
export interface DraftPlace {
  id: string | null;
  location: LngLat;
}

export interface ZoneDraft {
  // null => creating a brand-new zone; set => editing an existing one.
  zoneId: string | null;
  polygon: LngLat[];
  places: DraftPlace[];
}

export interface EditingZoneInput {
  id: string;
  polygon: LngLat[];
  places: DraftPlace[];
}

interface MapViewProps {
  zones?: MapZoneInput[];
  onZoneClick?: (zoneId: string) => void;
  onZoneDraftComplete?: (draft: ZoneDraft) => void;
  isAdmin?: boolean;
  editingZone?: EditingZoneInput | null;
  onCancelZoneEdit?: () => void;
}

export function zonesToFeatureCollection(zones: MapZoneInput[]) {
  return {
    type: "FeatureCollection" as const,
    features: zones.map((zone) => ({
      type: "Feature" as const,
      // A top-level (not just properties.id) feature id is what lets
      // setFeatureState target this specific feature later.
      id: zone.id,
      geometry: { type: "Polygon" as const, coordinates: [zone.polygon] },
      properties: {
        id: zone.id,
        color: zone.color,
        tier: zone.tier ?? "regular",
        bossHpRatio: zone.bossHpRatio ?? 1,
      },
    })),
  };
}

function dedupeClosingPoint(ring: LngLat[]): LngLat[] {
  if (ring.length < 2) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring.slice(0, -1) : ring;
}

function toLineFeature(vertices: LngLat[]) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: vertices.length > 0 ? [...vertices, vertices[0]] : [],
    },
    properties: {},
  };
}

function toDraftLineFeatureCollection(vertices: LngLat[]) {
  if (vertices.length < 2) return { type: "FeatureCollection" as const, features: [] };
  const coords = vertices.length >= 3 ? [...vertices, vertices[0]] : vertices;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords },
        properties: {},
      },
    ],
  };
}

function toDraftFillFeatureCollection(vertices: LngLat[]) {
  if (vertices.length < 3) return { type: "FeatureCollection" as const, features: [] };
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: [[...vertices, vertices[0]]] },
        properties: {},
      },
    ],
  };
}

function toPointsFeatureCollection(vertices: LngLat[]) {
  return {
    type: "FeatureCollection" as const,
    features: vertices.map((coord, index) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: coord },
      properties: { index },
    })),
  };
}

// Distance from point p to segment [a, b], in raw lng/lat units — a Euclidean
// approximation that's fine for a UI nearest-segment pick at city scale.
function distToSegmentSquared(p: LngLat, a: LngLat, b: LngLat): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function nearestSegmentIndex(vertices: LngLat[], point: LngLat): number {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const d = distToSegmentSquared(point, a, b);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export default function MapView({
  zones = [],
  onZoneClick,
  onZoneDraftComplete,
  isAdmin = false,
  editingZone = null,
  onCancelZoneEdit,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const verticesRef = useRef<LngLat[]>([]);
  const draggingIndexRef = useRef<number | null>(null);
  const editModeRef = useRef(false);
  const stopDraggingRef = useRef<(() => void) | null>(null);
  const onZoneClickRef = useRef(onZoneClick);
  const zonesRef = useRef(zones);
  const isAdminRef = useRef(isAdmin);
  const contestedIdsRef = useRef<Set<string>>(new Set());
  const contestColorIndexRef = useRef<Record<string, number>>({});
  const pulseHighRef = useRef(false);

  const draftPolygonRef = useRef<LngLat[]>([]);
  const draftPlacesRef = useRef<DraftPlace[]>([]);
  const draftZoneIdRef = useRef<string | null>(null);
  const zoneToolModeRef = useRef<ZoneToolMode>("off");
  const onZoneDraftCompleteRef = useRef(onZoneDraftComplete);
  const onCancelZoneEditRef = useRef(onCancelZoneEdit);
  const syncDraftSourcesRef = useRef<(() => void) | null>(null);
  const draftDraggingRef = useRef<{ kind: "vertex" | "place"; index: number } | null>(null);
  const draftDidDragRef = useRef(false);
  const stopDraftDraggingRef = useRef<(() => void) | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [zoneToolMode, setZoneToolMode] = useState<ZoneToolMode>("off");
  // While zoneToolMode === "editing", this picks which draft layer actually
  // reacts to clicks — otherwise a click meant to insert a shape vertex and
  // a click meant to drop a place pin are indistinguishable.
  const [editingSubMode, setEditingSubMode] = useState<"shape" | "places">("shape");
  const editingSubModeRef = useRef<"shape" | "places">("shape");
  const [draftCounts, setDraftCounts] = useState({ polygon: 0, places: 0 });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    editModeRef.current = editMode;
    const map = mapRef.current;
    if (map && map.getLayer(VERTEX_LAYER_ID)) {
      map.setLayoutProperty(VERTEX_LAYER_ID, "visibility", editMode ? "visible" : "none");
    }
  }, [editMode]);

  useEffect(() => {
    onZoneClickRef.current = onZoneClick;
  }, [onZoneClick]);

  useEffect(() => {
    isAdminRef.current = isAdmin;
    const map = mapRef.current;
    if (map && map.getLayer("playzone-boundary")) {
      map.setLayoutProperty("playzone-boundary", "visibility", isAdmin ? "visible" : "none");
    }
  }, [isAdmin]);

  useEffect(() => {
    onZoneDraftCompleteRef.current = onZoneDraftComplete;
  }, [onZoneDraftComplete]);

  useEffect(() => {
    onCancelZoneEditRef.current = onCancelZoneEdit;
  }, [onCancelZoneEdit]);

  useEffect(() => {
    if (!editingZone) return;
    const map = mapRef.current;
    if (!map) return;
    draftPolygonRef.current = dedupeClosingPoint(editingZone.polygon);
    draftPlacesRef.current = editingZone.places.map((p) => ({ ...p }));
    draftZoneIdRef.current = editingZone.id;
    setDraftCounts({ polygon: draftPolygonRef.current.length, places: draftPlacesRef.current.length });
    syncDraftSourcesRef.current?.();
    setEditingSubMode("shape");
    setZoneToolMode("editing");
  }, [editingZone]);

  useEffect(() => {
    editingSubModeRef.current = editingSubMode;
  }, [editingSubMode]);

  useEffect(() => {
    zoneToolModeRef.current = zoneToolMode;
    const map = mapRef.current;
    if (!map) return;
    const showPolygonTool = zoneToolMode !== "off" && map.getLayer(DRAFT_VERTEX_LAYER_ID);
    const showPlacesTool =
      (zoneToolMode === "places" || zoneToolMode === "editing") && map.getLayer(DRAFT_PLACES_LAYER_ID);
    if (map.getLayer(DRAFT_VERTEX_LAYER_ID)) {
      map.setLayoutProperty(DRAFT_VERTEX_LAYER_ID, "visibility", showPolygonTool ? "visible" : "none");
      map.setLayoutProperty(DRAFT_LINE_LAYER_ID, "visibility", showPolygonTool ? "visible" : "none");
      map.setLayoutProperty(DRAFT_FILL_LAYER_ID, "visibility", showPolygonTool ? "visible" : "none");
    }
    if (map.getLayer(DRAFT_PLACES_LAYER_ID)) {
      map.setLayoutProperty(DRAFT_PLACES_LAYER_ID, "visibility", showPlacesTool ? "visible" : "none");
      map.setLayoutProperty(DRAFT_PLACES_LABEL_LAYER_ID, "visibility", showPlacesTool ? "visible" : "none");
    }
  }, [zoneToolMode]);

  useEffect(() => {
    const map = mapRef.current;

    // Feature-state persists across setData by id, so a zone that just
    // stopped being contested needs its override explicitly cleared —
    // otherwise it'd keep showing its last pulsed color/opacity forever.
    const nowContested = new Set(
      zones.filter((z) => (z.contestColors?.length ?? 0) > 1).map((z) => z.id)
    );
    if (map) {
      for (const id of contestedIdsRef.current) {
        if (!nowContested.has(id)) map.removeFeatureState({ source: ZONES_SOURCE_ID, id });
      }
    }
    contestedIdsRef.current = nowContested;

    zonesRef.current = zones;
    const source = map?.getSource(ZONES_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(zonesToFeatureCollection(zones));
  }, [zones]);

  // Cycles a contested zone's color through its contestants — setFeatureState
  // only touches this one feature (no full-source re-parse), and the
  // fill/line-color transitions declared on the layers interpolate the
  // change smoothly rather than hard-cutting between colors.
  useEffect(() => {
    const tick = () => {
      const map = mapRef.current;
      if (!map) return;
      for (const zone of zonesRef.current) {
        const colors = zone.contestColors;
        if (!colors || colors.length < 2) continue;
        const next = ((contestColorIndexRef.current[zone.id] ?? -1) + 1) % colors.length;
        contestColorIndexRef.current[zone.id] = next;
        map.setFeatureState({ source: ZONES_SOURCE_ID, id: zone.id }, { color: colors[next] });
      }
    };
    tick();
    const id = setInterval(tick, CONTEST_COLOR_STEP_MS);
    return () => clearInterval(id);
  }, []);

  // Separate cadence for the opacity/line-width "breathing" — same
  // setFeatureState + transition approach, alternating high/low each tick.
  useEffect(() => {
    const tick = () => {
      const map = mapRef.current;
      if (!map) return;
      pulseHighRef.current = !pulseHighRef.current;
      const fillOpacity = pulseHighRef.current ? CONTEST_FILL_OPACITY_HIGH : CONTEST_FILL_OPACITY_LOW;
      const lineWidth = pulseHighRef.current ? CONTEST_LINE_WIDTH_HIGH : CONTEST_LINE_WIDTH_LOW;
      for (const zone of zonesRef.current) {
        if (!zone.contestColors || zone.contestColors.length < 2) continue;
        map.setFeatureState({ source: ZONES_SOURCE_ID, id: zone.id }, { fillOpacity, lineWidth });
      }
    };
    tick();
    const id = setInterval(tick, CONTEST_PULSE_STEP_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensurePmtilesProtocol();

    let cancelled = false;

    fetch("/styles/zone-wars.json")
      .then((res) => res.text())
      .then((text) => {
        if (cancelled || !containerRef.current) return;
        const resolved = text.replaceAll("{{ORIGIN}}", window.location.origin);
        const style = JSON.parse(resolved) as StyleSpecification;

        const sources = style.sources as Record<
          string,
          {
            data?: { geometry?: { coordinates?: LngLat[] } };
            bounds?: [number, number, number, number];
          }
        >;
        const initialRing = sources.playzone?.data?.geometry?.coordinates ?? [];
        verticesRef.current = dedupeClosingPoint(initialRing);

        // Cap panning to where the basemap actually has data — beyond this is
        // just empty void, not a gameplay boundary (that's "playzone" above).
        const dataBounds = sources.zonewars?.bounds;

        const map = new Map({
          container: containerRef.current,
          style,
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          minZoom: MIN_ZOOM,
          maxBounds: dataBounds,
          // Off here so it can be added manually below at bottom-left
          // instead of the library's default bottom-right (which now also
          // has the compass/geolocate controls).
          attributionControl: false,
        });
        mapRef.current = map;

        // Zoom +/- buttons removed per request — compass (rotate-reset) and
        // geolocate stay, pinch/scroll/double-click zoom still work fine
        // without the on-screen +/- widget.
        map.addControl(new NavigationControl({ showZoom: false, showCompass: true }), "bottom-right");
        const geolocate = new GeolocateControl({ trackUserLocation: true });
        map.addControl(geolocate, "bottom-right");
        map.on("error", (e) => console.error("maplibre error:", e.error?.message ?? e));

        map.on("load", () => {
          // Show the player's location dot right away instead of making
          // them tap the geolocate button first.
          geolocate.trigger();

          const bounds = computeBounds(verticesRef.current);
          if (bounds) {
            const fit = map.cameraForBounds(bounds, { padding: FIT_PADDING });
            if (fit?.zoom !== undefined && fit.center) {
              map.setMinZoom(fit.zoom);
              // Recenter on the zone itself — otherwise zooming out from the
              // fixed default center can clip an asymmetric/edited boundary.
              map.setCenter(fit.center);
              if (map.getZoom() < fit.zoom) map.setZoom(fit.zoom);
            }
          }

          if (map.getLayer("playzone-boundary")) {
            map.setLayoutProperty("playzone-boundary", "visibility", isAdminRef.current ? "visible" : "none");
          }

          map.addSource(ZONES_SOURCE_ID, {
            type: "geojson",
            data: zonesToFeatureCollection(zonesRef.current),
          });
          const beforeLayer = map.getLayer("roads-label") ? "roads-label" : undefined;
          map.addLayer(
            {
              id: ZONES_FILL_LAYER_ID,
              type: "fill",
              source: ZONES_SOURCE_ID,
              paint: {
                // feature-state (set by the pulse ticks below) overrides the
                // static per-feature color/opacity while a zone is
                // contested; the *-transition specs make those overrides
                // interpolate smoothly instead of hard-cutting. Home zones
                // "crack" — fade out — as their boss HP drops; invaded
                // zones just sit at a slightly lower flat opacity.
                "fill-color": ["coalesce", ["feature-state", "color"], ["get", "color"]],
                "fill-opacity": [
                  "coalesce",
                  ["feature-state", "fillOpacity"],
                  [
                    "case",
                    ["==", ["get", "tier"], "home"],
                    ["interpolate", ["linear"], ["get", "bossHpRatio"], 0, 0.12, 1, 0.34],
                    ["==", ["get", "tier"], "invaded"],
                    0.22,
                    0.32,
                  ],
                ],
                "fill-color-transition": { duration: CONTEST_COLOR_TRANSITION_MS },
                "fill-opacity-transition": { duration: CONTEST_PULSE_TRANSITION_MS },
              },
            },
            beforeLayer
          );
          // No tier-based distinction for now — every zone, home/invaded
          // included, shares this one plain outline.
          map.addLayer(
            {
              id: ZONES_OUTLINE_LAYER_ID,
              type: "line",
              source: ZONES_SOURCE_ID,
              layout: { "line-join": "round" },
              paint: {
                "line-color": ["coalesce", ["feature-state", "color"], ["get", "color"]],
                "line-width": ["coalesce", ["feature-state", "lineWidth"], 2],
                "line-color-transition": { duration: CONTEST_COLOR_TRANSITION_MS },
                "line-width-transition": { duration: CONTEST_PULSE_TRANSITION_MS },
              },
            },
            beforeLayer
          );
          map.on("click", ZONES_FILL_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "off") return;
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === "string") onZoneClickRef.current?.(id);
          });
          map.on("mouseenter", ZONES_FILL_LAYER_ID, () => {
            if (draggingIndexRef.current === null) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", ZONES_FILL_LAYER_ID, () => {
            if (draggingIndexRef.current === null) map.getCanvas().style.cursor = "";
          });

          // --- Zone-creation tool: draw a new zone's polygon, then drop
          // named-later pins for its places. ---
          map.addSource(DRAFT_FILL_SOURCE_ID, {
            type: "geojson",
            data: toDraftFillFeatureCollection([]),
          });
          map.addLayer({
            id: DRAFT_FILL_LAYER_ID,
            type: "fill",
            source: DRAFT_FILL_SOURCE_ID,
            layout: { visibility: "none" },
            paint: { "fill-color": "#ff5a36", "fill-opacity": 0.15 },
          });
          map.addSource(DRAFT_LINE_SOURCE_ID, {
            type: "geojson",
            data: toDraftLineFeatureCollection([]),
          });
          map.addLayer({
            id: DRAFT_LINE_LAYER_ID,
            type: "line",
            source: DRAFT_LINE_SOURCE_ID,
            layout: { visibility: "none", "line-join": "round" },
            paint: { "line-color": "#ff5a36", "line-width": 2, "line-dasharray": [2, 1.5] },
          });
          map.addSource(DRAFT_VERTEX_SOURCE_ID, {
            type: "geojson",
            data: toPointsFeatureCollection([]),
          });
          map.addLayer({
            id: DRAFT_VERTEX_LAYER_ID,
            type: "circle",
            source: DRAFT_VERTEX_SOURCE_ID,
            layout: { visibility: "none" },
            paint: {
              "circle-radius": 6,
              "circle-color": "#ff5a36",
              "circle-stroke-color": "#000000",
              "circle-stroke-width": 1.5,
            },
          });
          map.addSource(DRAFT_PLACES_SOURCE_ID, {
            type: "geojson",
            data: toPointsFeatureCollection([]),
          });
          map.addLayer({
            id: DRAFT_PLACES_LAYER_ID,
            type: "circle",
            source: DRAFT_PLACES_SOURCE_ID,
            layout: { visibility: "none" },
            paint: {
              "circle-radius": 7,
              "circle-color": "#ffffff",
              "circle-stroke-color": "#ff5a36",
              "circle-stroke-width": 2.5,
            },
          });
          map.addLayer({
            id: DRAFT_PLACES_LABEL_LAYER_ID,
            type: "symbol",
            source: DRAFT_PLACES_SOURCE_ID,
            layout: {
              visibility: "none",
              "text-field": ["to-string", ["+", ["get", "index"], 1]],
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
              "text-offset": [0, -1.4],
            },
            paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1.2 },
          });

          const syncDraftSources = () => {
            (map.getSource(DRAFT_FILL_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
              toDraftFillFeatureCollection(draftPolygonRef.current)
            );
            (map.getSource(DRAFT_LINE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
              toDraftLineFeatureCollection(draftPolygonRef.current)
            );
            (map.getSource(DRAFT_VERTEX_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
              toPointsFeatureCollection(draftPolygonRef.current)
            );
            (map.getSource(DRAFT_PLACES_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
              toPointsFeatureCollection(draftPlacesRef.current.map((p) => p.location))
            );
          };
          syncDraftSourcesRef.current = syncDraftSources;

          map.on("click", (e) => {
            const mode = zoneToolModeRef.current;
            if (mode === "off") return;
            if (draftDidDragRef.current) {
              draftDidDragRef.current = false;
              return;
            }
            const point: LngLat = [e.lngLat.lng, e.lngLat.lat];
            if (mode === "polygon") {
              draftPolygonRef.current.push(point);
            } else if (mode === "places") {
              draftPlacesRef.current.push({ id: null, location: point });
            } else if (mode === "editing" && editingSubModeRef.current === "places") {
              draftPlacesRef.current.push({ id: null, location: point });
            } else {
              return;
            }
            setDraftCounts({ polygon: draftPolygonRef.current.length, places: draftPlacesRef.current.length });
            syncDraftSources();
          });

          map.on("mousedown", DRAFT_VERTEX_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "editing" || editingSubModeRef.current !== "shape" || !e.features?.[0])
              return;
            if (e.originalEvent.button !== 0) return; // right-click is reserved for delete
            e.preventDefault();
            const index = e.features[0].properties?.index;
            if (typeof index !== "number") return;
            draftDraggingRef.current = { kind: "vertex", index };
            draftDidDragRef.current = false;
            map.dragPan.disable();
            map.getCanvas().style.cursor = "grabbing";
          });

          map.on("mousedown", DRAFT_PLACES_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "editing" || editingSubModeRef.current !== "places" || !e.features?.[0])
              return;
            if (e.originalEvent.button !== 0) return; // right-click is reserved for delete
            e.preventDefault();
            const index = e.features[0].properties?.index;
            if (typeof index !== "number") return;
            draftDraggingRef.current = { kind: "place", index };
            draftDidDragRef.current = false;
            map.dragPan.disable();
            map.getCanvas().style.cursor = "grabbing";
          });

          map.on("mousemove", (e) => {
            const dragging = draftDraggingRef.current;
            if (!dragging) return;
            draftDidDragRef.current = true;
            const point: LngLat = [e.lngLat.lng, e.lngLat.lat];
            if (dragging.kind === "vertex") {
              draftPolygonRef.current[dragging.index] = point;
            } else {
              const existing = draftPlacesRef.current[dragging.index];
              draftPlacesRef.current[dragging.index] = { ...existing, location: point };
            }
            syncDraftSources();
          });

          const stopDraftDragging = () => {
            if (draftDraggingRef.current === null) return;
            draftDraggingRef.current = null;
            map.dragPan.enable();
            map.getCanvas().style.cursor = "";
          };
          stopDraftDraggingRef.current = stopDraftDragging;
          map.on("mouseup", stopDraftDragging);
          // Catches release outside the canvas, where map-level mouseup won't fire.
          window.addEventListener("mouseup", stopDraftDragging);

          map.on("mouseenter", DRAFT_VERTEX_LAYER_ID, () => {
            if (
              zoneToolModeRef.current === "editing" &&
              editingSubModeRef.current === "shape" &&
              !draftDraggingRef.current
            ) {
              map.getCanvas().style.cursor = "grab";
            }
          });
          map.on("mouseleave", DRAFT_VERTEX_LAYER_ID, () => {
            if (!draftDraggingRef.current) map.getCanvas().style.cursor = "";
          });
          map.on("mouseenter", DRAFT_PLACES_LAYER_ID, () => {
            if (
              zoneToolModeRef.current === "editing" &&
              editingSubModeRef.current === "places" &&
              !draftDraggingRef.current
            ) {
              map.getCanvas().style.cursor = "grab";
            }
          });
          map.on("mouseleave", DRAFT_PLACES_LAYER_ID, () => {
            if (!draftDraggingRef.current) map.getCanvas().style.cursor = "";
          });

          map.on("dblclick", DRAFT_LINE_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "editing" || editingSubModeRef.current !== "shape") return;
            e.preventDefault();
            const point: LngLat = [e.lngLat.lng, e.lngLat.lat];
            const segIndex = nearestSegmentIndex(draftPolygonRef.current, point);
            draftPolygonRef.current.splice(segIndex + 1, 0, point);
            syncDraftSources();
          });

          map.on("contextmenu", DRAFT_VERTEX_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "editing" || editingSubModeRef.current !== "shape" || !e.features?.[0])
              return;
            e.preventDefault();
            if (draftPolygonRef.current.length <= 3) return;
            const index = e.features[0].properties?.index;
            if (typeof index !== "number") return;
            draftPolygonRef.current.splice(index, 1);
            syncDraftSources();
          });

          map.on("contextmenu", DRAFT_PLACES_LAYER_ID, (e) => {
            if (zoneToolModeRef.current !== "editing" || editingSubModeRef.current !== "places" || !e.features?.[0])
              return;
            e.preventDefault();
            if (draftPlacesRef.current.length <= 1) return;
            const index = e.features[0].properties?.index;
            if (typeof index !== "number") return;
            draftPlacesRef.current.splice(index, 1);
            syncDraftSources();
          });

          map.addSource(VERTEX_SOURCE_ID, {
            type: "geojson",
            data: toPointsFeatureCollection(verticesRef.current),
          });
          map.addLayer({
            id: VERTEX_LAYER_ID,
            type: "circle",
            source: VERTEX_SOURCE_ID,
            layout: { visibility: editModeRef.current ? "visible" : "none" },
            paint: {
              "circle-radius": 6,
              "circle-color": "#ff5a36",
              "circle-stroke-color": "#000000",
              "circle-stroke-width": 1.5,
            },
          });

          const syncSources = () => {
            (map.getSource("playzone") as GeoJSONSource | undefined)?.setData(
              toLineFeature(verticesRef.current)
            );
            (map.getSource(VERTEX_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
              toPointsFeatureCollection(verticesRef.current)
            );
          };

          map.on("mousedown", VERTEX_LAYER_ID, (e) => {
            if (!editModeRef.current || !e.features?.[0]) return;
            e.preventDefault();
            draggingIndexRef.current = e.features[0].properties?.index ?? null;
            map.dragPan.disable();
            map.getCanvas().style.cursor = "grabbing";
          });

          map.on("mousemove", (e) => {
            if (draggingIndexRef.current === null) return;
            verticesRef.current[draggingIndexRef.current] = [e.lngLat.lng, e.lngLat.lat];
            syncSources();
          });

          const stopDragging = () => {
            if (draggingIndexRef.current === null) return;
            draggingIndexRef.current = null;
            map.dragPan.enable();
            map.getCanvas().style.cursor = "";
          };
          stopDraggingRef.current = stopDragging;
          map.on("mouseup", stopDragging);
          // Catches release outside the canvas, where map-level mouseup won't fire.
          window.addEventListener("mouseup", stopDragging);

          map.on("mouseenter", VERTEX_LAYER_ID, () => {
            if (editModeRef.current) map.getCanvas().style.cursor = "grab";
          });
          map.on("mouseleave", VERTEX_LAYER_ID, () => {
            if (draggingIndexRef.current === null) map.getCanvas().style.cursor = "";
          });

          map.on("dblclick", "playzone-boundary", (e) => {
            if (!editModeRef.current) return;
            e.preventDefault();
            const point: LngLat = [e.lngLat.lng, e.lngLat.lat];
            const segIndex = nearestSegmentIndex(verticesRef.current, point);
            verticesRef.current.splice(segIndex + 1, 0, point);
            syncSources();
          });

          map.on("contextmenu", VERTEX_LAYER_ID, (e) => {
            if (!editModeRef.current || !e.features?.[0]) return;
            e.preventDefault();
            if (verticesRef.current.length <= 3) return;
            const index = e.features[0].properties?.index;
            if (typeof index !== "number") return;
            verticesRef.current.splice(index, 1);
            syncSources();
          });
        });
      });

    return () => {
      cancelled = true;
      if (stopDraggingRef.current) {
        window.removeEventListener("mouseup", stopDraggingRef.current);
      }
      if (stopDraftDraggingRef.current) {
        window.removeEventListener("mouseup", stopDraftDraggingRef.current);
      }
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const handleSave = async () => {
    setStatus("Saving…");
    try {
      const closedRing = [...verticesRef.current, verticesRef.current[0]];
      const res = await fetch("/api/playzone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coordinates: closedRing }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setStatus(`Saved (${data.points} points)`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    }
  };

  const resetZoneDraft = () => {
    draftPolygonRef.current = [];
    draftPlacesRef.current = [];
    draftZoneIdRef.current = null;
    setDraftCounts({ polygon: 0, places: 0 });
    syncDraftSourcesRef.current?.();
  };

  const handleStartZoneTool = () => {
    resetZoneDraft();
    setZoneToolMode("polygon");
  };

  const handleUndoDraftPoint = () => {
    if (zoneToolMode === "polygon") {
      draftPolygonRef.current.pop();
    } else if (zoneToolMode === "places") {
      draftPlacesRef.current.pop();
    }
    setDraftCounts({ polygon: draftPolygonRef.current.length, places: draftPlacesRef.current.length });
    syncDraftSourcesRef.current?.();
  };

  const handleFinishPolygon = () => {
    if (draftPolygonRef.current.length < 3) return;
    setZoneToolMode("places");
  };

  const handleDonePlaces = () => {
    if (draftPlacesRef.current.length < 1) return;
    onZoneDraftCompleteRef.current?.({
      zoneId: null,
      polygon: [...draftPolygonRef.current],
      places: draftPlacesRef.current.map((p) => ({ ...p })),
    });
    resetZoneDraft();
    setZoneToolMode("off");
  };

  const handleSaveZoneEdit = () => {
    if (draftPolygonRef.current.length < 3 || draftPlacesRef.current.length < 1) return;
    onZoneDraftCompleteRef.current?.({
      zoneId: draftZoneIdRef.current,
      polygon: [...draftPolygonRef.current],
      places: draftPlacesRef.current.map((p) => ({ ...p })),
    });
    resetZoneDraft();
    setZoneToolMode("off");
  };

  const handleCancelZoneTool = () => {
    const wasEditing = zoneToolModeRef.current === "editing";
    resetZoneDraft();
    setZoneToolMode("off");
    if (wasEditing) onCancelZoneEditRef.current?.();
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute bottom-3 left-3 z-10 flex flex-col-reverse items-start gap-2">
        {isAdmin && (
          <div
            className="flex gap-2 rounded-xl border p-2"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--border-container)",
            }}
          >
            <button
              type="button"
              disabled={zoneToolMode !== "off"}
              onClick={() => setEditMode((v) => !v)}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
              style={{
                background: editMode ? "#ffffff" : "var(--surface-hover)",
                color: editMode ? "#0a0a0a" : "var(--text-primary, #fff)",
              }}
            >
              {editMode ? "Editing Boundary" : "Edit Boundary"}
            </button>
            {editMode && (
              <button
                type="button"
                onClick={handleSave}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150"
                style={{ background: "var(--surface-hover-active)", color: "#fff" }}
              >
                Save
              </button>
            )}
            {zoneToolMode === "off" && (
              <button
                type="button"
                disabled={editMode}
                onClick={handleStartZoneTool}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
                style={{ background: "var(--surface-hover)", color: "var(--text-primary, #fff)" }}
              >
                Add Zone
              </button>
            )}
          </div>
        )}
        {editMode && (
          <div
            className="rounded-lg border px-2.5 py-1.5 text-xs"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--border-container)",
              color: "var(--text-secondary)",
            }}
          >
            Drag points to move · double-click line to add · right-click point to remove
          </div>
        )}
        {zoneToolMode === "editing" && (
          <div
            className="flex gap-2 rounded-xl border p-2"
            style={{ background: "var(--surface-2)", borderColor: "var(--border-container)" }}
          >
            <button
              type="button"
              onClick={() => setEditingSubMode("shape")}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150"
              style={{
                background: editingSubMode === "shape" ? "#ffffff" : "var(--surface-hover)",
                color: editingSubMode === "shape" ? "#0a0a0a" : "var(--text-primary, #fff)",
              }}
            >
              Edit Shape
            </button>
            <button
              type="button"
              onClick={() => setEditingSubMode("places")}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150"
              style={{
                background: editingSubMode === "places" ? "#ffffff" : "var(--surface-hover)",
                color: editingSubMode === "places" ? "#0a0a0a" : "var(--text-primary, #fff)",
              }}
            >
              Edit Places
            </button>
          </div>
        )}
        {zoneToolMode !== "off" && (
          <>
            <div
              className="flex flex-wrap gap-2 rounded-xl border p-2"
              style={{ background: "var(--surface-2)", borderColor: "var(--border-container)" }}
            >
              {zoneToolMode !== "editing" && (
                <button
                  type="button"
                  onClick={handleUndoDraftPoint}
                  disabled={
                    (zoneToolMode === "polygon" && draftCounts.polygon === 0) ||
                    (zoneToolMode === "places" && draftCounts.places === 0)
                  }
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
                  style={{ background: "var(--surface-hover)", color: "var(--text-primary, #fff)" }}
                >
                  Undo point
                </button>
              )}
              {zoneToolMode === "polygon" && (
                <button
                  type="button"
                  onClick={handleFinishPolygon}
                  disabled={draftCounts.polygon < 3}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
                  style={{ background: "#ffffff", color: "#0a0a0a" }}
                >
                  Finish shape
                </button>
              )}
              {zoneToolMode === "places" && (
                <button
                  type="button"
                  onClick={handleDonePlaces}
                  disabled={draftCounts.places < 1}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
                  style={{ background: "#ffffff", color: "#0a0a0a" }}
                >
                  Done
                </button>
              )}
              {zoneToolMode === "editing" && (
                <button
                  type="button"
                  onClick={handleSaveZoneEdit}
                  disabled={draftCounts.polygon < 3 || draftCounts.places < 1}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150 disabled:opacity-40"
                  style={{ background: "#ffffff", color: "#0a0a0a" }}
                >
                  Save Changes
                </button>
              )}
              <button
                type="button"
                onClick={handleCancelZoneTool}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors duration-150"
                style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
            </div>
            <div
              className="rounded-lg border px-2.5 py-1.5 text-xs"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--border-container)",
                color: "var(--text-secondary)",
              }}
            >
              {zoneToolMode === "polygon"
                ? `Tap to place points (${draftCounts.polygon}) · need 3+ to finish`
                : zoneToolMode === "places"
                  ? `Tap inside the zone to drop a place pin (${draftCounts.places})`
                  : editingSubMode === "shape"
                    ? "Drag points to move · double-click line to add point · right-click point to remove"
                    : "Tap to drop a place pin · drag pins to move · right-click pin to remove"}
            </div>
          </>
        )}
        {status && (
          <div
            className="rounded-lg border px-2.5 py-1.5 text-xs"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--border-container)",
              color: "var(--text-secondary)",
            }}
          >
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
