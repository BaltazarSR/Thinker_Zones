"use client";

import type { Player, Zone } from "@/lib/types";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

interface ContestWaitingOnWinnerScreenProps {
  zone: Zone;
  winner: Player;
  onClose: () => void;
}

export default function ContestWaitingOnWinnerScreen({ zone, winner, onClose }: ContestWaitingOnWinnerScreenProps) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-end p-5 pb-4">
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

      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
        <Avatar player={winner} size={100} ring />
        <div>
          <p className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            {winner.name} won the fight
          </p>
          <p className="mt-2 text-base" style={{ color: "var(--text-secondary)" }}>
            Capturing {zone.nickname ?? zone.name}…
          </p>
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
