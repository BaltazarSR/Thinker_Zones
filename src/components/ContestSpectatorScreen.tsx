"use client";

import type { Contest, ContestMatch, Player, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import { CheckIcon, ChevronDownIcon, CloseIcon } from "./icons";

interface ContestSpectatorScreenProps {
  zone: Zone;
  contest: Contest;
  players: Player[];
  currentPlayerId: string;
  onClose: () => void;
}

function NodePlayer({
  player,
  isWinner,
  isLoser,
}: {
  player: Player;
  isWinner: boolean;
  isLoser: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Avatar player={player} size={22} ring />
      <span
        className="min-w-0 flex-1 truncate text-xs font-semibold"
        style={{
          color: isLoser ? "var(--text-tertiary)" : "var(--text-primary, #fff)",
          textDecoration: isLoser ? "line-through" : undefined,
        }}
      >
        {player.name}
      </span>
      {isWinner && (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
          style={{ background: "rgba(46,230,107,0.18)", color: "#2ee66b" }}
        >
          <CheckIcon size={10} />
        </span>
      )}
    </div>
  );
}

// A single bracket node — either a real match (two stacked mini player
// rows) or a bye (one row + a small tag). Sized to sit side by side with
// other nodes from the same round rather than stretch full-width, which is
// what actually makes this read as a bracket instead of a list.
function MatchNode({ match, players, currentPlayerId }: { match: ContestMatch; players: Player[]; currentPlayerId: string }) {
  const a = playerById(players, match.playerAId);
  const b = match.playerBId ? playerById(players, match.playerBId) : null;
  const resolved = match.resolvedAt !== null;
  const involvesMe = a?.id === currentPlayerId || b?.id === currentPlayerId;

  if (!a) return null;

  const cardStyle = {
    borderColor: involvesMe ? "#ff5a36" : "var(--border-container)",
    background: "var(--surface-1)",
  };

  if (!b) {
    return (
      <div className="flex w-[168px] shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2.5" style={cardStyle}>
        <Avatar player={a} size={22} ring />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: "var(--text-primary, #fff)" }}>
          {a.name}
        </span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-tertiary)" }}
        >
          Bye
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-[168px] shrink-0 flex-col gap-5 rounded-xl border px-3 py-3.5" style={cardStyle}>
      <NodePlayer player={a} isWinner={resolved && match.winnerId === a.id} isLoser={resolved && match.winnerId !== a.id} />
      <NodePlayer player={b} isWinner={resolved && match.winnerId === b.id} isLoser={resolved && match.winnerId !== b.id} />
    </div>
  );
}

function RoundConnector() {
  return (
    <div className="flex flex-col items-center py-1" style={{ color: "var(--text-tertiary)" }}>
      <div className="h-3 w-px" style={{ background: "var(--border-container)" }} />
      <ChevronDownIcon size={16} />
    </div>
  );
}

export default function ContestSpectatorScreen({ zone, contest, players, currentPlayerId, onClose }: ContestSpectatorScreenProps) {
  const amParticipant = contest.participantIds.includes(currentPlayerId);
  const amEliminated = contest.matches.some(
    (m) =>
      m.resolvedAt !== null &&
      m.winnerId !== currentPlayerId &&
      (m.playerAId === currentPlayerId || m.playerBId === currentPlayerId)
  );

  const statusLine = amEliminated
    ? "You've been eliminated, spectating"
    : amParticipant
      ? "Standing by for the next round…"
      : "This zone is being contested";

  const roundNumbers = [...new Set(contest.matches.map((m) => m.round))].sort((a, b) => a - b);

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Bracket
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
        <p className="mb-5 text-center text-sm font-semibold uppercase tracking-wider" style={{ color: "#ff5a36" }}>
          {statusLine}
        </p>

        <div className="flex flex-col items-center">
          {roundNumbers.map((round, i) => {
            const isCurrent = round === contest.currentRound;
            const roundMatches = contest.matches.filter((m) => m.round === round);
            return (
              <div key={round} className="flex w-full flex-col items-center">
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                    Round {round}
                  </span>
                  {isCurrent && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider"
                      style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
                    >
                      Live
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap justify-center gap-2.5">
                  {roundMatches.map((m) => (
                    <MatchNode key={m.id} match={m} players={players} currentPlayerId={currentPlayerId} />
                  ))}
                </div>
                {i < roundNumbers.length - 1 && <RoundConnector />}
              </div>
            );
          })}
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
