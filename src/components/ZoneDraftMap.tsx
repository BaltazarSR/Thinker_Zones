"use client";

import { useEffect, useRef } from "react";
import { Map } from "maplibre-gl";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { ensurePmtilesProtocol } from "@/lib/mapSetup";
import { computeBounds } from "@/lib/geo";
import type { ZoneDraft } from "./MapView";
import "maplibre-gl/dist/maplibre-gl.css";

const FILL_SOURCE_ID = "draft-preview-fill";
const FILL_LAYER_ID = "draft-preview-fill-layer";
const LINE_LAYER_ID = "draft-preview-line-layer";
const PLACES_SOURCE_ID = "draft-preview-places";
const PLACES_LAYER_ID = "draft-preview-places-layer";
const PLACES_LABEL_LAYER_ID = "draft-preview-places-label";
const FIT_PADDING = 48;

interface ZoneDraftMapProps {
  draft: ZoneDraft;
}

export default function ZoneDraftMap({ draft }: ZoneDraftMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

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
        const sources = style.sources as Record<string, { bounds?: [number, number, number, number] }>;
        const dataBounds = sources.zonewars?.bounds;

        const bounds = computeBounds([...draft.polygon, ...draft.places.map((p) => p.location)]);

        const map = new Map({
          container: containerRef.current,
          style,
          bounds: bounds ?? undefined,
          fitBoundsOptions: { padding: FIT_PADDING },
          center: bounds ? undefined : [-103.3496, 20.6597],
          zoom: bounds ? undefined : 11,
          maxBounds: dataBounds,
          attributionControl: { compact: true },
        });
        mapRef.current = map;

        map.on("load", () => {
          map.addSource(FILL_SOURCE_ID, {
            type: "geojson",
            data: {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [[...draft.polygon, draft.polygon[0]]] },
              properties: {},
            },
          });
          const beforeLayer = map.getLayer("roads-label") ? "roads-label" : undefined;
          map.addLayer(
            {
              id: FILL_LAYER_ID,
              type: "fill",
              source: FILL_SOURCE_ID,
              paint: { "fill-color": "#ff5a36", "fill-opacity": 0.18 },
            },
            beforeLayer
          );
          map.addLayer(
            {
              id: LINE_LAYER_ID,
              type: "line",
              source: FILL_SOURCE_ID,
              layout: { "line-join": "round" },
              paint: { "line-color": "#ff5a36", "line-width": 2 },
            },
            beforeLayer
          );

          map.addSource(PLACES_SOURCE_ID, {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: draft.places.map((place, index) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: place.location },
                properties: { index },
              })),
            },
          });
          map.addLayer({
            id: PLACES_LAYER_ID,
            type: "circle",
            source: PLACES_SOURCE_ID,
            paint: {
              "circle-radius": 7,
              "circle-color": "#ffffff",
              "circle-stroke-color": "#ff5a36",
              "circle-stroke-width": 2.5,
            },
          });
          map.addLayer({
            id: PLACES_LABEL_LAYER_ID,
            type: "symbol",
            source: PLACES_SOURCE_ID,
            layout: {
              "text-field": ["to-string", ["+", ["get", "index"], 1]],
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
              "text-offset": [0, -1.4],
            },
            paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1.2 },
          });
        });
      });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
