"use client";

import { useMemo, useState } from "react";
import type { Player, Zone } from "@/lib/types";
import { homeZonesRuledCount, playerById, zonesHeldCount } from "@/lib/zones";
import Avatar from "./Avatar";
import PhotoLightbox from "./PhotoLightbox";
import { CrownIcon } from "./icons";

interface LeaderboardSectionProps {
  zones: Zone[];
  players: Player[];
  onPlayerClick?: (playerId: string) => void;
}

function relativeTime(timestamp: number): string {
  const hours = Math.round((Date.now() - timestamp) / 3600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function LeaderboardSection({ zones, players, onPlayerClick }: LeaderboardSectionProps) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const rulerIds = useMemo(
    () => new Set(players.filter((p) => homeZonesRuledCount(p.id, zones) > 1).map((p) => p.id)),
    [players, zones]
  );

  const ranked = useMemo(() => {
    const sorted = players
      .filter((player) => !player.isAdmin)
      .map((player) => ({ player, count: zonesHeldCount(player.id, zones) }))
      .sort((a, b) => b.count - a.count);

    let place = 0;
    let previousCount: number | null = null;
    const result: { player: Player; count: number; place: number }[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      if (entry.count !== previousCount) {
        place = i + 1;
        previousCount = entry.count;
      }
      result.push({ ...entry, place });
    }
    return result;
  }, [zones, players]);
  const topGroup = ranked.filter((entry) => entry.place === 1);
  const rest = ranked.filter((entry) => entry.place !== 1);
  const isTopTied = topGroup.length > 1;

  const feed = useMemo(() => {
    const entries = zones.flatMap((zone) => zone.history.map((event) => ({ event, zone })));
    entries.sort((a, b) => b.event.timestamp - a.event.timestamp);
    return entries.slice(0, 5);
  }, [zones]);

  return (
    <div id="leaderboard-section" style={{ background: "var(--background, #000)" }}>
      <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
        <h1
          className="text-3xl font-extrabold uppercase italic tracking-wide"
          style={{ color: "var(--text-primary, #fff)" }}
        >
          Standings
        </h1>

        {topGroup.length > 0 && topGroup[0].count > 0 && (
          <div
            className="relative mt-5 w-full overflow-hidden rounded-3xl border p-5 text-left"
            style={{
              borderColor: isTopTied ? "#ffffff55" : `${topGroup[0].player.color}55`,
              background: isTopTied
                ? "linear-gradient(135deg, #ffffff26, var(--surface-1) 65%)"
                : `linear-gradient(135deg, ${topGroup[0].player.color}26, var(--surface-1) 65%)`,
            }}
          >
            <div className="flex items-center gap-4">
              {isTopTied ? (
                <div className="flex -space-x-4">
                  {topGroup.map((entry) => (
                    <button
                      key={entry.player.id}
                      type="button"
                      onClick={() => onPlayerClick?.(entry.player.id)}
                      className="rounded-full active:opacity-80"
                      style={{ boxShadow: "0 0 0 3px var(--surface-1)" }}
                    >
                      <Avatar player={entry.player} size={56} />
                    </button>
                  ))}
                </div>
              ) : (
                <button type="button" onClick={() => onPlayerClick?.(topGroup[0].player.id)}>
                  <Avatar player={topGroup[0].player} size={68} ring />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <p
                  className="text-xs font-extrabold uppercase tracking-widest"
                  style={{ color: isTopTied ? "var(--text-tertiary)" : topGroup[0].player.color }}
                >
                  {isTopTied ? (
                    "Tied for 1st"
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <CrownIcon size={14} className="-translate-y-[0.5px]" />
                      <span>Gober</span>
                    </span>
                  )}
                </p>
                <p className="truncate text-2xl font-extrabold" style={{ color: "var(--text-primary, #fff)" }}>
                  {topGroup.map((entry) => entry.player.name).join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-extrabold" style={{ color: "var(--text-primary, #fff)" }}>
                  {topGroup[0].count}
                </p>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                  {topGroup[0].count === 1 ? "zone" : "zones"}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {rest.map(({ player, count, place }) => {
            const rank = place;
            return (
              <button
                key={player.id}
                type="button"
                onClick={() => onPlayerClick?.(player.id)}
                className="flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left active:opacity-80"
                style={{ borderColor: "var(--border-container)", background: "var(--surface-1)" }}
              >
                <span className="w-7 text-center text-base font-bold" style={{ color: "var(--text-tertiary)" }}>
                  {rank}
                </span>
                <Avatar player={player} size={40} />
                <span className="flex flex-1 items-center gap-1.5 text-lg font-medium" style={{ color: "var(--text-primary, #fff)" }}>
                  {rulerIds.has(player.id) && <CrownIcon size={14} className="text-[#ffd60a]" />}
                  {player.name}
                </span>
                <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                  {count} zone{count === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
        </div>

        <h2 className="mt-9 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Recent captures
        </h2>
        <div className="mt-3 flex flex-col gap-2.5">
          {feed.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
              No captures yet.
            </p>
          )}
          {feed.map(({ event, zone }) => {
            const player = playerById(players, event.playerId);
            if (!player) return null;
            return (
              <div
                key={event.id}
                className="rounded-2xl border p-4"
                style={{ borderColor: `${player.color}66`, background: "var(--surface-1)" }}
              >
                <div className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-lg font-bold leading-tight"
                      style={{ color: "var(--text-primary, #fff)" }}
                    >
                      {zone.nickname ?? zone.name}
                    </p>
                    <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      {event.placeName}
                    </p>
                    <p className="mt-2 text-base" style={{ color: "var(--text-secondary)" }}>
                      {event.caption}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <Avatar player={player} size={20} />
                      <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                        {player.name}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      {relativeTime(event.timestamp)}
                    </span>
                    {event.photoUrl && (
                      <button
                        type="button"
                        onClick={() => setLightboxUrl(event.photoUrl)}
                        className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border active:opacity-80"
                        style={{ borderColor: "var(--border-container)" }}
                        aria-label="View capture photo"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={event.photoUrl} alt="Capture" className="h-full w-full object-cover" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {lightboxUrl && <PhotoLightbox src={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
