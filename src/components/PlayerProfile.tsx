"use client";

import type { MapZoneInput } from "./MapView";
import PlayerZonesMap from "./PlayerZonesMap";
import Avatar from "./Avatar";
import { CloseIcon, CrownIcon } from "./icons";
import { isHomeRuler } from "@/lib/zones";
import type { Player, Zone } from "@/lib/types";

interface PlayerProfileProps {
  player: Player;
  zones: Zone[];
  onClose: () => void;
  onZoneClick: (zoneId: string) => void;
}

export default function PlayerProfile({ player, zones, onClose, onZoneClick }: PlayerProfileProps) {
  const mapZones: MapZoneInput[] = zones.map((zone) => ({
    id: zone.id,
    color: player.color,
    polygon: zone.polygon,
  }));
  const isRuler = isHomeRuler(player.id, zones);

  return (
    <div className="fixed inset-0 z-[25] flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div className="flex items-center gap-3.5">
          <Avatar player={player} size={56} />
          <div>
            <p className="flex items-center gap-1.5 text-2xl font-extrabold" style={{ color: "var(--text-primary, #fff)" }}>
              {isRuler && <CrownIcon size={18} className="text-[#ffd60a]" />}
              {player.name}
            </p>
            <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              {zones.length} zone{zones.length === 1 ? "" : "s"} held
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-8">
        {zones.length > 0 ? (
          <div
            className="h-64 w-full overflow-hidden rounded-3xl border-2"
            style={{
              borderColor: "rgba(255,255,255,0.18)",
              borderStyle: "dashed",
              background: "var(--surface-1)",
              // WebGL canvases (MapLibre) are GPU-composited on their own layer and
              // often ignore a parent's overflow:hidden + border-radius clip; clip-path
              // is compositor-level and reliably clips it.
              clipPath: "inset(0 round 22px)",
            }}
          >
            <PlayerZonesMap zones={mapZones} onZoneClick={onZoneClick} />
          </div>
        ) : (
          <div
            className="flex h-64 w-full items-center justify-center rounded-3xl border-2"
            style={{ borderColor: `${player.color}66`, background: "var(--surface-1)" }}
          >
            <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
              No zones held yet.
            </p>
          </div>
        )}

        <h2
          className="mt-6 text-xs font-bold uppercase tracking-wider"
          style={{ color: "var(--text-tertiary)" }}
        >
          Zones
        </h2>
        <div className="mt-3 flex flex-col gap-2">
          {zones.map((zone) => (
            <button
              key={zone.id}
              type="button"
              onClick={() => onZoneClick(zone.id)}
              className="flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left active:opacity-80"
              style={{ borderColor: `${player.color}66`, background: "var(--surface-1)" }}
            >
              <div className="min-w-0">
                <p className="truncate text-base font-bold" style={{ color: "var(--text-primary, #fff)" }}>
                  {zone.nickname ?? zone.name}
                </p>
                {zone.nickname && (
                  <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                    {zone.name}
                  </p>
                )}
              </div>
              {zone.tier === "home" && (
                <span
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider"
                  style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
                >
                  Home
                </span>
              )}
              {zone.tier === "invaded" && (
                <span
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider"
                  style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
                >
                  Invaded
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
