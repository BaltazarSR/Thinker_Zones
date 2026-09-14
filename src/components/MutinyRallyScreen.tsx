"use client";

import { useEffect, useState } from "react";
import type { Mutiny, Player, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

interface MutinyRallyScreenProps {
  zone: Zone;
  // null before anyone's started one yet — the screen still opens so the
  // eligible player can start it from in here.
  mutiny: Mutiny | null;
  players: Player[];
  currentPlayerId: string;
  onStart: () => void;
  onJoin: () => void;
  onClose: () => void;
  submitting?: boolean;
  error?: string | null;
  // Admin-only escape hatch for when a Mutiny needs manual intervention.
  isAdmin?: boolean;
  onCancel?: () => void;
  cancelling?: boolean;
  cancelError?: string | null;
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

export default function MutinyRallyScreen({
  zone,
  mutiny,
  players,
  currentPlayerId,
  onStart,
  onJoin,
  onClose,
  submitting = false,
  error = null,
  isAdmin = false,
  onCancel,
  cancelling = false,
  cancelError = null,
}: MutinyRallyScreenProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const isBlocked = currentPlayerId === zone.ownerId || currentPlayerId === zone.originalOwnerId;
  const instigator = mutiny ? playerById(players, mutiny.instigatorId) : null;
  const crew = mutiny ? mutiny.crewIds.map((id) => playerById(players, id)).filter((p): p is Player => Boolean(p)) : [];
  const alreadyIn = Boolean(mutiny && (currentPlayerId === mutiny.instigatorId || mutiny.crewIds.includes(currentPlayerId)));
  const canJoin = Boolean(mutiny && mutiny.status === "rallying" && !alreadyIn && !isBlocked);
  const canStart = !mutiny && !isBlocked;

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Mutiny!
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
        {mutiny ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#ff8a68" }}>
              Rally closes in {countdown(mutiny.rallyDeadline, now)}
            </p>

            <h3 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
              Duel order
            </h3>
            <div className="mt-2.5 flex flex-col gap-2">
              {crew.map((p, i) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                  style={{ borderColor: "var(--border-container)" }}
                >
                  <span className="w-5 text-center text-sm font-bold" style={{ color: "var(--text-tertiary)" }}>
                    {i + 1}
                  </span>
                  <Avatar player={p} size={28} />
                  <span className="text-sm font-medium" style={{ color: "var(--text-primary, #fff)" }}>
                    {p.name}
                  </span>
                </div>
              ))}
              {instigator && (
                <div
                  className="flex items-center gap-3 rounded-xl border-2 px-3 py-2.5"
                  style={{ borderColor: "#ff5a36", background: "rgba(255,90,54,0.1)" }}
                >
                  <span className="w-5 text-center text-sm font-bold" style={{ color: "#ff8a68" }}>
                    {crew.length + 1}
                  </span>
                  <Avatar player={instigator} size={28} />
                  <span className="text-sm font-medium" style={{ color: "#ff8a68" }}>
                    {instigator.name}
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            No Mutiny against this zone yet.
          </p>
        )}
      </div>

      {(canJoin || canStart || (isAdmin && mutiny)) && (
        <div className="flex flex-col gap-3 p-5 pt-4">
          {error && (
            <p className="text-sm font-medium" style={{ color: "#ff6a6a" }}>
              {error}
            </p>
          )}
          {(canJoin || canStart) && (
            <button
              type="button"
              disabled={submitting}
              onClick={canStart ? onStart : onJoin}
              className="h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
              style={{ background: "#ffffff", color: "#0a0a0a" }}
            >
              {submitting ? (canStart ? "Starting…" : "Joining…") : canStart ? "Rally a Mutiny" : "Join the Mutiny"}
            </button>
          )}
          {isAdmin && mutiny && (
            <>
              {cancelError && (
                <p className="text-sm font-medium" style={{ color: "#ff6a6a" }}>
                  {cancelError}
                </p>
              )}
              <button
                type="button"
                disabled={cancelling}
                onClick={onCancel}
                className="h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
                style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
              >
                {cancelling ? "Cancelling…" : "Cancel Mutiny (Admin)"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
