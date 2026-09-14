"use client";

import { CrownIcon, CrossedSwordsIcon } from "./icons";

interface MutinyOutcomeScreenProps {
  title: string;
  message: string;
  // Controls color/icon — true for "good news for you" (defended, seized,
  // broke through), false for "bad news for you" (defeated, mutiny failed).
  positive: boolean;
  onDismiss: () => void;
}

// The role-specific "how did this turn out for me" beat — shown to the
// Mutiny incumbent (defended/defeated), instigator (seized the throne
// themselves or via a crew member), and crew members (broke through
// themselves or watched a teammate do it) once the Mutiny reaches a
// terminal state; to a player who loses a zone to a successful Uprising or
// a Boss Raid finishing blow; and to either side of a Zone Gift (sent/
// received). Reached only after any of the player's own duel reveals have
// already been shown, same layering as the regular contest system's
// per-match reveal followed by the tournament-level outcome.
export default function MutinyOutcomeScreen({ title, message, positive, onDismiss }: MutinyOutcomeScreenProps) {
  const accent = positive ? "#2ee66b" : "#ff6a6a";
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 px-6 text-center"
      style={{ background: "var(--background, #000)" }}
    >
      <div style={{ animation: "contest-pop 400ms ease-out", color: accent }}>
        {positive ? <CrownIcon size={72} /> : <CrossedSwordsIcon size={72} />}
      </div>
      <div>
        <p className="text-4xl font-black uppercase tracking-wide" style={{ color: accent }}>
          {title}
        </p>
        <p className="mt-3 text-lg" style={{ color: "var(--text-secondary)" }}>
          {message}
        </p>
      </div>

      <button
        type="button"
        onClick={onDismiss}
        className="mt-4 h-16 w-full max-w-xs rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
        style={{ background: "#ffffff", color: "#0a0a0a" }}
      >
        Back to Map
      </button>
    </div>
  );
}
