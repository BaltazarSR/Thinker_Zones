"use client";

import type { ActiveContestSummary, Zone } from "@/lib/types";

interface ContestAlertBannerProps {
  alerts: ActiveContestSummary[];
  zones: Zone[];
  onSelect: (alert: ActiveContestSummary) => void;
}

// Not a full-screen overlay — a persistent pill that surfaces once
// something needs the player's attention in a contest whose screen they're
// not currently looking at (most commonly: they instant-captured a zone
// and walked away, then someone else contested it). Tapping it opens the
// right contest screen; it doesn't force an interrupt.
export default function ContestAlertBanner({ alerts, zones, onSelect }: ContestAlertBannerProps) {
  const actionable = alerts.filter((a) => a.needsAction !== "waiting");
  if (actionable.length === 0) return null;

  // Picks are time-boxed (30s forfeit) — surface those first, then a win
  // waiting to be claimed, then just "your zone's being contested" as the
  // lowest-urgency nudge (nothing to do yet, just worth knowing).
  const top =
    actionable.find((a) => a.needsAction === "needs_pick") ??
    actionable.find((a) => a.needsAction === "needs_proof") ??
    actionable.find((a) => a.needsAction === "contested") ??
    actionable[0];
  const zoneName = zones.find((z) => z.id === top.zoneId)?.name ?? "a zone";
  const label =
    top.needsAction === "needs_pick"
      ? `Your move. ${zoneName}`
      : top.needsAction === "needs_proof"
        ? `You won. Claim ${zoneName}`
        : `${zoneName} is being contested!`;

  return (
    <button
      type="button"
      onClick={() => onSelect(top)}
      className="fixed left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold shadow-lg active:opacity-80"
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
