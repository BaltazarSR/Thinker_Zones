"use client";

import type { Player } from "@/lib/types";
import Avatar from "./Avatar";
import { CrownIcon } from "./icons";

interface UprisingResultScreenProps {
  player: Player;
  zoneName: string;
  onDismiss: () => void;
}

export default function UprisingResultScreen({ player, zoneName, onDismiss }: UprisingResultScreenProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-7 p-6"
      style={{ background: "var(--background, #000)" }}
      onClick={onDismiss}
    >
      <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider" style={{ color: "#ffd60a" }}>
        <CrownIcon size={16} />
        Throne Reclaimed
      </p>

      <Avatar player={player} size={140} ring />

      <div className="text-center">
        <p className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
          {zoneName}
        </p>
        <p className="mt-2 text-lg" style={{ color: "var(--text-secondary)" }}>
          The Uprising succeeded.
        </p>
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
