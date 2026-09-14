"use client";

import { useEffect, useState } from "react";
import type { Player, Zone } from "@/lib/types";
import { playerById } from "@/lib/zones";
import Avatar from "./Avatar";
import GiftConfirmModal from "./GiftConfirmModal";
import PhotoLightbox from "./PhotoLightbox";
import { CloseIcon, CrownIcon, CrossedSwordsIcon } from "./icons";

interface ZoneDetailSheetProps {
  zone: Zone;
  players: Player[];
  currentPlayerId: string;
  onClose: () => void;
  onCapture: () => void;
  capturing?: boolean;
  // True when the current player is already a participant in this zone's
  // active contest (defending as the instant-capturer, or already joined
  // as a challenger) — they should jump back into it, not re-attempt.
  inContest?: boolean;
  onRejoinContest?: () => void;
  isAdmin?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  // True when this zone's owner rules more than one home zone — that's the
  // bar for the Crown badge, not just holding this one.
  ownerIsRuler?: boolean;
  // Zone Gifting — available on any zone the current player owns.
  onGift?: (toPlayerId: string) => void;
  gifting?: boolean;
  giftError?: string | null;
  // Uprising/Mutiny — only relevant while tier === "invaded". All the actual
  // starting/pledging/joining happens inside their own dedicated screens
  // (opened via these two) so a player can see who's already in before
  // committing — this component just decides when a card + its "View"
  // button should show at all.
  onViewUprising?: () => void;
  onViewMutiny?: () => void;
}

function relativeTime(timestamp: number): string {
  const hours = Math.round((Date.now() - timestamp) / 3600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

function eventLabel(event: Zone["history"][number], playerName: string, prevOwnerName: string | null): string {
  if (event.isHit) return `${playerName} hit the boss`;
  if (event.isPlunder) return `${playerName} plundered this zone${prevOwnerName ? ` from ${prevOwnerName}` : ""}`;
  if (event.isUprising) return `${playerName} reclaimed the throne in an Uprising`;
  if (event.isMutiny) return `${playerName} seized this zone in a Mutiny${prevOwnerName ? ` from ${prevOwnerName}` : ""}`;
  if (event.isGift) return `${playerName} received this zone as a gift${prevOwnerName ? ` from ${prevOwnerName}` : ""}`;
  return prevOwnerName ? `${playerName} took it from ${prevOwnerName}` : playerName;
}

export default function ZoneDetailSheet({
  zone,
  players,
  currentPlayerId,
  onClose,
  onCapture,
  capturing = false,
  inContest = false,
  onRejoinContest,
  isAdmin = false,
  onEdit,
  onDelete,
  deleting = false,
  ownerIsRuler = false,
  onGift,
  gifting = false,
  giftError = null,
  onViewUprising,
  onViewMutiny,
}: ZoneDetailSheetProps) {
  const [visible, setVisible] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [giftPickerOpen, setGiftPickerOpen] = useState(false);
  const [pendingGiftRecipient, setPendingGiftRecipient] = useState<Player | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const owner = playerById(players, zone.ownerId);
  const isOwnZone = zone.ownerId === currentPlayerId;
  const isOriginalOwner = zone.originalOwnerId === currentPlayerId;
  const displayName = zone.nickname ?? zone.name;
  const history = [...zone.history].sort((a, b) => b.timestamp - a.timestamp);

  const isHome = zone.tier === "home";
  const isInvaded = zone.tier === "invaded";
  const bossHp = zone.bossHp ?? 0;
  const bossMaxHp = zone.bossMaxHp ?? 0;
  const onCooldown = Boolean(zone.myCooldownUntil && zone.myCooldownUntil > now);
  const mustWaitForBackup = zone.lastAttackerId === currentPlayerId;

  const hasActiveUprising = Boolean(zone.activeUprisingId);
  // The original owner is always an Uprising's starter — start_uprising only
  // ever lets them start one against their own invaded zone. The card (and
  // its "View"/"Rally" button into the dedicated screen) shows to them even
  // before one exists; everyone else only sees it once one's underway.
  const uprisingStarter = playerById(players, zone.originalOwnerId);
  const showUprisingCard = isInvaded && (hasActiveUprising || isOriginalOwner);

  const hasActiveMutiny = Boolean(zone.activeMutinyId);
  const mutinyStarter = playerById(players, zone.activeMutinyInstigatorId);
  const iAmMutinyStarter = zone.activeMutinyInstigatorId === currentPlayerId;
  // Same idea as Uprising above, mirrored for whoever's actually eligible to
  // rally a Mutiny (anyone but the original owner or the current holder).
  const showMutinyCard = isInvaded && (hasActiveMutiny || (!isOriginalOwner && !isOwnZone));
  const otherPlayers = players.filter((p) => p.id !== currentPlayerId && !p.isAdmin);

  return (
    <div className="fixed inset-0 z-30 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full rounded-t-[28px] border-t p-6 pb-8 transition-transform duration-200 ease-out"
        style={{
          background: "rgba(12, 12, 12, 0.8)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
          borderColor: "var(--border-container)",
          maxHeight: "78vh",
          overflowY: "auto",
          transform: visible ? "translateY(0)" : "translateY(100%)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>

        <div className="flex items-center gap-2 pr-12">
          {isHome && (
            <span
              className="rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider"
              style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
            >
              Home
            </span>
          )}
          {isInvaded && (
            <span
              className="rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider"
              style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
            >
              Invaded
            </span>
          )}
          {zone.activeContestId && zone.activeContestParticipantIds.length > 1 && (
            <span
              className="rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider"
              style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
            >
              Contested
            </span>
          )}
          <h2 className="text-2xl font-bold leading-tight" style={{ color: "var(--text-primary, #fff)" }}>
            {displayName}
          </h2>
        </div>
        {zone.nickname && (
          <p className="mt-1 text-sm" style={{ color: "var(--text-tertiary)" }}>
            {zone.name}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2.5">
          {owner ? (
            <>
              <Avatar player={owner} size={36} />
              <span className="text-base" style={{ color: "var(--text-secondary)" }}>
                Held by{" "}
                <span style={{ color: "var(--text-primary, #fff)" }}>{isOwnZone ? "you" : owner.name}</span>
              </span>
              {isHome && ownerIsRuler && <CrownIcon size={16} className="text-[#ffd60a]" />}
              {isInvaded && <CrossedSwordsIcon size={16} className="text-[#ff8a68]" />}
            </>
          ) : (
            <span className="text-base" style={{ color: "var(--text-tertiary)" }}>
              Unclaimed
            </span>
          )}
        </div>

        {isHome && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                HP
              </h3>
              <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                {bossHp} / {bossMaxHp}
              </span>
            </div>
            <div className="mt-1.5 flex gap-1">
              {Array.from({ length: bossMaxHp }, (_, i) => (
                <div
                  key={i}
                  className="h-2 flex-1 rounded-full"
                  style={{ background: i < bossHp ? "#ff5a36" : "var(--surface-hover-active)" }}
                />
              ))}
            </div>
          </div>
        )}

        {showUprisingCard && (
          <div
            className="mt-4 rounded-2xl border px-4 py-3"
            style={{ borderColor: "rgba(255,214,10,0.35)", background: "rgba(255,214,10,0.08)" }}
          >
            {hasActiveUprising ? (
              <>
                <p className="text-sm font-semibold" style={{ color: "#ffd60a" }}>
                  {isOriginalOwner ? "Rallying support for your return" : `Rallying support for ${uprisingStarter?.name ?? "someone"}'s return`}
                </p>
                {zone.activeUprisingDeadline && (
                  <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                    Closes in {countdown(zone.activeUprisingDeadline, now)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm font-semibold" style={{ color: "#ffd60a" }}>
                No Uprising against this zone yet
              </p>
            )}
            <button
              type="button"
              onClick={onViewUprising}
              className="mt-2.5 h-11 w-full rounded-xl text-sm font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
              style={{ background: "#ffd60a", color: "#0a0a0a" }}
            >
              {hasActiveUprising ? "View Uprising" : "Rally an Uprising"}
            </button>
          </div>
        )}

        {showMutinyCard && (
          <div
            className="mt-4 rounded-2xl border px-4 py-3"
            style={{ borderColor: "rgba(255,90,54,0.35)", background: "rgba(255,90,54,0.08)" }}
          >
            {hasActiveMutiny ? (
              <>
                <p className="text-sm font-semibold" style={{ color: "#ff8a68" }}>
                  {zone.activeMutinyStatus === "dueling"
                    ? iAmMutinyStarter
                      ? "Your crew is dueling the incumbent for this zone!"
                      : `${mutinyStarter?.name ?? "Someone"}'s crew is dueling the incumbent for this zone!`
                    : iAmMutinyStarter
                      ? "You're recruiting a crew to storm this zone"
                      : `${mutinyStarter?.name ?? "Someone"} is recruiting a crew to storm this zone`}
                </p>
                {zone.activeMutinyRallyDeadline && (
                  <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                    Closes in {countdown(zone.activeMutinyRallyDeadline, now)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm font-semibold" style={{ color: "#ff8a68" }}>
                No Mutiny against this zone yet
              </p>
            )}
            <button
              type="button"
              onClick={onViewMutiny}
              className="mt-2.5 h-11 w-full rounded-xl text-sm font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
              style={{ background: "#ff5a36", color: "#fff" }}
            >
              {hasActiveMutiny ? "View Mutiny" : "Rally a Mutiny"}
            </button>
          </div>
        )}

        <div className="mt-6">
          <h3
            className="text-xs font-bold uppercase tracking-wider"
            style={{ color: "var(--text-tertiary)" }}
          >
            Places here
          </h3>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {zone.places.map((place) => (
              <span
                key={place.id}
                className="rounded-full border px-4 py-2 text-sm"
                style={{ borderColor: "var(--border-container)", color: "var(--text-secondary)" }}
              >
                {place.name}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <h3
            className="text-xs font-bold uppercase tracking-wider"
            style={{ color: "var(--text-tertiary)" }}
          >
            Log
          </h3>
          <div className="mt-2.5 flex flex-col divide-y divide-[var(--border-divider)]">
            {history.length === 0 && (
              <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
                No captures yet. Be the first.
              </p>
            )}
            {history.map((event) => {
              const player = playerById(players, event.playerId);
              const prevOwner = playerById(players, event.previousOwnerId);
              if (!player) return null;
              const playerName = event.playerId === currentPlayerId ? "You" : player.name;
              const prevOwnerName =
                event.previousOwnerId === currentPlayerId ? "you" : prevOwner?.name ?? null;
              return (
                <div key={event.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Avatar player={player} size={36} />
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                        <span style={{ color: "var(--text-primary, #fff)" }}>
                          {eventLabel(event, playerName, prevOwnerName)}
                        </span>
                        {" · "}
                        {event.placeName}
                        {" · "}
                        <span style={{ color: "var(--text-tertiary)" }}>{relativeTime(event.timestamp)}</span>
                      </p>
                      <p className="text-base" style={{ color: "var(--text-primary, #fff)" }}>
                        {event.caption}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
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

        {/* ─── Primary action ─── */}
        {/* Invaded zones do all their acting through the cards above (each
            opens its own screen) — this stays purely informational, same
            styling as the plain "you already hold this zone" text below. */}
        {isInvaded ? (
          <p
            className="mt-7 text-center text-sm font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-tertiary)" }}
          >
            {isOwnZone ? "You already hold this zone" : "Use the cards above to get involved"}
          </p>
        ) : isOwnZone ? (
          <p
            className="mt-7 text-center text-sm font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-tertiary)" }}
          >
            You already hold this zone
          </p>
        ) : inContest ? (
          // Checked before the regular-zone fallback: the original
          // instant-capturer already owns the zone while their contest
          // plays out, but that ownership isn't settled yet — they need
          // back into the fight, not a message implying nothing's left.
          <button
            type="button"
            onClick={onRejoinContest}
            className="mt-7 h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
            style={{ background: "#ffffff", color: "#0a0a0a" }}
          >
            Back to the fight
          </button>
        ) : (
          <button
            type="button"
            onClick={onCapture}
            disabled={capturing || (isHome && (mustWaitForBackup || onCooldown))}
            className="mt-7 h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
            style={{ background: "#ffffff", color: "#0a0a0a" }}
          >
            {capturing
              ? "Starting…"
              : isHome
                ? mustWaitForBackup
                  ? "Wait for backup"
                  : onCooldown
                    ? "On cooldown"
                    : "Attack"
                : !zone.activeContestId
                  ? "Capture"
                  : zone.activeContestStatus === "joining"
                    ? "Join the fight"
                    : "Spectate"}
          </button>
        )}

        {/* ─── Zone Gifting — any owner, any tier ─── */}
        {isOwnZone && onGift && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setGiftPickerOpen((v) => !v)}
              className="h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
              style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
            >
              Gift this Zone
            </button>
            {giftPickerOpen && (
              <div className="mt-3 flex flex-col gap-2 rounded-2xl border p-3" style={{ borderColor: "var(--border-container)" }}>
                {otherPlayers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={gifting}
                    onClick={() => setPendingGiftRecipient(p)}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 disabled:opacity-40 active:opacity-80"
                    style={{ background: "var(--surface-1)" }}
                  >
                    <Avatar player={p} size={28} />
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary, #fff)" }}>
                      {p.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {giftError && (
              <p className="mt-2 text-sm font-medium" style={{ color: "#ff6a6a" }}>
                {giftError}
              </p>
            )}
          </div>
        )}

        {isAdmin && (
          <button
            type="button"
            onClick={onEdit}
            className="mt-3 h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
            style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          >
            Edit Zone
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="mt-3 h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
            style={{ background: "rgba(255,90,54,0.15)", color: "#ff8a68" }}
          >
            {deleting ? "Deleting…" : "Delete Zone"}
          </button>
        )}
      </div>

      {lightboxUrl && <PhotoLightbox src={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
      {pendingGiftRecipient && onGift && (
        <GiftConfirmModal
          zoneName={zone.nickname ?? zone.name}
          recipient={pendingGiftRecipient}
          onConfirm={() => {
            onGift(pendingGiftRecipient.id);
            setPendingGiftRecipient(null);
          }}
          onCancel={() => setPendingGiftRecipient(null)}
        />
      )}
    </div>
  );
}
