"use client";

import type { ActiveMutinySummary, Zone } from "@/lib/types";

interface MutinyAlertBannerProps {
  alerts: ActiveMutinySummary[];
  zones: Zone[];
  onSelect: (alert: ActiveMutinySummary) => void;
}

// Mirrors ContestAlertBanner — this is what makes an incumbent's 30-second
// pick window survivable: without it, nothing tells them a duel is even
// happening, so they'd forfeit by default just for not staring at the app
// at the right moment.
export default function MutinyAlertBanner({ alerts, zones, onSelect }: MutinyAlertBannerProps) {
  const actionable = alerts.filter((a) => a.needsAction !== "waiting");
  if (actionable.length === 0) return null;

  const top = actionable.find((a) => a.needsAction === "needs_pick") ?? actionable[0];
  const zoneName = zones.find((z) => z.id === top.zoneId)?.name ?? "a zone";
  const label = top.needsAction === "needs_pick" ? `Your move. ${zoneName}` : `${zoneName} is under Mutiny!`;

  return (
    <button
      type="button"
      onClick={() => onSelect(top)}
      className="fixed left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold shadow-lg active:opacity-80"
      style={{ background: "#ff5a36", color: "#fff" }}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: "#fff", animation: "contest-pop 900ms ease-in-out infinite alternate" }}
      />
      {label}
      {actionable.length > 1 && (
        <span className="rounded-full px-1.5 py-0.5 text-xs" style={{ background: "rgba(0,0,0,0.2)" }}>
          +{actionable.length - 1}
        </span>
      )}
    </button>
  );
}
