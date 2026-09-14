export type Tier = "regular" | "home" | "invaded";

export type LngLat = [number, number];

export interface Player {
  id: string;
  name: string;
  color: string;
  initials: string;
  // Set at signup or later; null falls back to the initials+color avatar.
  avatarUrl: string | null;
  isAdmin?: boolean;
  // Set for 2h whenever this player is dethroned from a home/invaded zone
  // (Boss Raid, Mutiny, or Uprising) — blocks every capture/mutiny entry
  // point until it passes.
  cursedUntil: number | null;
}

export interface Place {
  id: string;
  name: string;
  // Only set for places created via the map pin tool — older/seed places
  // are just named list entries with no location on record.
  location?: LngLat;
}

export interface CaptureEvent {
  id: string;
  placeId: string;
  placeName: string;
  playerId: string;
  caption: string;
  photoUrl: string | null;
  timestamp: number;
  previousOwnerId: string | null;
  // A Boss Raid hit that didn't finish the boss off — no ownership change.
  isHit: boolean;
  // A zone seized as spoils after a Boss Raid finishing blow (see
  // pendingPlunderFromId below), not fought for directly.
  isPlunder: boolean;
  // The original owner reclaiming their zone via Uprising.
  isUprising: boolean;
  // A Mutiny's winning duel — always credited to the instigator.
  isMutiny: boolean;
  // A plain player-to-player zone transfer (see transferZone).
  isGift: boolean;
}

export type MutinyStatus = "rallying" | "dueling" | "succeeded" | "failed" | "cancelled";
export type UprisingStatus = "gathering" | "succeeded" | "expired" | "cancelled";

export interface Zone {
  id: string;
  name: string;
  nickname: string | null;
  tier: Tier;
  ownerId: string | null;
  polygon: LngLat[];
  places: Place[];
  history: CaptureEvent[];
  // Set while a regular-zone capture contest is joining/battling/awaiting
  // proof; null once it's completed (or if it was never contested).
  activeContestId: string | null;
  // Status of that same contest — lets the UI tell "the join window is
  // still open" apart from "this is already battling/awaiting proof"
  // without a round trip (e.g. to pick the right zone-detail button label).
  activeContestStatus: ContestStatus | null;
  // Player ids currently in that contest (empty when activeContestId is
  // null). Includes just the instant-capturer during the uncontested part
  // of the window; more than one only once someone's actually contesting.
  activeContestParticipantIds: string[];
  // Boss Raid state — null unless tier is "home" or "invaded" (stale/unused
  // once "invaded", since Mutiny doesn't touch these fields).
  bossHp: number | null;
  bossMaxHp: number | null;
  lastAttackerId: string | null;
  // Who first captured this zone from unclaimed — set once, never changes.
  // A "home"-tier zone's ownerId always equals originalOwnerId; null for
  // regular zones.
  originalOwnerId: string | null;
  // The current player's own Boss Raid cooldown on this zone, if any.
  myCooldownUntil: number | null;
  // Open "choose your spoils" offer after a Boss Raid finishing blow —
  // both null once expired or claimed.
  pendingPlunderFromId: string | null;
  pendingPlunderDeadline: number | null;
  // Anti-ping-pong: set for 2h after every regular-zone capture (once any
  // contest for it settles), null once it passes. Only ever set for
  // "regular" zones — home/invaded zones use the curse/Boss Raid cooldown
  // instead.
  captureCooldownUntil: number | null;
  // Uprising summary — only ever set while tier is "invaded".
  activeUprisingId: string | null;
  activeUprisingDeadline: number | null;
  activeUprisingThreshold: number | null;
  activeUprisingSupporterCount: number;
  activeUprisingSupporterIds: string[];
  // Mutiny summary — only ever set while tier is "invaded".
  activeMutinyId: string | null;
  activeMutinyInstigatorId: string | null;
  activeMutinyStatus: MutinyStatus | null;
  // Only set while status is "rallying" — once dueling starts there's no
  // rally window left to count down.
  activeMutinyRallyDeadline: number | null;
  activeMutinyCrewIds: string[];
}

export type ContestStatus = "joining" | "battling" | "awaiting_proof" | "completed" | "cancelled";
export type RpsMove = "rock" | "paper" | "scissors";
export type ContestNeedsAction = "needs_pick" | "needs_proof" | "contested" | "waiting";

export interface ContestMatch {
  id: string;
  round: number;
  playerAId: string;
  playerBId: string | null; // null = bye
  myMove: RpsMove | null;
  opponentHasMoved: boolean | null;
  opponentMove: RpsMove | null; // only ever populated once resolvedAt is set
  tieCount: number;
  pickDeadline: number | null;
  winnerId: string | null;
  resolvedAt: number | null;
}

export interface Contest {
  id: string;
  zoneId: string;
  status: ContestStatus;
  currentRound: number;
  joinDeadline: number;
  winnerId: string | null;
  participantIds: string[];
  matches: ContestMatch[];
  // Only present on the response from attemptCaptureZone.
  mode?: "instant" | "joined" | "spectate";
}

export interface ActiveContestSummary {
  contestId: string;
  zoneId: string;
  status: ContestStatus;
  needsAction: ContestNeedsAction;
}

// Shaped identically to ContestMatch (playerAId = incumbent, playerBId =
// challenger) on purpose — get_mutiny returns duels in this shape
// specifically so ContestFightScreen can render one directly.
export interface MutinyDuel {
  id: string;
  round: number;
  playerAId: string;
  playerBId: string | null;
  myMove: RpsMove | null;
  opponentHasMoved: boolean | null;
  opponentMove: RpsMove | null;
  tieCount: number;
  pickDeadline: number | null;
  winnerId: string | null;
  resolvedAt: number | null;
}

export interface Mutiny {
  id: string;
  zoneId: string;
  status: MutinyStatus;
  instigatorId: string;
  rallyDeadline: number;
  // In duel order: recruits by join order, then (implicitly) the instigator.
  crewIds: string[];
  // Every duel this Mutiny has had, oldest first (mirrors Contest.matches)
  // — lets the client hold each one's own win/lose reveal open instead of
  // only ever seeing whichever duel happens to be "current" right now.
  duels: MutinyDuel[];
}

export interface Uprising {
  id: string;
  zoneId: string;
  status: UprisingStatus;
  threshold: number;
  supporterCount: number;
  deadline: number;
}

export type MutinyNeedsAction = "needs_pick" | "watching" | "waiting";

export interface ActiveMutinySummary {
  mutinyId: string;
  zoneId: string;
  status: MutinyStatus;
  needsAction: MutinyNeedsAction;
}
