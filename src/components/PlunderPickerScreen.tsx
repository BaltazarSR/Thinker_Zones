"use client";

import { useEffect, useState } from "react";
import type { Player, Zone } from "@/lib/types";
import { CloseIcon } from "./icons";

const MAX_PLUNDER = 5;

interface PlunderPickerScreenProps {
  zoneName: string;
  fromPlayer: Player;
  eligibleZones: Zone[];
  deadline: number;
  onConfirm: (zoneIds: string[]) => void;
  onSkip: () => void;
  submitting?: boolean;
  error?: string | null;
}

export default function PlunderPickerScreen({
  zoneName,
  fromPlayer,
  eligibleZones,
  deadline,
  onConfirm,
  onSkip,
  submitting = false,
  error = null,
}: PlunderPickerScreenProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const toggle = (zoneId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) {
        next.delete(zoneId);
      } else if (next.size < MAX_PLUNDER) {
        next.add(zoneId);
      }
      return next;
    });
  };

  const minutesLeft = Math.max(1, Math.round((deadline - now) / 60_000));

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Choose Your Spoils
          </h2>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            You dethroned {fromPlayer.name} from {zoneName}. Pick up to {MAX_PLUNDER} more of their zones to take
            too. Offer closes in {minutesLeft}m.
          </p>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5">
        {eligibleZones.length === 0 ? (
          <p className="mt-6 text-sm" style={{ color: "var(--text-tertiary)" }}>
            {fromPlayer.name} has no other zones left to plunder.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            {eligibleZones.map((zone) => {
              const isSelected = selected.has(zone.id);
              const disabled = !isSelected && selected.size >= MAX_PLUNDER;
              return (
                <button
                  key={zone.id}
                  type="button"
                  onClick={() => toggle(zone.id)}
                  disabled={disabled}
                  className="flex items-center justify-between rounded-2xl border-2 px-4 py-4 text-left transition-colors duration-150 active:opacity-80 disabled:opacity-40"
                  style={{
                    borderColor: isSelected ? "#ff5a36" : "var(--border-container)",
                    background: isSelected ? "rgba(255,90,54,0.15)" : "var(--surface-1)",
                  }}
                >
                  <div className="min-w-0">
                    <p
                      className="truncate text-base font-bold"
                      style={{ color: isSelected ? "#ff8a68" : "var(--text-primary, #fff)" }}
                    >
                      {zone.nickname ?? zone.name}
                    </p>
                    {zone.nickname && (
                      <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                        {zone.name}
                      </p>
                    )}
                  </div>
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2"
                    style={{
                      borderColor: isSelected ? "#ff5a36" : "var(--border-container)",
                      background: isSelected ? "#ff5a36" : "transparent",
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-5 pt-4">
        {error && (
          <p className="mb-3 text-sm font-medium" style={{ color: "#ff6a6a" }}>
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => onConfirm(Array.from(selected))}
          className="h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          {submitting ? "Claiming…" : selected.size > 0 ? `Claim ${selected.size} Zone${selected.size === 1 ? "" : "s"}` : "Take Nothing Else"}
        </button>
      </div>
    </div>
  );
}
