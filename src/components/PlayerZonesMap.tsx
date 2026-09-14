"use client";

import { useEffect, useRef } from "react";
import { Map } from "maplibre-gl";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { ensurePmtilesProtocol } from "@/lib/mapSetup";
import { computeBounds } from "@/lib/geo";
import { zonesToFeatureCollection, type MapZoneInput } from "./MapView";
import "maplibre-gl/dist/maplibre-gl.css";

const SOURCE_ID = "player-zones";
const FILL_LAYER_ID = "player-zones-fill";
const OUTLINE_LAYER_ID = "player-zones-outline";
const FIT_PADDING = 40;

interface PlayerZonesMapProps {
  zones: MapZoneInput[];
  onZoneClick?: (zoneId: string) => void;
}

export default function PlayerZonesMap({ zones, onZoneClick }: PlayerZonesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const onZoneClickRef = useRef(onZoneClick);

  useEffect(() => {
    onZoneClickRef.current = onZoneClick;
  }, [onZoneClick]);

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

        const bounds = computeBounds(zones.flatMap((z) => z.polygon));

        const map = new Map({
          container: containerRef.current,
          style,
          center: bounds ? undefined : [-103.3496, 20.6597],
          zoom: bounds ? undefined : 11,
          bounds: bounds ?? undefined,
          fitBoundsOptions: { padding: FIT_PADDING },
          maxBounds: dataBounds,
          attributionControl: { compact: true },
        });
        mapRef.current = map;

        map.on("load", () => {
          if (map.getLayer("playzone-boundary")) {
            map.setLayoutProperty("playzone-boundary", "visibility", "none");
          }

          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: zonesToFeatureCollection(zones),
          });
          const beforeLayer = map.getLayer("roads-label") ? "roads-label" : undefined;
          map.addLayer(
            {
              id: FILL_LAYER_ID,
              type: "fill",
              source: SOURCE_ID,
              paint: { "fill-color": ["get", "color"], "fill-opacity": 0.32 },
            },
            beforeLayer
          );
          map.addLayer(
            {
              id: OUTLINE_LAYER_ID,
              type: "line",
              source: SOURCE_ID,
              layout: { "line-join": "round" },
              paint: { "line-color": ["get", "color"], "line-width": 2 },
            },
            beforeLayer
          );
          map.on("click", FILL_LAYER_ID, (e) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === "string") onZoneClickRef.current?.(id);
          });
          map.on("mouseenter", FILL_LAYER_ID, () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", FILL_LAYER_ID, () => {
            map.getCanvas().style.cursor = "";
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
