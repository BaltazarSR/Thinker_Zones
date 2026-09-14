"use client";

import { useEffect, useRef, useState } from "react";
import type { ContestMatch, Player, RpsMove, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import { CloseIcon, PaperIcon, RockIcon, ScissorsIcon } from "./icons";

interface ContestFightScreenProps {
  zone: Zone;
  match: ContestMatch;
  players: Player[];
  currentPlayerId: string;
  onPick: (move: RpsMove) => void;
  // Present (and called) only once `match` is resolved — lets the win/lose
  // reveal sit on screen until the player taps through it, instead of the
  // parent silently swapping in whatever's next (a new match, spectating,
  // elimination) the instant the server resolves things.
  onContinue?: () => void;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
  // Lets Mutiny duels (which reuse this screen — a duel's shape is
  // identical to ContestMatch) read as "Mutiny!" instead of a regular
  // zone's "Fight!".
  title?: string;
}

const MOVES: { move: RpsMove; label: string; Icon: (props: { size?: number }) => React.JSX.Element }[] = [
  { move: "rock", label: "Rock", Icon: RockIcon },
  { move: "paper", label: "Paper", Icon: PaperIcon },
  { move: "scissors", label: "Scissors", Icon: ScissorsIcon },
];

const MOVE_ICON: Record<RpsMove, (props: { size?: number }) => React.JSX.Element> = {
  rock: RockIcon,
  paper: PaperIcon,
  scissors: ScissorsIcon,
};

function formatCountdown(msRemaining: number): string {
  return Math.max(0, Math.ceil(msRemaining / 1000)).toString();
}

export default function ContestFightScreen({
  zone,
  match,
  players,
  currentPlayerId,
  onPick,
  onContinue,
  submitting = false,
  error = null,
  onClose,
  title = "Fight!",
}: ContestFightScreenProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // The server clears both moves and bumps tie_count in place on a tie —
  // there's no "resolvedAt" moment to key off of for that case, so this
  // watches for tie_count increasing to flash a brief banner before the
  // picker reappears.
  const prevTieCount = useRef(match.tieCount);
  const [showTie, setShowTie] = useState(false);
  useEffect(() => {
    if (match.tieCount > prevTieCount.current) {
      setShowTie(true);
      const id = setTimeout(() => setShowTie(false), 1600);
      prevTieCount.current = match.tieCount;
      return () => clearTimeout(id);
    }
    prevTieCount.current = match.tieCount;
  }, [match.tieCount]);

  const amPlayerA = match.playerAId === currentPlayerId;
  const opponentId = amPlayerA ? match.playerBId : match.playerAId;
  const opponent = playerById(players, opponentId);
  const me = playerById(players, currentPlayerId);
  const resolved = match.resolvedAt !== null;
  const iWon = resolved && match.winnerId === currentPlayerId;
  const msRemaining = match.pickDeadline !== null ? match.pickDeadline - now : null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            {title}
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

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        {opponent && me && (
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-center gap-1.5">
              <Avatar player={me} size={64} ring />
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary, #fff)" }}>
                You
              </span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <div className="flex h-16 items-center justify-center text-xl font-black italic" style={{ color: "#ff5a36" }}>
                VS
              </div>
              <span className="text-sm opacity-0" aria-hidden="true">
                &nbsp;
              </span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Avatar player={opponent} size={64} ring />
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary, #fff)" }}>
                {opponent.name}
              </span>
            </div>
          </div>
        )}

        {showTie ? (
          <div key={match.tieCount} className="flex flex-col items-center gap-2" style={{ animation: "contest-pop 300ms ease-out" }}>
            <p className="text-3xl font-black uppercase tracking-wide" style={{ color: "#ffd60a" }}>
              Tie!
            </p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Go again.
            </p>
          </div>
        ) : resolved ? (
          <div className="flex flex-col items-center gap-3" style={{ animation: "contest-pop 300ms ease-out" }}>
            <div className="flex items-center gap-5" style={{ color: "var(--text-primary, #fff)" }}>
              {match.myMove ? (
                (() => {
                  const MyIcon = MOVE_ICON[match.myMove];
                  return <MyIcon size={48} />;
                })()
              ) : (
                <span className="text-3xl font-bold" style={{ color: "var(--text-tertiary)" }}>
                  —
                </span>
              )}
              <span className="text-lg font-bold" style={{ color: "var(--text-tertiary)" }}>
                vs
              </span>
              {match.opponentMove ? (
                (() => {
                  const OpponentIcon = MOVE_ICON[match.opponentMove];
                  return <OpponentIcon size={48} />;
                })()
              ) : (
                <span className="text-3xl font-bold" style={{ color: "var(--text-tertiary)" }}>
                  —
                </span>
              )}
            </div>
            <p
              className="text-3xl font-black uppercase tracking-wide"
              style={{ color: iWon ? "#2ee66b" : "#ff6a6a" }}
            >
              {iWon ? "You win!" : "Eliminated"}
            </p>
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                className="mt-3 h-14 rounded-2xl px-10 text-base font-bold uppercase tracking-wide active:opacity-80"
                style={{ background: "#ffffff", color: "#0a0a0a" }}
              >
                Continue
              </button>
            )}
          </div>
        ) : match.myMove ? (
          <>
            <p className="text-lg font-semibold" style={{ color: "var(--text-secondary)" }}>
              Waiting for {opponent?.name ?? "opponent"}…
            </p>
            {msRemaining !== null && (
              <p className="font-mono text-2xl font-bold tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                0:{formatCountdown(msRemaining).padStart(2, "0")}
              </p>
            )}
            <div className="grid grid-cols-3 gap-3">
              {MOVES.map(({ move, label, Icon }) => {
                const selected = match.myMove === move;
                return (
                  <div
                    key={move}
                    className="flex h-24 w-24 flex-col items-center justify-center gap-2 rounded-3xl border-2"
                    style={{
                      borderColor: selected ? "#ff5a36" : "var(--border-container)",
                      background: selected ? "rgba(255,90,54,0.15)" : "var(--surface-1)",
                      color: selected ? "#ff8a68" : "var(--text-tertiary)",
                      opacity: selected ? 1 : 0.4,
                    }}
                    aria-label={label}
                  >
                    <Icon size={32} />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <p className="text-lg font-semibold" style={{ color: "var(--text-secondary)" }}>
              Pick your move
            </p>
            {msRemaining !== null && (
              <p className="font-mono text-2xl font-bold tabular-nums" style={{ color: "#ff5a36" }}>
                0:{formatCountdown(msRemaining).padStart(2, "0")}
              </p>
            )}
            <div className="grid grid-cols-3 gap-3">
              {MOVES.map(({ move, label, Icon }) => (
                <button
                  key={move}
                  type="button"
                  disabled={submitting}
                  onClick={() => onPick(move)}
                  className="flex h-24 w-24 flex-col items-center justify-center gap-2 rounded-3xl border-2 transition-transform duration-150 active:scale-90 disabled:opacity-40"
                  style={{ borderColor: "var(--border-container)", background: "var(--surface-1)", color: "var(--text-primary, #fff)" }}
                  aria-label={label}
                >
                  <Icon size={32} />
                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                    {label}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p className="text-sm font-medium" style={{ color: "#ff6a6a" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
