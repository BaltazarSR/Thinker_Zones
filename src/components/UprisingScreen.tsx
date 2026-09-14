"use client";

import { useEffect, useState } from "react";
import type { Player, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

interface UprisingScreenProps {
  zone: Zone;
  players: Player[];
  currentPlayerId: string;
  onStart: () => void;
  onPledge: () => void;
  onClose: () => void;
  submitting?: boolean;
  error?: string | null;
}

function countdown(deadline: number, now: number): string {
  const ms = deadline - now;
  if (ms <= 0) return "any moment now";
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 1) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export default function UprisingScreen({
  zone,
  players,
  currentPlayerId,
  onStart,
  onPledge,
  onClose,
  submitting = false,
  error = null,
}: UprisingScreenProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const hasActive = Boolean(zone.activeUprisingId);
  const isOriginalOwner = currentPlayerId === zone.originalOwnerId;
  const iAmPledged = zone.activeUprisingSupporterIds.includes(currentPlayerId);
  const supporters = zone.activeUprisingSupporterIds
    .map((id) => playerById(players, id))
    .filter((p): p is Player => Boolean(p));

  const canStart = !hasActive && isOriginalOwner;
  const canPledge = hasActive && !isOriginalOwner && currentPlayerId !== zone.ownerId && !iAmPledged;

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Uprising!
          </h2>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            {zone.nickname ?? zone.name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5">
        {hasActive ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#ffd60a" }}>
              {zone.activeUprisingSupporterCount}/{zone.activeUprisingThreshold} pledged
              {zone.activeUprisingDeadline ? ` · closes in ${countdown(zone.activeUprisingDeadline, now)}` : ""}
            </p>

            <h3 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
              Pledged so far
            </h3>
            <div className="mt-2.5 flex flex-col gap-2">
              {supporters.length === 0 && (
                <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
                  No one yet.
                </p>
              )}
              {supporters.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                  style={{ borderColor: "var(--border-container)" }}
                >
                  <Avatar player={p} size={28} />
                  <span className="text-sm font-medium" style={{ color: "var(--text-primary, #fff)" }}>
                    {p.name}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            No Uprising against this zone yet.
          </p>
        )}
      </div>

      {(canStart || canPledge) && (
        <div className="p-5 pt-4">
          {error && (
            <p className="mb-3 text-sm font-medium" style={{ color: "#ff6a6a" }}>
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={canStart ? onStart : onPledge}
            className="h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
            style={{ background: "#ffd60a", color: "#0a0a0a" }}
          >
            {submitting ? (canStart ? "Rallying…" : "Pledging…") : canStart ? "Start an Uprising" : "Pledge Support"}
          </button>
        </div>
      )}
    </div>
  );
}
