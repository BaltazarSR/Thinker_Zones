"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MapView, { type EditingZoneInput, type MapZoneInput, type ZoneDraft } from "./MapView";
import ZoneDetailSheet from "./ZoneDetailSheet";
import CaptureFlow from "./CaptureFlow";
import CaptureResult from "./CaptureResult";
import PlunderPickerScreen from "./PlunderPickerScreen";
import MutinyRallyScreen from "./MutinyRallyScreen";
import MutinyOutcomeScreen from "./MutinyOutcomeScreen";
import UprisingScreen from "./UprisingScreen";
import CursedModal from "./CursedModal";
import LocationRequiredModal from "./LocationRequiredModal";
import UprisingResultScreen from "./UprisingResultScreen";
import ContestJoinScreen from "./ContestJoinScreen";
import ContestFightScreen from "./ContestFightScreen";
import ContestSpectatorScreen from "./ContestSpectatorScreen";
import ContestWaitingOnWinnerScreen from "./ContestWaitingOnWinnerScreen";
import ContestVictoryScreen from "./ContestVictoryScreen";
import ContestAlertBanner from "./ContestAlertBanner";
import MutinyAlertBanner from "./MutinyAlertBanner";
import LeaderboardSection from "./LeaderboardSection";
import PlayerProfile from "./PlayerProfile";
import CreateZoneForm from "./CreateZoneForm";
import SettingsScreen from "./SettingsScreen";
import { ChevronDownIcon } from "./icons";
import { NEUTRAL_ZONE_COLOR } from "@/lib/constants";
import { isPointInPolygon, polygonCentroid } from "@/lib/geo";
import { getCurrentPosition, LocationError } from "@/lib/location";
import { homeZonesRuledCount, playerById } from "@/lib/zones";
import {
  fetchContest,
  fetchMutiny,
  fetchMyActiveContests,
  fetchMyActiveMutinies,
  fetchPlayers,
  fetchZones,
} from "@/lib/supabase/queries";
import {
  attemptCaptureZone,
  cancelMutiny,
  captureZone,
  claimPlunder,
  createZone,
  deleteZone,
  finalizeCaptureFromContest,
  joinMutinyCrew,
  pledgeUprisingSupport,
  signOut,
  startMutiny,
  startUprising,
  setZoneNickname,
  submitMutinyMove,
  submitRpsMove,
  transferZone,
  updateZone,
} from "@/lib/supabase/mutations";
import { useContestChannel } from "@/lib/supabase/useContestChannel";
import { useMutinyChannel } from "@/lib/supabase/useMutinyChannel";
import type { ActiveContestSummary, ActiveMutinySummary, Contest, LngLat, Mutiny, Player, RpsMove, Zone } from "@/lib/types";

// How far down the page gets nudged on load so the map shows under the
// notch instead of the fallback color (see the phantomOverlay effect below)
// — also enforced as a floor the page can't be scrolled above, so pulling
// down/rubber-banding back toward the top can't re-expose that area.
const NOTCH_SCROLL_FLOOR = 60;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// GeoJSON requires a Polygon ring's last position to repeat its first — the
// draw/edit tool works with an open ring internally, so this closes it
// before saving.
function closeRing(ring: LngLat[]): LngLat[] {
  if (ring.length < 3) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}

function curseRemainingLabel(cursedUntil: number, now: number): string {
  const ms = cursedUntil - now;
  if (ms <= 0) return "any moment now";
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 1) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

// The server phrases every curse rejection with the word "cursed" — used to
// route those specific errors into the dedicated CursedModal instead of a
// window.alert() or the usual inline error text under a button..
function isCursedMessage(message: string): boolean {
  return message.toLowerCase().includes("cursed");
}

interface MutinyOutcomeInfo {
  title: string;
  message: string;
  positive: boolean;
}

// One role-specific "how did this turn out for me" beat per participant —
// the incumbent, the instigator, and every crew member all see something
// different for the same resolved Mutiny. Returns null for a mutiny that
// hasn't ended yet, or for a viewer with no stake in it (a bystander just
// sees the resting rally screen instead).
function computeMutinyOutcome(mutiny: Mutiny, players: Player[], currentPlayerId: string, zoneName: string): MutinyOutcomeInfo | null {
  if (mutiny.status !== "succeeded" && mutiny.status !== "failed") return null;
  const duels = mutiny.duels;
  if (duels.length === 0) return null;

  // playerAId (the incumbent) never changes across a single mutiny's duels.
  const incumbentId = duels[0].playerAId;
  const instigatorId = mutiny.instigatorId;
  const isIncumbent = currentPlayerId === incumbentId;
  const isInstigator = currentPlayerId === instigatorId;
  const isCrew = mutiny.crewIds.includes(currentPlayerId);
  if (!isIncumbent && !isInstigator && !isCrew) return null;

  const incumbentName = playerById(players, incumbentId)?.name ?? "The incumbent";
  const instigatorName = playerById(players, instigatorId)?.name ?? "The instigator";

  if (mutiny.status === "failed") {
    if (isIncumbent) {
      return { title: "Defended!", message: `You held ${zoneName} against ${instigatorName}'s Mutiny.`, positive: true };
    }
    return {
      title: "Mutiny Failed",
      message: `${incumbentName} held ${zoneName}.`,
      positive: false,
    };
  }

  // Succeeded — exactly one duel was won by its challenger (playerB); that
  // person is whoever actually broke through, though the throne itself
  // always goes to the instigator regardless of who that was.
  const winningDuel = duels.find((d) => d.winnerId !== null && d.winnerId === d.playerBId) ?? null;
  const winnerId = winningDuel?.playerBId ?? instigatorId;
  const winnerName = playerById(players, winnerId)?.name ?? "Someone";

  if (isIncumbent) {
    return {
      title: "Defeated",
      message: `${zoneName} now belongs to ${instigatorName}.`,
      positive: false,
    };
  }
  if (isInstigator) {
    return {
      title: "Throne Seized!",
      message:
        winnerId === currentPlayerId
          ? `${zoneName} is yours.`
          : `${winnerName} did it for you. ${zoneName} is yours.`,
      positive: true,
    };
  }
  // A crew member.
  if (winnerId === currentPlayerId) {
    return { title: "Mutiny Successful", message: `${zoneName} now belongs to ${instigatorName}.`, positive: true };
  }
  return {
    title: "Mutiny Successful",
    message: `${zoneName} now belongs to ${instigatorName}.`,
    positive: true,
  };
}

interface CaptureSubmission {
  placeId: string;
  placeName: string;
  caption: string;
  photoFile: File | null;
  nickname: string;
}

interface ResultData {
  zoneName: string;
  caption: string;
  photoUrl: string | null;
  isHit?: boolean;
  bossHp?: number | null;
  bossMaxHp?: number | null;
  plunderedZoneNames?: string[];
}

interface PlunderOffer {
  zoneId: string;
  fromPlayerId: string;
  deadline: number;
}

interface AppShellProps {
  userId: string;
  onLoggedOut: () => void;
}

export default function AppShell({ userId, onLoggedOut }: AppShellProps) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureSubmitting, setCaptureSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  const [pendingZoneDraft, setPendingZoneDraft] = useState<ZoneDraft | null>(null);
  const [zoneFormSubmitting, setZoneFormSubmitting] = useState(false);
  const [zoneFormError, setZoneFormError] = useState<string | null>(null);
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deletingZone, setDeletingZone] = useState(false);

  const [contest, setContest] = useState<Contest | null>(null);
  // Tracks which contest's "you won" screen the winner has already tapped
  // through, so it shows exactly once per win rather than every re-render.
  const [acknowledgedVictoryContestId, setAcknowledgedVictoryContestId] = useState<string | null>(null);
  // Individual match outcomes the player has tapped "Continue" past — a
  // match resolves and the server can advance the round (or end the
  // contest) in the same instant, so without this the win/lose reveal for
  // that match would never actually be visible, just flashed through.
  const [acknowledgedMatchIds, setAcknowledgedMatchIds] = useState<Set<string>>(new Set());
  // Same idea, for Mutiny duels — see mutinyPendingRevealDuel below.
  const [acknowledgedMutinyDuelIds, setAcknowledgedMutinyDuelIds] = useState<Set<string>>(new Set());
  // Tournament-level equivalent, keyed by mutiny id — see mutinyOutcome below.
  const [acknowledgedMutinyOutcomeIds, setAcknowledgedMutinyOutcomeIds] = useState<Set<string>>(new Set());
  const [capturingZoneId, setCapturingZoneId] = useState<string | null>(null);
  const [pickSubmitting, setPickSubmitting] = useState(false);
  const [pickError, setPickError] = useState<{ matchId: string; message: string } | null>(null);
  const [myActiveContests, setMyActiveContests] = useState<ActiveContestSummary[]>([]);
  const [myActiveMutinies, setMyActiveMutinies] = useState<ActiveMutinySummary[]>([]);

  // Boss Raid plunder — shown after a finishing blow, before the usual
  // capture result screen, whenever there's a live offer with something to
  // actually choose from.
  const [plunderOffer, setPlunderOffer] = useState<PlunderOffer | null>(null);
  const [pendingResultAfterPlunder, setPendingResultAfterPlunder] = useState<ResultData | null>(null);
  const [plunderSubmitting, setPlunderSubmitting] = useState(false);
  const [plunderError, setPlunderError] = useState<string | null>(null);

  // Uprising — the screen (all its state lives in `zones` already, so just
  // tracking which zone's screen is open is enough) opens from the zone
  // sheet's card and is where starting/pledging actually happens.
  const [uprisingScreenZoneId, setUprisingScreenZoneId] = useState<string | null>(null);
  const [uprisingSubmitting, setUprisingSubmitting] = useState(false);
  const [uprisingError, setUprisingError] = useState<string | null>(null);
  const [uprisingResult, setUprisingResult] = useState<{ zoneName: string; player: Player } | null>(null);
  // Snapshot of the last-known supporter list for whichever zone's Uprising
  // screen is open — the live list is cleared the instant the Uprising
  // succeeds, so an earlier supporter (not the one whose pledge tipped it
  // over) has no other way to tell after the fact "was I one of the three."
  const lastUprisingSupportersRef = useRef<{ zoneId: string; supporterIds: string[] } | null>(null);
  // The invader who was holding the zone has no reason to have any Uprising
  // screen open when it succeeds against them — unlike the original owner
  // and their supporters, they never took an action to watch a response to.
  // Surfaced globally (see the zones-diff effect below) instead of scoped to
  // a screen.
  const [uprisingLossNotice, setUprisingLossNotice] = useState<{ zoneName: string } | null>(null);
  // Same reasoning, for the original owner losing a home zone to a Boss
  // Raid finishing blow — they have no reason to be watching anything in
  // particular when it lands either.
  const [bossRaidLossNotice, setBossRaidLossNotice] = useState<{ zoneName: string } | null>(null);
  const prevZonesByIdRef = useRef<Map<string, Zone>>(new Map());

  // Mutiny — mirrors `contest`, but for the recruit-then-duel gauntlet.
  // `mutinyScreenZoneId` tracks which zone's screen is open independent of
  // whether a Mutiny actually exists yet (null `mutiny` + a screen open
  // means "nobody's started one — show the empty state with a start button").
  const [mutinyScreenZoneId, setMutinyScreenZoneId] = useState<string | null>(null);
  const [mutiny, setMutiny] = useState<Mutiny | null>(null);
  const [mutinyActionSubmitting, setMutinyActionSubmitting] = useState(false);
  const [mutinyActionError, setMutinyActionError] = useState<string | null>(null);
  const [mutinyMoveSubmitting, setMutinyMoveSubmitting] = useState(false);
  const [mutinyMoveError, setMutinyMoveError] = useState<string | null>(null);
  const [mutinyCancelling, setMutinyCancelling] = useState(false);
  const [mutinyCancelError, setMutinyCancelError] = useState<string | null>(null);

  // Zone Gifting.
  const [giftSubmitting, setGiftSubmitting] = useState(false);
  const [giftError, setGiftError] = useState<string | null>(null);
  // Shown to the giver right after a successful gift — same "here's what
  // just happened" beat as the Uprising/Mutiny outcome screens, since
  // otherwise the sheet just silently closes.
  const [giftSentNotice, setGiftSentNotice] = useState<{ zoneName: string; recipientName: string } | null>(null);
  // Shown to the recipient, who took no action of their own and would
  // otherwise never find out — detected passively below, same pattern as
  // uprisingLossNotice/bossRaidLossNotice.
  const [giftReceivedNotice, setGiftReceivedNotice] = useState<{ zoneName: string; giverName: string } | null>(
    null
  );

  // Zone nickname.
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Shown instead of the usual inline error / window.alert whenever a
  // rejection turns out to be a curse — see isCursedMessage.
  const [curseNotice, setCurseNotice] = useState<string | null>(null);

  // Shown when a player tries to capture/attack/start an uprising or mutiny
  // from outside the zone's polygon, or when their location can't be read.
  const [locationNotice, setLocationNotice] = useState<string | null>(null);

  // Ticks the curse banner's remaining-time readout without calling
  // Date.now() directly during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Mobile Safari only paints real page content behind the notch/bottom-bar
  // chrome (instead of a flat fallback color) after a full-viewport
  // `position: fixed; inset: 0` element has been mounted and then removed —
  // confirmed by testing; a real page scroll (even scrolling the leaderboard
  // all the way down and back) does NOT trigger it, only this DOM pattern
  // does. Every one of this app's full-screen overlays already does this
  // naturally when opened/closed, which is why the notch area used to only
  // "unlock" after visiting any other screen once. This mounts one
  // automatically, briefly, right after load, so it's unlocked from the
  // start instead of requiring that. It's the same solid background color
  // as the rest of the app, so there's nothing to see even while it's
  // mounted — this is a compositing nudge, not a visual element.
  const [phantomOverlay, setPhantomOverlay] = useState(false);
  useEffect(() => {
    if (loading) return;
    const showId = setTimeout(() => setPhantomOverlay(true), 0);
    const hideId = setTimeout(() => setPhantomOverlay(false), 200);
    // Once compositing is unlocked (above), Safari still shows a flat
    // color at scrollY=0 itself and only shows real content once actually
    // scrolled — this nudges the page down a few px right after so the map
    // appears under the notch from the start instead of needing a manual
    // scroll. The page is already taller than one screen (map + leaderboard
    // below), so there's genuine room to scroll into — no artificial spacer
    // needed here, unlike the earlier failed attempt at this.
    const scrollId = setTimeout(() => window.scrollTo(0, NOTCH_SCROLL_FLOOR), 250);
    return () => {
      clearTimeout(showId);
      clearTimeout(hideId);
      clearTimeout(scrollId);
    };
  }, [loading]);

  // Enforces NOTCH_SCROLL_FLOOR as a floor the page can never scroll above
  // — without this, pulling down / rubber-banding back toward the top
  // re-exposes the fallback-color strip under the notch. Reactive
  // (snaps back after the fact) rather than intercepting the touch gesture
  // itself — a non-passive touchmove/preventDefault version of this was
  // tried and reverted: it had no way to tell "dragging the whole page
  // toward the top" apart from "scrolling inside a modal's own content",
  // and ended up blocking upward scrolling everywhere, including inside
  // every overlay. This is a real bounce/no-preventDefault tradeoff — see
  // overscroll-behavior-y in globals.css for what actually smooths it out.
  useEffect(() => {
    if (loading) return;
    const enforceFloor = () => {
      if (window.scrollY < NOTCH_SCROLL_FLOOR) window.scrollTo(0, NOTCH_SCROLL_FLOOR);
    };
    window.addEventListener("scroll", enforceFloor, { passive: true });
    return () => window.removeEventListener("scroll", enforceFloor);
  }, [loading]);

  // Read inside the poll below without making editingZoneId a dependency of
  // that effect — a background zones refresh must skip clobbering an
  // in-progress polygon edit (MapView re-syncs its draft from `editingZone`,
  // which is derived from `zones`, on every reference change).
  const editingZoneIdRef = useRef(editingZoneId);
  useEffect(() => {
    editingZoneIdRef.current = editingZoneId;
  }, [editingZoneId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [fetchedPlayers, fetchedZones] = await Promise.all([fetchPlayers(), fetchZones()]);
        if (cancelled) return;
        setPlayers(fetchedPlayers);
        setZones(fetchedZones);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load game data.");
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [userId]);


  // Global, independent of whichever zone is selected — this is what lets a
  // player who instant-captured a zone and moved on discover they've been
  // contested without still having that zone's screen open. Also refreshes
  // `zones` on the same tick: once a player leaves a contest screen (e.g.
  // "Keep exploring"), nothing else re-subscribes to that contest for
  // them, so without this the zone's "Contested" badge / active-contest
  // state would stay stuck at whatever it was when they left, even long
  // after the fight actually finished.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const skipZones = editingZoneIdRef.current !== null;
        const [alerts, mutinyAlerts, freshZones] = await Promise.all([
          fetchMyActiveContests(),
          fetchMyActiveMutinies(),
          skipZones ? null : fetchZones(),
        ]);
        if (cancelled) return;
        setMyActiveContests(alerts);
        setMyActiveMutinies(mutinyAlerts);
        if (freshZones) setZones(freshZones);
      } catch {
        // Best-effort — try again on the next tick.
      }
    };
    poll();
    const id = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userId]);

  const { nudge: nudgeContest } = useContestChannel(contest?.id ?? null, async () => {
    if (!contest) return;
    try {
      setContest(await fetchContest(contest.id));
    } catch {
      // Best-effort — the 5s poll backstop will retry.
    }
  });

  const currentPlayer = playerById(players, userId);
  const isAdmin = currentPlayer?.isAdmin ?? false;
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const selectedPlayer = playerById(players, selectedPlayerId);
  const selectedPlayerZones = selectedPlayerId ? zones.filter((z) => z.ownerId === selectedPlayerId) : [];

  // Being a participant alone isn't enough — the background 60s window
  // opens on every instant capture even when nobody else ever joins, so
  // that solo case must not show "Back to the fight" (there isn't one).
  // Requires genuinely more than one participant, same signal already used
  // for the map pulse.
  const selectedZoneInContest = Boolean(
    selectedZone &&
      selectedZone.activeContestParticipantIds.length > 1 &&
      myActiveContests.some((c) => c.zoneId === selectedZone.id)
  );

  const plunderZone = plunderOffer ? zones.find((z) => z.id === plunderOffer.zoneId) ?? null : null;
  const plunderFromPlayer = plunderOffer ? playerById(players, plunderOffer.fromPlayerId) : null;
  const plunderEligibleZones = plunderOffer
    ? zones.filter(
        (z) => z.ownerId === plunderOffer.fromPlayerId && z.id !== plunderOffer.zoneId && !z.activeContestId
      )
    : [];

  const uprisingScreenZone = uprisingScreenZoneId ? zones.find((z) => z.id === uprisingScreenZoneId) ?? null : null;
  const mutinyScreenZone = mutinyScreenZoneId ? zones.find((z) => z.id === mutinyScreenZoneId) ?? null : null;
  const mutinyDuels = mutiny?.duels ?? [];
  // At most one duel is ever unresolved at a time (the next one is only
  // created once the previous resolves) — the last entry is "current" only
  // while it's still open.
  const mutinyCurrentDuel =
    mutinyDuels.length > 0 && mutinyDuels[mutinyDuels.length - 1].resolvedAt === null
      ? mutinyDuels[mutinyDuels.length - 1]
      : null;
  // The duel screen only makes sense for whoever's actually in the current
  // duel (the incumbent defending, or the challenger up next) — anyone else
  // (a bystander, or a crew member still waiting their turn) sees the rally
  // screen's crew-order view instead, which never crashes on a mismatched
  // identity the way reusing ContestFightScreen for a non-participant would.
  const iAmInMutinyDuel = Boolean(
    mutinyCurrentDuel &&
      (mutinyCurrentDuel.playerAId === currentPlayer?.id || mutinyCurrentDuel.playerBId === currentPlayer?.id)
  );
  // My most recent resolved duel that hasn't been tapped through yet — same
  // idea as pendingRevealMatch below, and for the same reason: the server
  // can resolve a duel and immediately open the next one (or end the whole
  // Mutiny) in the same instant, so without this the win/lose reveal would
  // never actually be seen, just replaced by whatever comes next.
  const mutinyPendingRevealDuel =
    mutinyDuels.find(
      (d) =>
        d.resolvedAt !== null &&
        !acknowledgedMutinyDuelIds.has(d.id) &&
        (d.playerAId === currentPlayer?.id || d.playerBId === currentPlayer?.id)
    ) ?? null;
  // The tournament-level "how did this turn out for me" beat — only shown
  // once any of my own duel reveals above have already been tapped through.
  const mutinyOutcome =
    mutiny && mutinyScreenZone && currentPlayer
      ? computeMutinyOutcome(mutiny, players, currentPlayer.id, mutinyScreenZone.nickname ?? mutinyScreenZone.name)
      : null;
  const showMutinyOutcome = Boolean(
    mutinyOutcome && mutiny && !acknowledgedMutinyOutcomeIds.has(mutiny.id) && !mutinyPendingRevealDuel
  );

  const { nudge: nudgeMutiny } = useMutinyChannel(mutiny?.id ?? null, async () => {
    if (!mutiny) return;
    try {
      setMutiny(await fetchMutiny(mutiny.id));
    } catch {
      // Best-effort — the 5s poll backstop will retry.
    }
  });

  const contestZone = contest ? zones.find((z) => z.id === contest.zoneId) ?? null : null;
  const contestMyMatch =
    contest?.status === "battling"
      ? contest.matches.find(
          (m) =>
            m.round === contest.currentRound &&
            m.resolvedAt === null &&
            (m.playerAId === currentPlayer?.id || m.playerBId === currentPlayer?.id)
        ) ?? null
      : null;
  // My most recent resolved (non-bye) match that hasn't been tapped through
  // yet — takes priority over everything else below, including advancing to
  // a new round's match or the tournament-level outcome screens, so the
  // player always sees each match's own result before moving on.
  const pendingRevealMatch = contest
    ? contest.matches.find(
        (m) =>
          m.resolvedAt !== null &&
          m.playerBId !== null &&
          !acknowledgedMatchIds.has(m.id) &&
          (m.playerAId === currentPlayer?.id || m.playerBId === currentPlayer?.id)
      ) ?? null
    : null;

  const contestWinner = contest?.status === "awaiting_proof" ? playerById(players, contest.winnerId) : null;
  // A contest win requires submitting proof to actually claim the zone —
  // derived (not effect-driven) so winning funnels straight into the same
  // CaptureFlow used for direct captures without an extra render round-trip,
  // and closing the form can't discard a win that still needs claiming.
  // The winner sees a "you won" beat first and has to tap through it before
  // CaptureFlow opens, tracked per-contest-id so it shows exactly once.
  const contestNeedsMyProof = Boolean(
    contest && contest.status === "awaiting_proof" && contest.winnerId === currentPlayer?.id
  );
  // A defender (already owned the zone, won anyway) never goes through
  // CaptureFlow at all — their existing capture already stands — but they
  // still get the same "you won" beat instead of silently landing back on
  // the map the instant the contest completes.
  const contestDefended = Boolean(
    contest && contest.status === "completed" && contest.winnerId === currentPlayer?.id
  );
  const outcomeAcknowledged = contest !== null && acknowledgedVictoryContestId === contest.id;
  // The tournament-level outcome (win/defend) only ever shows once any
  // final match's own reveal has been tapped through.
  const showVictoryScreen = contestNeedsMyProof && !outcomeAcknowledged && !pendingRevealMatch;
  const showDefendedScreen = contestDefended && !outcomeAcknowledged && !pendingRevealMatch;
  const showCaptureFlow = captureOpen || (contestNeedsMyProof && outcomeAcknowledged && !pendingRevealMatch);

  const editingZone: EditingZoneInput | null = useMemo(() => {
    if (!editingZoneId) return null;
    const zone = zones.find((z) => z.id === editingZoneId);
    if (!zone) return null;
    return {
      id: zone.id,
      polygon: zone.polygon,
      places: zone.places.map((p) => ({ id: p.id, location: p.location ?? polygonCentroid(zone.polygon) })),
    };
  }, [editingZoneId, zones]);

  // The zone being edited (for name/nickname/place-name prefill in the review form) —
  // null while creating a brand-new zone.
  const editingSourceZone = pendingZoneDraft?.zoneId
    ? zones.find((z) => z.id === pendingZoneDraft.zoneId) ?? null
    : null;

  const overlayOpen =
    Boolean(selectedZone) ||
    Boolean(result) ||
    Boolean(selectedPlayer) ||
    Boolean(pendingZoneDraft) ||
    Boolean(contest) ||
    Boolean(plunderOffer) ||
    Boolean(mutinyScreenZoneId) ||
    Boolean(uprisingScreenZoneId) ||
    Boolean(uprisingResult) ||
    Boolean(uprisingLossNotice) ||
    Boolean(bossRaidLossNotice) ||
    Boolean(giftSentNotice) ||
    Boolean(giftReceivedNotice) ||
    Boolean(curseNotice) ||
    settingsOpen;
  useEffect(() => {
    document.body.style.overflow = overlayOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [overlayOpen]);

  // Anyone just watching a contest (not currently submitting proof, not a
  // defender who hasn't seen their own "you won" beat yet, and not sitting
  // on an unacknowledged match reveal) gets bounced back to the map once it
  // wraps up. Gated on showCaptureFlow/showDefendedScreen/pendingRevealMatch,
  // not just captureOpen — the contest-win path renders CaptureFlow via
  // contestNeedsMyProof without ever setting captureOpen, and this must not
  // yank `contest` out from under a winner mid-submit, before a defender's
  // seen the result, or before the final match's own reveal was shown.
  useEffect(() => {
    if (!contest) return;
    if (
      (contest.status === "completed" || contest.status === "cancelled") &&
      !showCaptureFlow &&
      !showDefendedScreen &&
      !pendingRevealMatch
    ) {
      fetchZones()
        .then((fresh) => {
          setZones(fresh);
          setContest(null);
        })
        .catch(() => {});
    }
  }, [contest, showCaptureFlow, showDefendedScreen, pendingRevealMatch]);

  // A Mutiny that's wrapped up (someone broke through, the crew was
  // exhausted, or it got cancelled by a rival Mutiny) refreshes zone state
  // in the background but leaves the screen up — ContestFightScreen's own
  // resolved-duel beat stays visible until the player taps its close
  // button, same UX as reaching a terminal state in a regular contest.
  useEffect(() => {
    if (!mutiny) return;
    if (mutiny.status === "succeeded" || mutiny.status === "failed" || mutiny.status === "cancelled") {
      fetchZones()
        .then(setZones)
        .catch(() => {});
    }
  }, [mutiny]);

  // Keep a snapshot of the supporter list while the Uprising is still live,
  // since it's cleared the instant it succeeds — see
  // `lastUprisingSupportersRef` above.
  useEffect(() => {
    if (!uprisingScreenZone?.activeUprisingId) return;
    lastUprisingSupportersRef.current = {
      zoneId: uprisingScreenZone.id,
      supporterIds: uprisingScreenZone.activeUprisingSupporterIds,
    };
  }, [uprisingScreenZone]);

  // The original owner never calls pledgeUprisingSupport themselves (they're
  // blocked from pledging their own Uprising), and an earlier supporter has
  // no direct RPC response to react to either if a *different* player's
  // pledge is what tips it over — this is what tells both of them their
  // Uprising succeeded while they were just watching. tier flipping
  // invaded → home usually means Uprising success, but a gift can cause the
  // exact same flip (e.g. someone gifting the zone back to its original
  // owner) — see the isGift check below, which rules that case out the same
  // way the global loss-notice effect below does for the giver's side.
  useEffect(() => {
    if (!uprisingScreenZone || !currentPlayer) return;
    if (uprisingScreenZone.tier !== "home") return;
    const lastEvent =
      uprisingScreenZone.history.length > 0 ? uprisingScreenZone.history[uprisingScreenZone.history.length - 1] : null;
    if (lastEvent?.isGift) return;
    const isOriginalOwner = uprisingScreenZone.originalOwnerId === currentPlayer.id;
    const snapshot = lastUprisingSupportersRef.current;
    const wasSupporter =
      snapshot?.zoneId === uprisingScreenZone.id && snapshot.supporterIds.includes(currentPlayer.id);
    if (!isOriginalOwner && !wasSupporter) return;
    const zoneName = uprisingScreenZone.nickname ?? uprisingScreenZone.name;
    const resultPlayer = isOriginalOwner
      ? currentPlayer
      : playerById(players, uprisingScreenZone.originalOwnerId) ?? currentPlayer;
    // Deferred a tick (rather than calling setState synchronously in the
    // effect body) purely to keep this from being flagged as a cascading
    // render — there's no real async work here.
    Promise.resolve().then(() => {
      setUprisingResult({ zoneName, player: resultPlayer });
      setUprisingScreenZoneId(null);
    });
  }, [uprisingScreenZone, currentPlayer, players]);

  // Global counterpart to the two effects above: catches the zone's
  // invader losing it to a successful Uprising, and the original owner
  // losing a home zone to a Boss Raid finishing blow, no matter what
  // they're looking at — by diffing each poll's zones against the previous
  // one for the relevant tier/ownership flip.
  useEffect(() => {
    if (currentPlayer) {
      const prevById = prevZonesByIdRef.current;
      for (const zone of zones) {
        const prev = prevById.get(zone.id);
        if (!prev || prev.ownerId !== currentPlayer.id || zone.ownerId === currentPlayer.id) continue;
        // A voluntary gift also moves ownership away and can flip
        // home/invaded tier along with it (see transferZone) — that's not a
        // dethroning, so skip it here; the giver already gets their own
        // "Gift Sent" notice from handleGiftZone instead.
        const lastEvent = zone.history.length > 0 ? zone.history[zone.history.length - 1] : null;
        if (lastEvent?.isGift) continue;
        const zoneName = zone.nickname ?? zone.name;
        if (prev.tier === "invaded" && zone.tier === "home") {
          Promise.resolve().then(() => setUprisingLossNotice({ zoneName }));
          break;
        }
        if (prev.tier === "home" && zone.tier === "invaded") {
          Promise.resolve().then(() => setBossRaidLossNotice({ zoneName }));
          break;
        }
      }

      // The recipient of a gift took no action of their own — no RPC
      // response to react to, unlike the giver (see handleGiftZone) — so
      // this is their only way to find out. Keyed off the newest history
      // entry actually being a fresh gift addressed to them, rather than
      // just "I own this and didn't before," since that alone can't tell a
      // gift apart from, say, a Mutiny/Uprising win already surfaced above.
      for (const zone of zones) {
        const prev = prevById.get(zone.id);
        if (!prev || prev.ownerId === currentPlayer.id || zone.ownerId !== currentPlayer.id) continue;
        const prevLastEventId = prev.history.length > 0 ? prev.history[prev.history.length - 1].id : null;
        const lastEvent = zone.history.length > 0 ? zone.history[zone.history.length - 1] : null;
        if (lastEvent && lastEvent.id !== prevLastEventId && lastEvent.isGift && lastEvent.playerId === currentPlayer.id) {
          const zoneName = zone.nickname ?? zone.name;
          const giver = lastEvent.previousOwnerId ? playerById(players, lastEvent.previousOwnerId) : null;
          Promise.resolve().then(() => setGiftReceivedNotice({ zoneName, giverName: giver?.name ?? "Someone" }));
          break;
        }
      }
    }
    prevZonesByIdRef.current = new Map(zones.map((zone) => [zone.id, zone]));
  }, [zones, currentPlayer, players]);

  // pickError is tagged with the match it happened on (see handlePickMove)
  // and only ever displayed against that same match — otherwise an error
  // from an old match (e.g. "Match already resolved" from a race against a
  // forfeit) would keep showing under a brand new match's picker until the
  // next submit attempt cleared it.
  const displayedPickError = pickError && pickError.matchId === contestMyMatch?.id ? pickError.message : null;

  const mapZones: MapZoneInput[] = useMemo(
    () =>
      zones
        .filter((zone) => zone.id !== editingZoneId)
        .map((zone) => {
          // Only pulse once it's a real fight (2+ contestants) — the first
          // ~60s where a zone's just been instant-captured and nobody's
          // contesting it yet shouldn't visually read as "under attack."
          const contestColors =
            zone.activeContestParticipantIds.length > 1
              ? zone.activeContestParticipantIds
                  .map((id) => playerById(players, id)?.color)
                  .filter((color): color is string => Boolean(color))
              : undefined;
          return {
            id: zone.id,
            color: playerById(players, zone.ownerId)?.color ?? NEUTRAL_ZONE_COLOR,
            polygon: zone.polygon,
            contestColors,
            tier: zone.tier,
            bossHpRatio:
              zone.bossHp !== null && zone.bossMaxHp !== null && zone.bossMaxHp > 0
                ? zone.bossHp / zone.bossMaxHp
                : undefined,
          };
        }),
    [zones, players, editingZoneId]
  );

  const handleSubmitCapture = async ({ placeId, caption, photoFile, nickname }: CaptureSubmission) => {
    if (!selectedZone || !currentPlayer) return;
    setCaptureSubmitting(true);
    setCaptureError(null);
    try {
      if (
        contest &&
        contest.zoneId === selectedZone.id &&
        contest.status === "awaiting_proof" &&
        contest.winnerId === currentPlayer.id
      ) {
        await finalizeCaptureFromContest({ contestId: contest.id, placeId, caption, photoFile, nickname });
      } else {
        await captureZone({ placeId, caption, photoFile, nickname });
      }

      const freshZones = await fetchZones();
      setZones(freshZones);
      const updatedZone = freshZones.find((z) => z.id === selectedZone.id);
      const lastEvent = updatedZone?.history[updatedZone.history.length - 1];
      setCaptureOpen(false);
      setContest(null);

      const resultData: ResultData = {
        zoneName: updatedZone?.nickname ?? updatedZone?.name ?? selectedZone.nickname ?? selectedZone.name,
        caption,
        photoUrl: lastEvent?.photoUrl ?? null,
        isHit: lastEvent?.isHit ?? false,
        bossHp: updatedZone?.bossHp ?? null,
        bossMaxHp: updatedZone?.bossMaxHp ?? null,
      };

      // A Boss Raid finishing blow always opens a spoils offer — but only
      // worth a detour to the picker if there's actually something in it.
      if (updatedZone && !lastEvent?.isHit && updatedZone.pendingPlunderFromId && updatedZone.pendingPlunderDeadline) {
        const eligible = freshZones.filter(
          (z) =>
            z.ownerId === updatedZone.pendingPlunderFromId &&
            z.id !== updatedZone.id &&
            !z.activeContestId
        );
        if (eligible.length > 0) {
          setPlunderOffer({
            zoneId: updatedZone.id,
            fromPlayerId: updatedZone.pendingPlunderFromId,
            deadline: updatedZone.pendingPlunderDeadline,
          });
          setPendingResultAfterPlunder(resultData);
          return;
        }
      }

      setResult(resultData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Capture failed.";
      if (isCursedMessage(message)) {
        setCurseNotice(message);
      } else {
        setCaptureError(message);
      }
    } finally {
      setCaptureSubmitting(false);
    }
  };

  // Blocks capture/boss-attack/uprising/mutiny actions unless the player's
  // current GPS position falls inside the zone's polygon.
  const ensureInsideZone = async (zone: Zone): Promise<boolean> => {
    try {
      const position = await getCurrentPosition();
      if (!isPointInPolygon(position, zone.polygon)) {
        setLocationNotice("You need to be inside this zone to do that.");
        return false;
      }
      return true;
    } catch (err) {
      setLocationNotice(err instanceof LocationError ? err.message : "Couldn't get your location.");
      return false;
    }
  };

  const handleCapture = async (zone: Zone) => {
    setCapturingZoneId(zone.id);
    try {
      if (!(await ensureInsideZone(zone))) return;
      if (zone.tier === "home" || !zone.activeContestId) {
        // No contest exists yet for this regular zone — just open the form
        // directly instead of pre-emptively calling attemptCaptureZone.
        // Opening the form should not, by itself, start the background
        // contest window; capture_zone creates it lazily only if/when the
        // player actually submits, so cancelling out of the form leaves no
        // trace instead of starting a contest nobody's actually contesting.
        setContest(null);
        setCaptureOpen(true);
        return;
      }
      setContest(null);
      const res = await attemptCaptureZone(zone.id);
      if (res.mode === "instant") {
        setCaptureOpen(true);
      } else {
        setContest(res);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start the capture.";
      if (isCursedMessage(message)) {
        setCurseNotice(message);
      } else {
        window.alert(message);
      }
    } finally {
      setCapturingZoneId(null);
    }
  };

  const handlePickMove = async (matchId: string, move: RpsMove) => {
    setPickSubmitting(true);
    setPickError(null);
    try {
      const fresh = await submitRpsMove(matchId, move);
      setContest(fresh);
      nudgeContest();
    } catch (err) {
      setPickError({ matchId, message: err instanceof Error ? err.message : "Couldn't submit your move." });
    } finally {
      setPickSubmitting(false);
    }
  };

  const handleContinueMatch = (matchId: string) => {
    setAcknowledgedMatchIds((prev) => {
      const next = new Set(prev);
      next.add(matchId);
      return next;
    });
  };

  const handleContinueMutinyDuel = (duelId: string) => {
    setAcknowledgedMutinyDuelIds((prev) => {
      const next = new Set(prev);
      next.add(duelId);
      return next;
    });
  };

  const handleAcknowledgeMutinyOutcome = () => {
    if (mutiny) {
      setAcknowledgedMutinyOutcomeIds((prev) => {
        const next = new Set(prev);
        next.add(mutiny.id);
        return next;
      });
    }
    setMutinyScreenZoneId(null);
    setMutiny(null);
  };

  const openContest = async (contestId: string, zoneId: string) => {
    try {
      const fresh = await fetchContest(contestId);
      setContest(fresh);
      setSelectedZoneId(zoneId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Couldn't load that contest.");
    }
  };

  const handleSelectContestAlert = (alert: ActiveContestSummary) => openContest(alert.contestId, alert.zoneId);

  // Reopening from ZoneDetailSheet when the player is already a
  // participant — goes straight to the existing contest instead of calling
  // attemptCaptureZone again, which would incorrectly treat a defending
  // instant-capturer as "already owns this zone" or a joined challenger as
  // a fresh spectator.
  const handleRejoinContest = (zone: Zone) => {
    if (zone.activeContestId) openContest(zone.activeContestId, zone.id);
  };

  // Dismisses the defended-zone victory screen: unlike a fresh win, there's
  // no proof to submit — the defender's existing capture already stands —
  // so this just marks it seen and returns to the map.
  const handleAcknowledgeDefense = async () => {
    if (!contest) return;
    setAcknowledgedVictoryContestId(contest.id);
    try {
      setZones(await fetchZones());
    } catch {
      // Best-effort — the global poll will pick up the fresh state anyway.
    }
    setContest(null);
  };

  const refreshPlayers = async () => {
    const freshPlayers = await fetchPlayers();
    setPlayers(freshPlayers);
  };

  const handleDeleteZone = async () => {
    if (!selectedZone) return;
    if (!window.confirm(`Delete "${selectedZone.nickname ?? selectedZone.name}"? This can't be undone.`)) return;
    setDeletingZone(true);
    try {
      await deleteZone(selectedZone.id);
      const freshZones = await fetchZones();
      setZones(freshZones);
      setSelectedZoneId(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Couldn't delete this zone.");
    } finally {
      setDeletingZone(false);
    }
  };

  const handleDismissResult = () => {
    setResult(null);
    setSelectedZoneId(null);
  };

  const handleConfirmPlunder = async (zoneIds: string[]) => {
    if (!plunderOffer) return;
    setPlunderSubmitting(true);
    setPlunderError(null);
    try {
      const plundered = await claimPlunder({ zoneId: plunderOffer.zoneId, zoneIds });
      setZones(await fetchZones());
      setResult({ ...(pendingResultAfterPlunder as ResultData), plunderedZoneNames: plundered.map((p) => p.name) });
      setPlunderOffer(null);
      setPendingResultAfterPlunder(null);
    } catch (err) {
      setPlunderError(err instanceof Error ? err.message : "Couldn't claim those spoils.");
    } finally {
      setPlunderSubmitting(false);
    }
  };

  const handleSkipPlunder = () => {
    if (pendingResultAfterPlunder) setResult(pendingResultAfterPlunder);
    setPlunderOffer(null);
    setPendingResultAfterPlunder(null);
  };

  const handleStartUprising = async (zone: Zone) => {
    setUprisingSubmitting(true);
    setUprisingError(null);
    try {
      if (!(await ensureInsideZone(zone))) return;
      await startUprising(zone.id);
      setZones(await fetchZones());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start the Uprising.";
      if (isCursedMessage(message)) {
        setCurseNotice(message);
      } else {
        setUprisingError(message);
      }
    } finally {
      setUprisingSubmitting(false);
    }
  };

  const handlePledgeUprising = async (zone: Zone) => {
    if (!zone.activeUprisingId) return;
    setUprisingSubmitting(true);
    setUprisingError(null);
    try {
      const uprising = await pledgeUprisingSupport(zone.activeUprisingId);
      setZones(await fetchZones());
      if (uprising.status === "succeeded") {
        const originalOwner = playerById(players, zone.originalOwnerId);
        if (originalOwner) setUprisingResult({ zoneName: zone.nickname ?? zone.name, player: originalOwner });
        setUprisingScreenZoneId(null);
        setSelectedZoneId(null);
      }
    } catch (err) {
      setUprisingError(err instanceof Error ? err.message : "Couldn't pledge your support.");
    } finally {
      setUprisingSubmitting(false);
    }
  };

  const handleStartMutiny = async (zone: Zone) => {
    setMutinyActionSubmitting(true);
    setMutinyActionError(null);
    try {
      if (!(await ensureInsideZone(zone))) return;
      const fresh = await startMutiny(zone.id);
      setMutiny(fresh);
      setZones(await fetchZones());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start the Mutiny.";
      if (isCursedMessage(message)) {
        setCurseNotice(message);
      } else {
        setMutinyActionError(message);
      }
    } finally {
      setMutinyActionSubmitting(false);
    }
  };

  const handleJoinMutinyCrew = async (zone: Zone) => {
    if (!zone.activeMutinyId) return;
    setMutinyActionSubmitting(true);
    setMutinyActionError(null);
    try {
      await joinMutinyCrew(zone.activeMutinyId);
      const fresh = await fetchMutiny(zone.activeMutinyId);
      setMutiny(fresh);
      setZones(await fetchZones());
      nudgeMutiny();
    } catch (err) {
      setMutinyActionError(err instanceof Error ? err.message : "Couldn't join the Mutiny.");
    } finally {
      setMutinyActionSubmitting(false);
    }
  };

  const handleViewMutiny = async (zone: Zone) => {
    setMutinyScreenZoneId(zone.id);
    if (!zone.activeMutinyId) {
      setMutiny(null);
      return;
    }
    try {
      setMutiny(await fetchMutiny(zone.activeMutinyId));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Couldn't load that Mutiny.");
    }
  };

  const handleViewUprising = (zone: Zone) => {
    setUprisingScreenZoneId(zone.id);
  };

  const handleSelectMutinyAlert = (alert: ActiveMutinySummary) => {
    const zone = zones.find((z) => z.id === alert.zoneId);
    if (!zone) return;
    setSelectedZoneId(zone.id);
    handleViewMutiny(zone);
  };

  const handleSubmitMutinyMove = async (duelId: string, move: RpsMove) => {
    setMutinyMoveSubmitting(true);
    setMutinyMoveError(null);
    try {
      setMutiny(await submitMutinyMove(duelId, move));
      nudgeMutiny();
    } catch (err) {
      setMutinyMoveError(err instanceof Error ? err.message : "Couldn't submit your move.");
    } finally {
      setMutinyMoveSubmitting(false);
    }
  };

  const handleCancelMutiny = async (mutinyId: string) => {
    setMutinyCancelling(true);
    setMutinyCancelError(null);
    try {
      await cancelMutiny(mutinyId);
      setMutinyScreenZoneId(null);
      setMutiny(null);
      setZones(await fetchZones());
    } catch (err) {
      setMutinyCancelError(err instanceof Error ? err.message : "Couldn't cancel this Mutiny.");
    } finally {
      setMutinyCancelling(false);
    }
  };

  const handleGiftZone = async (zone: Zone, toPlayerId: string) => {
    setGiftSubmitting(true);
    setGiftError(null);
    try {
      await transferZone({ zoneId: zone.id, toPlayerId });
      setZones(await fetchZones());
      setSelectedZoneId(null);
      const recipient = playerById(players, toPlayerId);
      setGiftSentNotice({ zoneName: zone.nickname ?? zone.name, recipientName: recipient?.name ?? "them" });
    } catch (err) {
      setGiftError(err instanceof Error ? err.message : "Couldn't gift this zone.");
    } finally {
      setGiftSubmitting(false);
    }
  };

  const handleRenameZone = async (zone: Zone, nickname: string) => {
    setRenameSubmitting(true);
    setRenameError(null);
    try {
      await setZoneNickname(zone.id, nickname);
      setZones(await fetchZones());
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Couldn't rename this zone.");
    } finally {
      setRenameSubmitting(false);
    }
  };

  const handleZoneDraftSubmit = async ({
    name,
    nickname,
    placeNames,
  }: {
    name: string;
    nickname: string;
    placeNames: string[];
  }) => {
    const draft = pendingZoneDraft;
    if (!draft) return;
    setZoneFormSubmitting(true);
    setZoneFormError(null);
    try {
      const places = draft.places.map((place, i) => ({
        id: place.id,
        name: placeNames[i],
        location: place.location,
      }));
      const nicknameOrNull = nickname.length > 0 ? nickname : null;
      const polygon = closeRing(draft.polygon);

      if (draft.zoneId === null) {
        const zoneId = `${slugify(name)}-${Date.now()}`;
        await createZone({ id: zoneId, name, nickname: nicknameOrNull, polygon, places });
      } else {
        await updateZone({ id: draft.zoneId, name, nickname: nicknameOrNull, polygon, places });
      }

      const freshZones = await fetchZones();
      setZones(freshZones);
      setPendingZoneDraft(null);
      setEditingZoneId(null);
    } catch (err) {
      setZoneFormError(err instanceof Error ? err.message : "Couldn't save this zone.");
    } finally {
      setZoneFormSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "var(--background, #000)" }}>
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Loading your turf…
        </p>
      </div>
    );
  }

  if (loadError || !currentPlayer) {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center"
        style={{ background: "var(--background, #000)" }}
      >
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {loadError ?? "Couldn't find your profile. Try logging out and back in."}
        </p>
        <button
          type="button"
          onClick={() => signOut().then(onLoggedOut)}
          className="rounded-xl px-4 py-2 text-xs font-semibold uppercase tracking-wider"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <ContestAlertBanner alerts={myActiveContests} zones={zones} onSelect={handleSelectContestAlert} />
      <MutinyAlertBanner alerts={myActiveMutinies} zones={zones} onSelect={handleSelectMutinyAlert} />

      {currentPlayer.cursedUntil && currentPlayer.cursedUntil > now && (
        <div
          className="fixed inset-x-0 top-0 z-20 px-4 py-2.5 text-center text-sm font-semibold"
          style={{ background: "rgba(90,60,200,0.9)", color: "#fff" }}
        >
          Cursed! You can&apos;t capture any zone for {curseRemainingLabel(currentPlayer.cursedUntil, now)}.
        </div>
      )}

      <div className="relative h-[96dvh] w-full">
        <MapView
          zones={mapZones}
          onZoneClick={setSelectedZoneId}
          onZoneDraftComplete={setPendingZoneDraft}
          isAdmin={isAdmin}
          editingZone={editingZone}
          onCancelZoneEdit={() => setEditingZoneId(null)}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-48"
          style={{ background: "linear-gradient(to bottom, transparent, var(--background, #000))" }}
        />
        <button
          type="button"
          onClick={() =>
            document.getElementById("leaderboard-section")?.scrollIntoView({ behavior: "smooth" })
          }
          className="absolute bottom-5 left-1/2 z-10 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full active:opacity-70"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border-container)",
            color: "var(--text-secondary)",
          }}
          aria-label="Scroll to leaderboard"
        >
          <ChevronDownIcon />
        </button>
      </div>

      <LeaderboardSection zones={zones} players={players} onPlayerClick={setSelectedPlayerId} />

      <div style={{ background: "var(--background, #000)" }}>
        <div className="mx-auto max-w-2xl px-5 pb-12">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="h-14 w-full rounded-2xl text-sm font-bold uppercase tracking-wider transition-colors duration-150 active:opacity-80"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border-container)", color: "var(--text-secondary)" }}
          >
            Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SettingsScreen
          player={currentPlayer}
          onClose={() => setSettingsOpen(false)}
          onLoggedOut={onLoggedOut}
          onProfileUpdated={refreshPlayers}
        />
      )}

      {pendingZoneDraft && (
        <CreateZoneForm
          draft={pendingZoneDraft}
          existingZone={editingSourceZone}
          submitting={zoneFormSubmitting}
          error={zoneFormError}
          onCancel={() => {
            setPendingZoneDraft(null);
            setEditingZoneId(null);
            setZoneFormError(null);
          }}
          onSubmit={handleZoneDraftSubmit}
        />
      )}

      {selectedPlayer && (
        <PlayerProfile
          player={selectedPlayer}
          zones={selectedPlayerZones}
          onClose={() => setSelectedPlayerId(null)}
          onZoneClick={setSelectedZoneId}
        />
      )}

      {selectedZone && !contest && !mutinyScreenZoneId && !uprisingScreenZoneId && !plunderOffer && !showCaptureFlow && !result && (
        <ZoneDetailSheet
          zone={selectedZone}
          players={players}
          currentPlayerId={currentPlayer.id}
          onClose={() => setSelectedZoneId(null)}
          onCapture={() => handleCapture(selectedZone)}
          capturing={capturingZoneId === selectedZone.id}
          inContest={selectedZoneInContest}
          onRejoinContest={() => handleRejoinContest(selectedZone)}
          isAdmin={isAdmin}
          onEdit={() => {
            setEditingZoneId(selectedZone.id);
            setSelectedZoneId(null);
          }}
          onDelete={handleDeleteZone}
          deleting={deletingZone}
          ownerIsRuler={Boolean(selectedZone.ownerId && homeZonesRuledCount(selectedZone.ownerId, zones) > 1)}
          onGift={(toPlayerId) => handleGiftZone(selectedZone, toPlayerId)}
          gifting={giftSubmitting}
          giftError={giftError}
          onViewUprising={() => handleViewUprising(selectedZone)}
          onViewMutiny={() => handleViewMutiny(selectedZone)}
          onRename={(nickname) => handleRenameZone(selectedZone, nickname)}
          renaming={renameSubmitting}
          renameError={renameError}
        />
      )}

      {plunderZone && plunderFromPlayer && plunderOffer && (
        <PlunderPickerScreen
          zoneName={plunderZone.nickname ?? plunderZone.name}
          fromPlayer={plunderFromPlayer}
          eligibleZones={plunderEligibleZones}
          deadline={plunderOffer.deadline}
          onConfirm={handleConfirmPlunder}
          onSkip={handleSkipPlunder}
          submitting={plunderSubmitting}
          error={plunderError}
        />
      )}

      {uprisingScreenZone && (
        <UprisingScreen
          zone={uprisingScreenZone}
          players={players}
          currentPlayerId={currentPlayer.id}
          onStart={() => handleStartUprising(uprisingScreenZone)}
          onPledge={() => handlePledgeUprising(uprisingScreenZone)}
          onClose={() => setUprisingScreenZoneId(null)}
          submitting={uprisingSubmitting}
          error={uprisingError}
        />
      )}

      {mutinyScreenZone && mutinyPendingRevealDuel ? (
        // Takes priority over everything else below, same as
        // pendingRevealMatch does for regular contests — a duel that just
        // resolved must actually be seen before the screen moves on to
        // whatever's next (a new duel, or the Mutiny ending outright).
        <ContestFightScreen
          zone={mutinyScreenZone}
          match={mutinyPendingRevealDuel}
          players={players}
          currentPlayerId={currentPlayer.id}
          onPick={() => {}}
          onContinue={() => handleContinueMutinyDuel(mutinyPendingRevealDuel.id)}
          onClose={() => {
            setMutinyScreenZoneId(null);
            setMutiny(null);
          }}
          title="Mutiny!"
        />
      ) : showMutinyOutcome && mutinyOutcome ? (
        <MutinyOutcomeScreen
          title={mutinyOutcome.title}
          message={mutinyOutcome.message}
          positive={mutinyOutcome.positive}
          onDismiss={handleAcknowledgeMutinyOutcome}
        />
      ) : mutinyScreenZone && mutinyCurrentDuel && iAmInMutinyDuel ? (
        <ContestFightScreen
          zone={mutinyScreenZone}
          match={mutinyCurrentDuel}
          players={players}
          currentPlayerId={currentPlayer.id}
          onPick={(move) => handleSubmitMutinyMove(mutinyCurrentDuel.id, move)}
          submitting={mutinyMoveSubmitting}
          error={mutinyMoveError}
          onClose={() => {
            setMutinyScreenZoneId(null);
            setMutiny(null);
          }}
          title="Mutiny!"
        />
      ) : (
        mutinyScreenZone && (
          <MutinyRallyScreen
            zone={mutinyScreenZone}
            mutiny={mutiny}
            players={players}
            currentPlayerId={currentPlayer.id}
            onStart={() => handleStartMutiny(mutinyScreenZone)}
            onJoin={() => handleJoinMutinyCrew(mutinyScreenZone)}
            onClose={() => {
              setMutinyScreenZoneId(null);
              setMutiny(null);
            }}
            submitting={mutinyActionSubmitting}
            error={mutinyActionError}
            isAdmin={isAdmin}
            onCancel={() => mutiny && handleCancelMutiny(mutiny.id)}
            cancelling={mutinyCancelling}
            cancelError={mutinyCancelError}
          />
        )
      )}

      {uprisingResult && (
        <UprisingResultScreen
          player={uprisingResult.player}
          zoneName={uprisingResult.zoneName}
          onDismiss={() => setUprisingResult(null)}
        />
      )}

      {uprisingLossNotice && (
        <MutinyOutcomeScreen
          title="Throne Lost"
          message={`An Uprising reclaimed ${uprisingLossNotice.zoneName} from you.`}
          positive={false}
          onDismiss={() => setUprisingLossNotice(null)}
        />
      )}

      {bossRaidLossNotice && (
        <MutinyOutcomeScreen
          title="Throne Lost"
          message={`${bossRaidLossNotice.zoneName} was taken from you.`}
          positive={false}
          onDismiss={() => setBossRaidLossNotice(null)}
        />
      )}

      {giftSentNotice && (
        <MutinyOutcomeScreen
          title="Gift Sent"
          message={`You gave ${giftSentNotice.zoneName} to ${giftSentNotice.recipientName}.`}
          positive={true}
          onDismiss={() => setGiftSentNotice(null)}
        />
      )}

      {giftReceivedNotice && (
        <MutinyOutcomeScreen
          title="Zone Gifted"
          message={`${giftReceivedNotice.giverName} gave you ${giftReceivedNotice.zoneName}.`}
          positive={true}
          onDismiss={() => setGiftReceivedNotice(null)}
        />
      )}

      {curseNotice && <CursedModal message={curseNotice} onDismiss={() => setCurseNotice(null)} />}
      {locationNotice && <LocationRequiredModal message={locationNotice} onDismiss={() => setLocationNotice(null)} />}

      {contestZone && contest && !showCaptureFlow && !result && contest.status === "joining" && (
        <ContestJoinScreen zone={contestZone} contest={contest} players={players} onClose={() => setContest(null)} />
      )}

      {contestZone && contest && pendingRevealMatch && !showCaptureFlow && !result && (
        <ContestFightScreen
          zone={contestZone}
          match={pendingRevealMatch}
          players={players}
          currentPlayerId={currentPlayer.id}
          onPick={() => {}}
          onContinue={() => handleContinueMatch(pendingRevealMatch.id)}
          onClose={() => setContest(null)}
        />
      )}

      {contestZone &&
        contest &&
        !pendingRevealMatch &&
        !showCaptureFlow &&
        !result &&
        contest.status === "battling" &&
        contestMyMatch && (
          <ContestFightScreen
            zone={contestZone}
            match={contestMyMatch}
            players={players}
            currentPlayerId={currentPlayer.id}
            onPick={(move) => handlePickMove(contestMyMatch.id, move)}
            submitting={pickSubmitting}
            error={displayedPickError}
            onClose={() => setContest(null)}
          />
        )}

      {contestZone &&
        contest &&
        !pendingRevealMatch &&
        !showCaptureFlow &&
        !result &&
        contest.status === "battling" &&
        !contestMyMatch && (
          <ContestSpectatorScreen
            zone={contestZone}
            contest={contest}
            players={players}
            currentPlayerId={currentPlayer.id}
            onClose={() => setContest(null)}
          />
        )}

      {contestZone && contest && showVictoryScreen && !result && (
        <ContestVictoryScreen
          zone={contestZone}
          defended={false}
          onContinue={() => setAcknowledgedVictoryContestId(contest.id)}
        />
      )}

      {contestZone && contest && showDefendedScreen && !result && (
        <ContestVictoryScreen zone={contestZone} defended onContinue={handleAcknowledgeDefense} />
      )}

      {contestZone &&
        contest &&
        !pendingRevealMatch &&
        !showCaptureFlow &&
        !showVictoryScreen &&
        !result &&
        contest.status === "awaiting_proof" &&
        contestWinner && (
          <ContestWaitingOnWinnerScreen zone={contestZone} winner={contestWinner} onClose={() => setContest(null)} />
        )}

      {selectedZone && showCaptureFlow && (
        <CaptureFlow
          zone={selectedZone}
          // If this is a contest win, closing doesn't do anything visible —
          // showCaptureFlow stays true via contestNeedsMyProof, since
          // submitting proof is mandatory to actually claim the zone. For a
          // direct/instant capture (contest === null) this just closes it.
          onClose={() => setCaptureOpen(false)}
          onSubmit={handleSubmitCapture}
          submitting={captureSubmitting}
          error={captureError}
        />
      )}

      {result && (
        <CaptureResult
          player={currentPlayer}
          zoneName={result.zoneName}
          caption={result.caption}
          photoUrl={result.photoUrl}
          onDismiss={handleDismissResult}
          isHit={result.isHit}
          bossHp={result.bossHp}
          bossMaxHp={result.bossMaxHp}
          plunderedZoneNames={result.plunderedZoneNames}
        />
      )}

      {phantomOverlay && (
        <div className="fixed inset-0 z-40" style={{ background: "var(--background, #000)" }} aria-hidden="true" />
      )}
    </div>
  );
}
