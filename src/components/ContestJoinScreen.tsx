"use client";

import { useEffect, useState } from "react";
import type { Contest, Player, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

interface ContestJoinScreenProps {
  zone: Zone;
  contest: Contest;
  players: Player[];
  onClose: () => void;
}

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function ContestJoinScreen({ zone, contest, players, onClose }: ContestJoinScreenProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const participants = contest.participantIds.map((id) => playerById(players, id)).filter((p): p is Player => !!p);
  const msRemaining = contest.joinDeadline - now;

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Contest opened
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

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
        <div>
          <p className="text-sm font-bold uppercase tracking-wider" style={{ color: "#ff5a36" }}>
            You&apos;re in
          </p>
          <p className="mt-4 font-mono text-6xl font-bold tabular-nums" style={{ color: "var(--text-primary, #fff)" }}>
            {formatCountdown(msRemaining)}
          </p>
          <p className="mt-3 text-base" style={{ color: "var(--text-secondary)" }}>
            When the timer hits zero, everyone who joined fights it out for the zone.
          </p>
        </div>

        <div>
          <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            {participants.length === 1 ? "Only you, so far" : `${participants.length} players in`}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
            {participants.map((p) => (
              <Avatar key={p.id} player={p} size={52} ring />
            ))}
          </div>
        </div>
      </div>

      <div className="p-5 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide active:opacity-80"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
        >
          Keep exploring
        </button>
      </div>
    </div>
  );
}
