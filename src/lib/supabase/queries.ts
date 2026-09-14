import { supabase } from "./client";
import { getSessionToken } from "@/lib/session";
import type {
  ActiveContestSummary,
  ActiveMutinySummary,
  CaptureEvent,
  Contest,
  ContestMatch,
  ContestNeedsAction,
  ContestStatus,
  LngLat,
  Mutiny,
  MutinyDuel,
  MutinyNeedsAction,
  MutinyStatus,
  Place,
  Player,
  RpsMove,
  Tier,
  Uprising,
  UprisingStatus,
  Zone,
} from "@/lib/types";

interface PlaceRow {
  id: string;
  name: string;
  location: LngLat | null;
}

interface CaptureEventRow {
  id: string;
  place_id: string;
  place_name: string;
  player_id: string;
  caption: string;
  photo_url: string | null;
  previous_owner_id: string | null;
  created_at: string;
  is_hit: boolean;
  is_plunder: boolean;
  is_uprising: boolean;
  is_mutiny: boolean;
  is_gift: boolean;
}

interface ZoneRow {
  id: string;
  name: string;
  nickname: string | null;
  tier: Tier;
  owner_id: string | null;
  polygon: LngLat[];
  active_contest_id: string | null;
  active_contest_status: ContestStatus | null;
  active_contest_participant_ids: string[];
  boss_hp: number | null;
  boss_max_hp: number | null;
  last_attacker_id: string | null;
  original_owner_id: string | null;
  my_cooldown_until: string | null;
  pending_plunder_from_id: string | null;
  pending_plunder_deadline: string | null;
  capture_cooldown_until: string | null;
  active_uprising_id: string | null;
  active_uprising_deadline: string | null;
  active_uprising_threshold: number | null;
  active_uprising_supporter_count: number | null;
  active_uprising_supporter_ids: string[];
  active_mutiny_id: string | null;
  active_mutiny_instigator_id: string | null;
  active_mutiny_status: MutinyStatus | null;
  active_mutiny_rally_deadline: string | null;
  active_mutiny_crew_ids: string[];
  places: PlaceRow[];
  capture_events: CaptureEventRow[];
}

interface PlayerRow {
  id: string;
  name: string;
  color: string;
  initials: string;
  avatar_url: string | null;
  is_admin: boolean;
  cursed_until: string | null;
}

function rowToPlace(row: PlaceRow): Place {
  return { id: row.id, name: row.name, location: row.location ?? undefined };
}

function rowToCaptureEvent(row: CaptureEventRow): CaptureEvent {
  return {
    id: row.id,
    placeId: row.place_id,
    placeName: row.place_name,
    playerId: row.player_id,
    caption: row.caption,
    photoUrl: row.photo_url,
    timestamp: new Date(row.created_at).getTime(),
    previousOwnerId: row.previous_owner_id,
    isHit: row.is_hit,
    isPlunder: row.is_plunder,
    isUprising: row.is_uprising,
    isMutiny: row.is_mutiny,
    isGift: row.is_gift,
  };
}

function rowToZone(row: ZoneRow): Zone {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    tier: row.tier,
    ownerId: row.owner_id,
    polygon: row.polygon,
    activeContestId: row.active_contest_id,
    activeContestStatus: row.active_contest_status,
    activeContestParticipantIds: row.active_contest_participant_ids ?? [],
    bossHp: row.boss_hp,
    bossMaxHp: row.boss_max_hp,
    lastAttackerId: row.last_attacker_id,
    originalOwnerId: row.original_owner_id,
    myCooldownUntil: row.my_cooldown_until ? new Date(row.my_cooldown_until).getTime() : null,
    pendingPlunderFromId: row.pending_plunder_from_id,
    pendingPlunderDeadline: row.pending_plunder_deadline ? new Date(row.pending_plunder_deadline).getTime() : null,
    captureCooldownUntil: row.capture_cooldown_until ? new Date(row.capture_cooldown_until).getTime() : null,
    activeUprisingId: row.active_uprising_id,
    activeUprisingDeadline: row.active_uprising_deadline ? new Date(row.active_uprising_deadline).getTime() : null,
    activeUprisingThreshold: row.active_uprising_threshold,
    activeUprisingSupporterCount: row.active_uprising_supporter_count ?? 0,
    activeUprisingSupporterIds: row.active_uprising_supporter_ids ?? [],
    activeMutinyId: row.active_mutiny_id,
    activeMutinyInstigatorId: row.active_mutiny_instigator_id,
    activeMutinyStatus: row.active_mutiny_status,
    activeMutinyRallyDeadline: row.active_mutiny_rally_deadline
      ? new Date(row.active_mutiny_rally_deadline).getTime()
      : null,
    activeMutinyCrewIds: row.active_mutiny_crew_ids ?? [],
    places: (row.places ?? []).map(rowToPlace),
    history: (row.capture_events ?? []).map(rowToCaptureEvent).sort((a, b) => a.timestamp - b.timestamp),
  };
}

interface ContestMatchPayload {
  id: string;
  round: number;
  playerAId: string;
  playerBId: string | null;
  myMove: RpsMove | null;
  opponentHasMoved: boolean | null;
  opponentMove: RpsMove | null;
  tieCount: number;
  pickDeadline: string | null;
  winnerId: string | null;
  resolvedAt: string | null;
}

export interface ContestPayload {
  id: string;
  zoneId: string;
  status: ContestStatus;
  currentRound: number;
  joinDeadline: string;
  winnerId: string | null;
  participantIds: string[];
  matches: ContestMatchPayload[];
  mode?: "instant" | "joined" | "spectate";
}

function payloadToMatch(row: ContestMatchPayload): ContestMatch {
  return {
    id: row.id,
    round: row.round,
    playerAId: row.playerAId,
    playerBId: row.playerBId,
    myMove: row.myMove,
    opponentHasMoved: row.opponentHasMoved,
    opponentMove: row.opponentMove,
    tieCount: row.tieCount,
    pickDeadline: row.pickDeadline ? new Date(row.pickDeadline).getTime() : null,
    winnerId: row.winnerId,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).getTime() : null,
  };
}

export function payloadToContest(row: ContestPayload): Contest {
  return {
    id: row.id,
    zoneId: row.zoneId,
    status: row.status,
    currentRound: row.currentRound,
    joinDeadline: new Date(row.joinDeadline).getTime(),
    winnerId: row.winnerId,
    participantIds: row.participantIds ?? [],
    matches: (row.matches ?? []).map(payloadToMatch),
    mode: row.mode,
  };
}

interface ActiveContestSummaryPayload {
  contestId: string;
  zoneId: string;
  status: ContestStatus;
  needsAction: ContestNeedsAction;
}

function payloadToActiveContestSummary(row: ActiveContestSummaryPayload): ActiveContestSummary {
  return {
    contestId: row.contestId,
    zoneId: row.zoneId,
    status: row.status,
    needsAction: row.needsAction,
  };
}

function rowToPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    initials: row.initials,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin,
    cursedUntil: row.cursed_until ? new Date(row.cursed_until).getTime() : null,
  };
}

interface MutinyDuelPayload {
  id: string;
  round: number;
  playerAId: string;
  playerBId: string | null;
  myMove: RpsMove | null;
  opponentHasMoved: boolean | null;
  opponentMove: RpsMove | null;
  tieCount: number;
  pickDeadline: string | null;
  winnerId: string | null;
  resolvedAt: string | null;
}

export interface MutinyPayload {
  id: string;
  zoneId: string;
  status: MutinyStatus;
  instigatorId: string;
  rallyDeadline: string;
  crewIds: string[];
  duels: MutinyDuelPayload[];
}

function payloadToMutinyDuel(row: MutinyDuelPayload): MutinyDuel {
  return {
    id: row.id,
    round: row.round,
    playerAId: row.playerAId,
    playerBId: row.playerBId,
    myMove: row.myMove,
    opponentHasMoved: row.opponentHasMoved,
    opponentMove: row.opponentMove,
    tieCount: row.tieCount,
    pickDeadline: row.pickDeadline ? new Date(row.pickDeadline).getTime() : null,
    winnerId: row.winnerId,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).getTime() : null,
  };
}

export function payloadToMutiny(row: MutinyPayload): Mutiny {
  return {
    id: row.id,
    zoneId: row.zoneId,
    status: row.status,
    instigatorId: row.instigatorId,
    rallyDeadline: new Date(row.rallyDeadline).getTime(),
    crewIds: row.crewIds ?? [],
    duels: (row.duels ?? []).map(payloadToMutinyDuel),
  };
}

export interface UprisingPayload {
  id: string;
  zoneId: string;
  status: UprisingStatus;
  threshold: number;
  supporterCount: number;
  deadline: string;
}

export function payloadToUprising(row: UprisingPayload): Uprising {
  return {
    id: row.id,
    zoneId: row.zoneId,
    status: row.status,
    threshold: row.threshold,
    supporterCount: row.supporterCount,
    deadline: new Date(row.deadline).getTime(),
  };
}

interface ActiveMutinySummaryPayload {
  mutinyId: string;
  zoneId: string;
  status: MutinyStatus;
  needsAction: MutinyNeedsAction;
}

function payloadToActiveMutinySummary(row: ActiveMutinySummaryPayload): ActiveMutinySummary {
  return {
    mutinyId: row.mutinyId,
    zoneId: row.zoneId,
    status: row.status,
    needsAction: row.needsAction,
  };
}

export async function whoAmI(): Promise<Player | null> {
  const token = getSessionToken();
  if (!token) return null;
  const { data, error } = await supabase.rpc("whoami", { p_session_token: token });
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as PlayerRow | undefined;
  return row ? rowToPlayer(row) : null;
}

export async function fetchPlayers(): Promise<Player[]> {
  const { data, error } = await supabase.rpc("get_players", { p_session_token: getSessionToken() });
  if (error) throw new Error(error.message);
  return ((data ?? []) as PlayerRow[]).map(rowToPlayer);
}

export async function fetchZones(): Promise<Zone[]> {
  const { data, error } = await supabase.rpc("get_zones", { p_session_token: getSessionToken() });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ZoneRow[]).map(rowToZone);
}

export async function fetchContest(contestId: string): Promise<Contest> {
  const { data, error } = await supabase.rpc("get_contest", {
    p_session_token: getSessionToken(),
    p_contest_id: contestId,
  });
  if (error) throw new Error(error.message);
  return payloadToContest(data as ContestPayload);
}

export async function fetchMyActiveContests(): Promise<ActiveContestSummary[]> {
  const { data, error } = await supabase.rpc("get_my_active_contests", { p_session_token: getSessionToken() });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ActiveContestSummaryPayload[]).map(payloadToActiveContestSummary);
}

export async function fetchMutiny(mutinyId: string): Promise<Mutiny> {
  const { data, error } = await supabase.rpc("get_mutiny", {
    p_session_token: getSessionToken(),
    p_mutiny_id: mutinyId,
  });
  if (error) throw new Error(error.message);
  return payloadToMutiny(data as MutinyPayload);
}

export async function fetchMyActiveMutinies(): Promise<ActiveMutinySummary[]> {
  const { data, error } = await supabase.rpc("get_my_active_mutinies", { p_session_token: getSessionToken() });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ActiveMutinySummaryPayload[]).map(payloadToActiveMutinySummary);
}
