-- Fixes a real bug in the contest guard shipped in 02_contests.sql: the
-- original instant-capturer's own `capture_zone` submission was rejected
-- as soon as ANY second player joined the same 1-minute window, because
-- the guard checked "is the participant count still 1" instead of "is this
-- caller the one who's actually allowed to finalize instantly." The
-- moment a second player joins, the count becomes 2 and the original
-- (legitimate, first) capturer gets incorrectly told the zone is already
-- contested — even though the join window is still open and they're the
-- one it was opened for.
--
-- Fix: track who's allowed to instant-capture explicitly (instant_capturer_id
-- on zone_contests, set once at creation) instead of inferring it from a
-- participant count that changes as other players join.
--
-- Additive/idempotent — safe to run on top of an already-applied
-- 02_contests.sql without losing data.

alter table public.zone_contests
  add column if not exists instant_capturer_id uuid references public.players (id);

create or replace function public.attempt_capture_zone(p_session_token uuid, p_zone_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_tier text;
  v_owner_id uuid;
  v_contest_id uuid;
  v_status text;
  v_mode text;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select tier, owner_id into v_tier, v_owner_id from zones where id = p_zone_id;
  if v_tier is null then
    raise exception 'Zone not found';
  end if;
  if v_tier <> 'regular' then
    raise exception 'Home zones are captured directly.';
  end if;
  if v_owner_id = v_player_id then
    raise exception 'You already own this zone';
  end if;

  select zc.id, zc.status into v_contest_id, v_status
  from zone_contests zc
  where zc.zone_id = p_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
  for update;

  if v_contest_id is null then
    insert into zone_contests (zone_id, join_deadline, instant_capturer_id)
    values (p_zone_id, now() + interval '1 minute', v_player_id)
    on conflict (zone_id) where status in ('joining', 'battling', 'awaiting_proof')
    do nothing
    returning id, status into v_contest_id, v_status;

    if v_contest_id is not null then
      insert into zone_contest_participants (contest_id, player_id) values (v_contest_id, v_player_id);
      return public.get_contest(p_session_token, v_contest_id) || jsonb_build_object('mode', 'instant');
    end if;

    select zc.id, zc.status into v_contest_id, v_status
    from zone_contests zc
    where zc.zone_id = p_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
    for update;
  end if;

  perform public._finalize_join_window_if_due(v_contest_id);
  select status into v_status from zone_contests where id = v_contest_id;

  if v_status = 'joining' then
    insert into zone_contest_participants (contest_id, player_id)
    values (v_contest_id, v_player_id)
    on conflict do nothing;
    v_mode := 'joined';
  else
    v_mode := 'spectate';
  end if;

  return public.get_contest(p_session_token, v_contest_id) || jsonb_build_object('mode', v_mode);
end;
$$;
-- No new grant needed — signature is unchanged.

create or replace function public.capture_zone(
  p_session_token uuid,
  p_place_id text,
  p_caption text,
  p_photo_url text,
  p_nickname text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_zone_id text;
  v_tier text;
  v_contest_id uuid;
  v_status text;
  v_instant_capturer_id uuid;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select zone_id into v_zone_id from places where id = p_place_id;
  if v_zone_id is null then
    raise exception 'Place not found';
  end if;

  select tier into v_tier from zones where id = v_zone_id;

  if v_tier = 'regular' then
    select zc.id, zc.status, zc.instant_capturer_id
      into v_contest_id, v_status, v_instant_capturer_id
    from zone_contests zc
    where zc.zone_id = v_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
    for update;

    if v_contest_id is null then
      insert into zone_contests (zone_id, join_deadline, instant_capturer_id)
      values (v_zone_id, now() + interval '1 minute', v_player_id)
      on conflict (zone_id) where status in ('joining', 'battling', 'awaiting_proof')
      do nothing
      returning id, status, instant_capturer_id into v_contest_id, v_status, v_instant_capturer_id;

      if v_contest_id is null then
        select zc.id, zc.status, zc.instant_capturer_id
          into v_contest_id, v_status, v_instant_capturer_id
        from zone_contests zc
        where zc.zone_id = v_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
        for update;
      end if;
    end if;

    -- Only the designated instant-capturer can finalize this way, and only
    -- while the window is still open — regardless of how many other
    -- players have since joined. Everyone else must go through the
    -- tournament (submit_rps_move / finalize_capture_from_contest).
    if v_status = 'joining' and v_instant_capturer_id = v_player_id then
      insert into zone_contest_participants (contest_id, player_id)
      values (v_contest_id, v_player_id)
      on conflict do nothing;
    else
      raise exception 'This zone is already being contested — join the fight instead.';
    end if;
  end if;

  return public._apply_capture(v_player_id, p_place_id, p_caption, p_photo_url, p_nickname);
end;
$$;
-- No new grant needed — signature is unchanged.
