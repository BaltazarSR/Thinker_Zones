"use client";

import type { Zone } from "@/lib/types";
import { CrownIcon } from "./icons";

interface ContestVictoryScreenProps {
  zone: Zone;
  // true when the winner already owned the zone (successfully defended —
  // no new proof needed, since their existing capture already stands).
  defended: boolean;
  onContinue: () => void;
}

// Shown once, right after the winning match resolves. For a fresh win it's
// a beat before funneling into the (shared with the direct-capture path)
// CaptureFlow to submit proof; for a successful defense there's no proof
// step at all, so this is the entire "you won" moment.
export default function ContestVictoryScreen({ zone, defended, onContinue }: ContestVictoryScreenProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 px-6 text-center"
      style={{ background: "var(--background, #000)" }}
    >
      <div style={{ animation: "contest-pop 400ms ease-out", color: "#ffd60a" }}>
        <CrownIcon size={72} />
      </div>
      <div>
        <p className="text-4xl font-black uppercase tracking-wide" style={{ color: "#2ee66b" }}>
          {defended ? "Defended!" : "You won!"}
        </p>
        <p className="mt-3 text-lg" style={{ color: "var(--text-secondary)" }}>
          {defended
            ? `Nobody could take ${zone.nickname ?? zone.name} from you.`
            : `Everyone else is out. ${zone.nickname ?? zone.name} is yours to claim.`}
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-4 h-16 w-full max-w-xs rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
        style={{ background: "#ffffff", color: "#0a0a0a" }}
      >
        {defended ? "Nice!" : "Claim the zone"}
      </button>
    </div>
  );
}
