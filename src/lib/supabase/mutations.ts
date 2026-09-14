import { supabase } from "./client";
import { PLAYER_COLOR_PALETTE } from "@/lib/constants";
import { resizeImage } from "@/lib/image";
import { clearSessionToken, getSessionToken, setSessionToken } from "@/lib/session";
import type { Contest, LngLat, Mutiny, RpsMove, Uprising } from "@/lib/types";
import {
  payloadToContest,
  payloadToMutiny,
  payloadToUprising,
  type ContestPayload,
  type MutinyPayload,
  type UprisingPayload,
} from "./queries";

const CAPTURE_PHOTO_MAX_DIMENSION = 1600;
const AVATAR_MAX_DIMENSION = 800;

function colorForName(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PLAYER_COLOR_PALETTE[hash % PLAYER_COLOR_PALETTE.length];
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// Supabase Storage keys reject spaces, unicode, and other punctuation that
// real-world filenames are full of (screenshots in particular) — so upload
// paths never use the original filename, only a sanitized extension.
function fileExtension(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "jpg";
}

interface AuthRow {
  id: string;
  name: string;
  session_token: string;
  is_admin: boolean;
}

function firstRow<T>(data: T | T[] | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

export async function signUp(name: string, password: string, inviteCode: string): Promise<void> {
  const { data, error } = await supabase.rpc("sign_up", {
    p_name: name,
    p_password: password,
    p_invite_code: inviteCode,
    p_color: colorForName(name),
    p_initials: initialsForName(name),
  });
  if (error) throw new Error(error.message);
  const row = firstRow<AuthRow>(data);
  if (!row?.session_token) throw new Error("Sign up failed.");
  setSessionToken(row.session_token);
}

export async function signIn(name: string, password: string): Promise<void> {
  const { data, error } = await supabase.rpc("log_in", { p_name: name, p_password: password });
  if (error) throw new Error("Wrong name or password.");
  const row = firstRow<AuthRow>(data);
  if (!row?.session_token) throw new Error("Wrong name or password.");
  setSessionToken(row.session_token);
}

export async function signOut(): Promise<void> {
  const token = getSessionToken();
  clearSessionToken();
  if (token) {
    try {
      await supabase.rpc("log_out", { p_session_token: token });
    } catch {
      // Best-effort — the client-side token is already cleared either way.
    }
  }
}

export async function updateName(name: string): Promise<void> {
  const token = getSessionToken();
  if (!token) throw new Error("Not logged in.");
  const { error } = await supabase.rpc("update_name", { p_session_token: token, p_name: name });
  if (error) throw new Error(error.message);
}

export async function uploadAvatar(file: File): Promise<void> {
  const token = getSessionToken();
  if (!token) throw new Error("Not logged in.");

  const resized = await resizeImage(file, AVATAR_MAX_DIMENSION);
  const path = `${token}/avatar.${fileExtension(resized.name)}`;
  const { error: uploadError } = await supabase.storage.from("avatars").upload(path, resized, { upsert: true });
  if (uploadError) throw uploadError;
  const { data: publicUrlData } = supabase.storage.from("avatars").getPublicUrl(path);

  const { error } = await supabase.rpc("set_avatar", {
    p_session_token: token,
    p_avatar_url: publicUrlData.publicUrl,
  });
  if (error) throw new Error(error.message);
}

interface DraftPlaceInput {
  id: string | null;
  name: string;
  location: LngLat | null;
}

export async function createZone(input: {
  id: string;
  name: string;
  nickname: string | null;
  polygon: LngLat[];
  places: DraftPlaceInput[];
}): Promise<void> {
  const { error } = await supabase.rpc("create_zone", {
    p_session_token: getSessionToken(),
    p_id: input.id,
    p_name: input.name,
    p_nickname: input.nickname,
    p_polygon: input.polygon,
    p_places: input.places,
  });
  if (error) throw new Error(error.message);
}

export async function updateZone(input: {
  id: string;
  name: string;
  nickname: string | null;
  polygon: LngLat[];
  places: DraftPlaceInput[];
}): Promise<void> {
  const { error } = await supabase.rpc("update_zone", {
    p_session_token: getSessionToken(),
    p_id: input.id,
    p_name: input.name,
    p_nickname: input.nickname,
    p_polygon: input.polygon,
    p_places: input.places,
  });
  if (error) throw new Error(error.message);
}

export async function deleteZone(zoneId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_zone", {
    p_session_token: getSessionToken(),
    p_zone_id: zoneId,
  });
  if (error) throw new Error(error.message);
}

export async function captureZone(input: {
  placeId: string;
  caption: string;
  photoFile: File | null;
  nickname: string;
}): Promise<void> {
  const token = getSessionToken();
  if (!token) throw new Error("Not logged in.");

  let photoUrl: string | null = null;
  if (input.photoFile) {
    const resized = await resizeImage(input.photoFile, CAPTURE_PHOTO_MAX_DIMENSION);
    const path = `${token}/${Date.now()}.${fileExtension(resized.name)}`;
    const { error: uploadError } = await supabase.storage.from("captures").upload(path, resized);
    if (uploadError) throw uploadError;
    const { data: publicUrlData } = supabase.storage.from("captures").getPublicUrl(path);
    photoUrl = publicUrlData.publicUrl;
  }

  const { error } = await supabase.rpc("capture_zone", {
    p_session_token: token,
    p_place_id: input.placeId,
    p_caption: input.caption,
    p_photo_url: photoUrl,
    p_nickname: input.nickname,
  });
  if (error) throw new Error(error.message);
}

export async function attemptCaptureZone(zoneId: string): Promise<Contest> {
  const { data, error } = await supabase.rpc("attempt_capture_zone", {
    p_session_token: getSessionToken(),
    p_zone_id: zoneId,
  });
  if (error) throw new Error(error.message);
  return payloadToContest(data as ContestPayload);
}

export async function submitRpsMove(matchId: string, move: RpsMove): Promise<Contest> {
  const { data, error } = await supabase.rpc("submit_rps_move", {
    p_session_token: getSessionToken(),
    p_match_id: matchId,
    p_move: move,
  });
  if (error) throw new Error(error.message);
  return payloadToContest(data as ContestPayload);
}

export async function finalizeCaptureFromContest(input: {
  contestId: string;
  placeId: string;
  caption: string;
  photoFile: File | null;
  nickname: string;
}): Promise<void> {
  const token = getSessionToken();
  if (!token) throw new Error("Not logged in.");

  let photoUrl: string | null = null;
  if (input.photoFile) {
    const resized = await resizeImage(input.photoFile, CAPTURE_PHOTO_MAX_DIMENSION);
    const path = `${token}/${Date.now()}.${fileExtension(resized.name)}`;
    const { error: uploadError } = await supabase.storage.from("captures").upload(path, resized);
    if (uploadError) throw uploadError;
    const { data: publicUrlData } = supabase.storage.from("captures").getPublicUrl(path);
    photoUrl = publicUrlData.publicUrl;
  }

  const { error } = await supabase.rpc("finalize_capture_from_contest", {
    p_session_token: token,
    p_contest_id: input.contestId,
    p_place_id: input.placeId,
    p_caption: input.caption,
    p_photo_url: photoUrl,
    p_nickname: input.nickname,
  });
  if (error) throw new Error(error.message);
}

interface PlunderResult {
  plundered_zones: { id: string; name: string }[];
}

export async function claimPlunder(input: { zoneId: string; zoneIds: string[] }): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.rpc("claim_plunder", {
    p_session_token: getSessionToken(),
    p_zone_id: input.zoneId,
    p_zone_ids: input.zoneIds,
  });
  if (error) throw new Error(error.message);
  return ((data as PlunderResult | null)?.plundered_zones ?? []);
}

export async function transferZone(input: { zoneId: string; toPlayerId: string }): Promise<void> {
  const { error } = await supabase.rpc("transfer_zone", {
    p_session_token: getSessionToken(),
    p_zone_id: input.zoneId,
    p_to_player_id: input.toPlayerId,
  });
  if (error) throw new Error(error.message);
}

export async function startUprising(zoneId: string): Promise<Uprising> {
  const { data, error } = await supabase.rpc("start_uprising", {
    p_session_token: getSessionToken(),
    p_zone_id: zoneId,
  });
  if (error) throw new Error(error.message);
  return payloadToUprising(data as UprisingPayload);
}

export async function pledgeUprisingSupport(uprisingId: string): Promise<Uprising> {
  const { data, error } = await supabase.rpc("pledge_uprising_support", {
    p_session_token: getSessionToken(),
    p_uprising_id: uprisingId,
  });
  if (error) throw new Error(error.message);
  return payloadToUprising(data as UprisingPayload);
}

export async function startMutiny(zoneId: string): Promise<Mutiny> {
  const { data, error } = await supabase.rpc("start_mutiny", {
    p_session_token: getSessionToken(),
    p_zone_id: zoneId,
  });
  if (error) throw new Error(error.message);
  return payloadToMutiny(data as MutinyPayload);
}

export async function joinMutinyCrew(mutinyId: string): Promise<void> {
  const { error } = await supabase.rpc("join_mutiny_crew", {
    p_session_token: getSessionToken(),
    p_mutiny_id: mutinyId,
  });
  if (error) throw new Error(error.message);
}

export async function submitMutinyMove(duelId: string, move: RpsMove): Promise<Mutiny> {
  const { data, error } = await supabase.rpc("submit_mutiny_move", {
    p_session_token: getSessionToken(),
    p_duel_id: duelId,
    p_move: move,
  });
  if (error) throw new Error(error.message);
  return payloadToMutiny(data as MutinyPayload);
}

export async function cancelMutiny(mutinyId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_mutiny", {
    p_session_token: getSessionToken(),
    p_mutiny_id: mutinyId,
  });
  if (error) throw new Error(error.message);
}
