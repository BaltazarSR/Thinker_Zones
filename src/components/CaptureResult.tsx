"use client";

import type { Player } from "@/lib/types";
import Avatar from "./Avatar";

interface CaptureResultProps {
  player: Player;
  zoneName: string;
  caption: string;
  photoUrl: string | null;
  onDismiss: () => void;
  // Set when this submission was a Boss Raid hit that didn't finish the
  // boss off — no ownership change, so the headline/flavor differ.
  isHit?: boolean;
  bossHp?: number | null;
  bossMaxHp?: number | null;
  // Names of zones seized as spoils alongside this one (Boss Raid finishing
  // blow only).
  plunderedZoneNames?: string[];
}

export default function CaptureResult({
  player,
  zoneName,
  caption,
  photoUrl,
  onDismiss,
  isHit = false,
  bossHp = null,
  bossMaxHp = null,
  plunderedZoneNames = [],
}: CaptureResultProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-7 p-6"
      style={{ background: "var(--background, #000)" }}
      onClick={onDismiss}
    >
      <p className="text-sm font-bold uppercase tracking-wider" style={{ color: "#ff5a36" }}>
        {isHit ? "Direct Hit!" : "Zone Captured"}
      </p>

      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt="Capture"
          className="h-64 w-64 rounded-3xl border object-cover"
          style={{ borderColor: "var(--border-container)" }}
        />
      ) : (
        <Avatar player={player} size={140} />
      )}

      <div className="text-center">
        <p className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
          {zoneName}
        </p>
        {isHit && bossHp !== null && bossMaxHp !== null && (
          <p className="mt-1 text-sm font-semibold" style={{ color: "#ff8a68" }}>
            HP: {bossHp} / {bossMaxHp}
          </p>
        )}
        <p className="mt-2 text-lg" style={{ color: "var(--text-secondary)" }}>
          &ldquo;{caption}&rdquo;
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--text-tertiary)" }}>
          — {player.name}
        </p>
        {plunderedZoneNames.length > 0 && (
          <p className="mt-3 text-sm font-semibold" style={{ color: "#ffd60a" }}>
            + seized {plunderedZoneNames.length} more zone{plunderedZoneNames.length === 1 ? "" : "s"}:{" "}
            {plunderedZoneNames.join(", ")}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        className="h-14 rounded-2xl px-10 text-base font-bold uppercase tracking-wide active:opacity-80"
        style={{ background: "var(--surface-hover-active)", color: "var(--text-primary, #fff)" }}
      >
        Back to Map
      </button>
    </div>
  );
}
