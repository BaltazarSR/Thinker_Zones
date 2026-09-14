-- Contested captures: rock-paper-scissors tournaments for regular zones.
--
-- Additive migration — safe to run once against the live database (unlike
-- 01_create.sql, this does NOT require 00_drop.sql first; nothing here
-- drops a table or touches existing rows). Run this whole file in the
-- Supabase SQL editor.
--
-- Mechanic: capturing a regular zone stays instant, exactly like before —
-- but it now also opens a 60-second background window on that zone. If a
-- second player attempts to capture within that window, everyone who
-- attempted (including the original instant-capturer) is pulled into a
-- randomized single-elimination rock-paper-scissors bracket (odd counts get
-- a random bye each round; a single win ends a match; ties replay in
-- place). Whoever wins the bracket ends up owning the zone — if that's the
-- original capturer, nothing changes; otherwise they submit their own
-- capture proof to claim it. Picks time out after 30s (forfeit). Home
-- zones are completely untouched by any of this.
--
-- (This file's definitions are folded into 01_create.sql/00_drop.sql
-- separately so a from-scratch rebuild still picks them up — that sync is
-- not required to apply this migration to the current database.)

-- ─── Tables ──────────────────────────────────────────────────────────────

create table public.zone_contests (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  status text not null default 'joining'
    check (status in ('joining', 'battling', 'awaiting_proof', 'completed', 'cancelled')),
  current_round int not null default 0,
  join_deadline timestamptz not null,
  winner_id uuid references public.players (id),
  created_at timestamptz not null default now()
);

-- One live contest per zone at a time (covers every non-terminal status).
-- The exact predicate text below is repeated verbatim in every ON CONFLICT
-- clause that targets this index — Postgres requires the wording to match.
create unique index zone_contests_active_zone_idx on public.zone_contests (zone_id)
  where status in ('joining', 'battling', 'awaiting_proof');

create table public.zone_contest_participants (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.zone_contests (id) on delete cascade,
  player_id uuid not null references public.players (id),
  joined_at timestamptz not null default now(),
  unique (contest_id, player_id)
);

create table public.zone_contest_matches (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.zone_contests (id) on delete cascade,
  round int not null,
  player_a_id uuid not null references public.players (id),
  player_b_id uuid references public.players (id), -- null = bye, auto-won by player_a
  player_a_move text check (player_a_move in ('rock', 'paper', 'scissors')),
  player_b_move text check (player_b_move in ('rock', 'paper', 'scissors')),
  tie_count int not null default 0,
  pick_deadline timestamptz, -- null for byes, which are never open for picking
  winner_id uuid references public.players (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index zone_contest_participants_contest_idx on public.zone_contest_participants (contest_id);
create index zone_contest_matches_contest_round_idx on public.zone_contest_matches (contest_id, round);

alter table public.zone_contests enable row level security;
alter table public.zone_contest_participants enable row level security;
alter table public.zone_contest_matches enable row level security;
-- Zero policies, same as every other table in this app — access only
-- through the SECURITY DEFINER RPCs below.

-- ─── Internal helpers (never granted to anon) ───────────────────────────
-- Only callable from inside another SECURITY DEFINER function's body, never
-- directly via PostgREST/.rpc().

create function public._apply_capture(
  p_player_id uuid,
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
  v_zone_id text;
  v_place_name text;
  v_previous_owner uuid;
  v_event public.capture_events;
begin
  select zone_id, name into v_zone_id, v_place_name from places where id = p_place_id;
  if v_zone_id is null then
    raise exception 'Place not found';
  end if;

  select owner_id into v_previous_owner from zones where id = v_zone_id;
  if v_previous_owner = p_player_id then
    raise exception 'You already own this zone';
  end if;

  insert into capture_events (place_id, place_name, zone_id, player_id, caption, photo_url, previous_owner_id)
  values (p_place_id, v_place_name, v_zone_id, p_player_id, coalesce(nullif(p_caption, ''), 'Zone captured.'), p_photo_url, v_previous_owner)
  returning * into v_event;

  update zones
  set owner_id = p_player_id,
      nickname = nullif(p_nickname, '')
  where id = v_zone_id;

  return jsonb_build_object(
    'id', v_event.id, 'place_id', v_event.place_id, 'place_name', v_event.place_name,
    'player_id', v_event.player_id, 'caption', v_event.caption, 'photo_url', v_event.photo_url,
    'previous_owner_id', v_event.previous_owner_id, 'created_at', v_event.created_at
  );
end;
$$;

-- Given the pool of players entering a round, either declares the overall
-- tournament winner (pool of 1) or generates that round's matches
-- (shuffle, random bye if odd, pair the rest). Called for round 1 once the
-- join window closes, and again for round N+1 whenever round N finishes.
create function public._advance_contest_round(p_contest_id uuid, p_round int, p_pool uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone_id text;
  v_owner_id uuid;
  v_winner uuid;
  v_pool uuid[];
  v_bye uuid;
  v_n int;
  i int;
begin
  select zone_id into v_zone_id from zone_contests where id = p_contest_id;

  if array_length(p_pool, 1) = 1 then
    v_winner := p_pool[1];
    select owner_id into v_owner_id from zones where id = v_zone_id;
    if v_winner = v_owner_id then
      -- The current owner defended (or nobody ever contested them) —
      -- their existing capture_events row already stands, nothing to do.
      update zone_contests set status = 'completed', winner_id = v_winner where id = p_contest_id;
    else
      update zone_contests set status = 'awaiting_proof', winner_id = v_winner where id = p_contest_id;
    end if;
    return;
  end if;

  select array_agg(x order by random()) into v_pool from unnest(p_pool) as x;
  v_n := array_length(v_pool, 1);

  if v_n % 2 = 1 then
    v_bye := v_pool[v_n];
    v_pool := v_pool[1 : v_n - 1];
    v_n := v_n - 1;
    insert into zone_contest_matches (contest_id, round, player_a_id, player_b_id, winner_id, resolved_at)
    values (p_contest_id, p_round, v_bye, null, v_bye, now());
  end if;

  i := 1;
  while i <= v_n loop
    insert into zone_contest_matches (contest_id, round, player_a_id, player_b_id, pick_deadline)
    values (p_contest_id, p_round, v_pool[i], v_pool[i + 1], now() + interval '30 seconds');
    i := i + 2;
  end loop;

  update zone_contests set status = 'battling', current_round = p_round where id = p_contest_id;
end;
$$;

-- Self-healing: no-ops unless the contest is still 'joining' and its
-- deadline has passed. Called opportunistically from get_contest and
-- attempt_capture_zone so a stale window advances the next time ANY client
-- looks at it, without needing a cron/background job (this app has none).
create function public._finalize_join_window_if_due(p_contest_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_deadline timestamptz;
  v_pool uuid[];
begin
  select status, join_deadline into v_status, v_deadline
  from zone_contests where id = p_contest_id
  for update;

  if v_status is null or v_status <> 'joining' or now() < v_deadline then
    return;
  end if;

  select array_agg(player_id) into v_pool
  from zone_contest_participants where contest_id = p_contest_id;

  if v_pool is null or array_length(v_pool, 1) = 0 then
    update zone_contests set status = 'cancelled' where id = p_contest_id;
    return;
  end if;

  perform public._advance_contest_round(p_contest_id, 1, v_pool);
end;
$$;

-- Self-healing counterpart for a single match's 30s pick timeout: if one
-- player picked and the other didn't, the picker wins by forfeit; if
-- neither picked, a winner is chosen at random (no signal to prefer
-- either player). Runs the same round-completion cascade a normal
-- resolution would.
create function public._forfeit_expired_pick_if_due(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contest_id uuid;
  v_round int;
  v_a uuid;
  v_b uuid;
  v_move_a text;
  v_move_b text;
  v_resolved timestamptz;
  v_deadline timestamptz;
  v_winner uuid;
  v_unresolved int;
  v_pool uuid[];
begin
  select contest_id, round, player_a_id, player_b_id, player_a_move, player_b_move, resolved_at, pick_deadline
    into v_contest_id, v_round, v_a, v_b, v_move_a, v_move_b, v_resolved, v_deadline
  from zone_contest_matches
  where id = p_match_id
  for update;

  if v_contest_id is null or v_resolved is not null or v_deadline is null or now() < v_deadline then
    return;
  end if;

  if v_move_a is not null and v_move_b is null then
    v_winner := v_a;
  elsif v_move_b is not null and v_move_a is null then
    v_winner := v_b;
  elsif v_move_a is null and v_move_b is null then
    v_winner := (array[v_a, v_b])[1 + floor(random() * 2)::int];
  else
    return; -- both picked — should already be resolved via submit_rps_move
  end if;

  update zone_contest_matches set winner_id = v_winner, resolved_at = now() where id = p_match_id;

  perform 1 from zone_contests where id = v_contest_id for update;

  select count(*) into v_unresolved
  from zone_contest_matches
  where contest_id = v_contest_id and round = v_round and winner_id is null;

  if v_unresolved = 0 then
    select array_agg(winner_id) into v_pool
    from zone_contest_matches
    where contest_id = v_contest_id and round = v_round;
    perform public._advance_contest_round(v_contest_id, v_round + 1, v_pool);
  end if;
end;
$$;

-- ─── Public RPCs ─────────────────────────────────────────────────────────

create function public.attempt_capture_zone(p_session_token uuid, p_zone_id text)
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
    insert into zone_contests (zone_id, join_deadline)
    values (p_zone_id, now() + interval '1 minute')
    on conflict (zone_id) where status in ('joining', 'battling', 'awaiting_proof')
    do nothing
    returning id, status into v_contest_id, v_status;

    if v_contest_id is not null then
      -- Won the race to create it — caller is the instant capturer.
      insert into zone_contest_participants (contest_id, player_id) values (v_contest_id, v_player_id);
      return public.get_contest(p_session_token, v_contest_id) || jsonb_build_object('mode', 'instant');
    end if;

    -- Lost the race — someone else's insert landed first; fall through
    -- and join/spectate whatever they created.
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
grant execute on function public.attempt_capture_zone(uuid, text) to anon;

create function public.get_contest(p_session_token uuid, p_contest_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_match record;
  v_result jsonb;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  perform public._finalize_join_window_if_due(p_contest_id);

  for v_match in
    select id from zone_contest_matches
    where contest_id = p_contest_id and resolved_at is null and pick_deadline is not null
  loop
    perform public._forfeit_expired_pick_if_due(v_match.id);
  end loop;

  select jsonb_build_object(
    'id', zc.id,
    'zoneId', zc.zone_id,
    'status', zc.status,
    'currentRound', zc.current_round,
    'joinDeadline', zc.join_deadline,
    'winnerId', zc.winner_id,
    'participantIds', coalesce((
      select jsonb_agg(player_id) from zone_contest_participants where contest_id = zc.id
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'round', m.round,
        'playerAId', m.player_a_id,
        'playerBId', m.player_b_id,
        'myMove', case
          when m.player_a_id = v_player_id then m.player_a_move
          when m.player_b_id = v_player_id then m.player_b_move
          else null end,
        'opponentHasMoved', case
          when m.player_a_id = v_player_id then m.player_b_move is not null
          when m.player_b_id = v_player_id then m.player_a_move is not null
          else null end,
        -- Redacted until resolved — otherwise a player could poll and see
        -- their opponent's pick before choosing their own.
        'opponentMove', case
          when m.resolved_at is null then null
          when m.player_a_id = v_player_id then m.player_b_move
          when m.player_b_id = v_player_id then m.player_a_move
          else null end,
        'tieCount', m.tie_count,
        'pickDeadline', m.pick_deadline,
        'winnerId', m.winner_id,
        'resolvedAt', m.resolved_at
      ) order by m.round, m.created_at)
      from zone_contest_matches m where m.contest_id = zc.id
    ), '[]'::jsonb)
  )
  into v_result
  from zone_contests zc
  where zc.id = p_contest_id;

  if v_result is null then
    raise exception 'Contest not found';
  end if;

  return v_result;
end;
$$;
grant execute on function public.get_contest(uuid, uuid) to anon;

create function public.submit_rps_move(p_session_token uuid, p_match_id uuid, p_move text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_contest_id uuid;
  v_round int;
  v_a uuid;
  v_b uuid;
  v_move_a text;
  v_move_b text;
  v_resolved timestamptz;
  v_winner uuid;
  v_unresolved int;
  v_pool uuid[];
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if p_move not in ('rock', 'paper', 'scissors') then
    raise exception 'Invalid move';
  end if;

  select contest_id, round, player_a_id, player_b_id, player_a_move, player_b_move, resolved_at
    into v_contest_id, v_round, v_a, v_b, v_move_a, v_move_b, v_resolved
  from zone_contest_matches
  where id = p_match_id
  for update;

  if v_contest_id is null then
    raise exception 'Match not found';
  end if;
  if v_resolved is not null then
    raise exception 'Match already resolved';
  end if;
  if v_b is null then
    raise exception 'This match is a bye';
  end if;
  if v_player_id <> v_a and v_player_id <> v_b then
    raise exception 'You are not in this match';
  end if;
  if (v_player_id = v_a and v_move_a is not null) or (v_player_id = v_b and v_move_b is not null) then
    raise exception 'You already picked';
  end if;

  if v_player_id = v_a then
    update zone_contest_matches set player_a_move = p_move where id = p_match_id;
    v_move_a := p_move;
  else
    update zone_contest_matches set player_b_move = p_move where id = p_match_id;
    v_move_b := p_move;
  end if;

  if v_move_a is not null and v_move_b is not null then
    if v_move_a = v_move_b then
      update zone_contest_matches
      set player_a_move = null, player_b_move = null,
          tie_count = tie_count + 1,
          pick_deadline = now() + interval '30 seconds'
      where id = p_match_id;
    else
      if (v_move_a = 'rock' and v_move_b = 'scissors')
         or (v_move_a = 'scissors' and v_move_b = 'paper')
         or (v_move_a = 'paper' and v_move_b = 'rock') then
        v_winner := v_a;
      else
        v_winner := v_b;
      end if;

      update zone_contest_matches set winner_id = v_winner, resolved_at = now() where id = p_match_id;

      perform 1 from zone_contests where id = v_contest_id for update;

      select count(*) into v_unresolved
      from zone_contest_matches
      where contest_id = v_contest_id and round = v_round and winner_id is null;

      if v_unresolved = 0 then
        select array_agg(winner_id) into v_pool
        from zone_contest_matches
        where contest_id = v_contest_id and round = v_round;
        perform public._advance_contest_round(v_contest_id, v_round + 1, v_pool);
      end if;
    end if;
  end if;

  return public.get_contest(p_session_token, v_contest_id);
end;
$$;
grant execute on function public.submit_rps_move(uuid, uuid, text) to anon;

create function public.finalize_capture_from_contest(
  p_session_token uuid,
  p_contest_id uuid,
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
  v_status text;
  v_winner_id uuid;
  v_zone_id text;
  v_place_zone text;
  v_event jsonb;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select status, winner_id, zone_id into v_status, v_winner_id, v_zone_id
  from zone_contests where id = p_contest_id
  for update;

  if v_zone_id is null then
    raise exception 'Contest not found';
  end if;
  if v_status <> 'awaiting_proof' then
    raise exception 'Contest is not awaiting a capture';
  end if;
  if v_winner_id <> v_player_id then
    raise exception 'Only the contest winner can finalize this capture';
  end if;

  select zone_id into v_place_zone from places where id = p_place_id;
  if v_place_zone is null or v_place_zone <> v_zone_id then
    raise exception 'That place is not in this zone';
  end if;

  v_event := public._apply_capture(v_player_id, p_place_id, p_caption, p_photo_url, p_nickname);

  update zone_contests set status = 'completed' where id = p_contest_id;

  return v_event;
end;
$$;
grant execute on function public.finalize_capture_from_contest(uuid, uuid, text, text, text, text) to anon;

create function public.cancel_contest(p_session_token uuid, p_contest_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
begin
  select is_admin into v_is_admin from players where session_token = p_session_token;
  if v_is_admin is not true then
    raise exception 'Admins only';
  end if;
  update zone_contests set status = 'cancelled' where id = p_contest_id and status <> 'completed';
end;
$$;
grant execute on function public.cancel_contest(uuid, uuid) to anon;

-- Every non-terminal contest the caller participates in, tagged with what
-- they need to do next — lets a player who instant-captured a zone and
-- moved on discover they've been contested without still having that
-- zone's screen open.
create function public.get_my_active_contests(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_contest record;
  v_result jsonb;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  for v_contest in
    select zc.id
    from zone_contests zc
    join zone_contest_participants p on p.contest_id = zc.id and p.player_id = v_player_id
    where zc.status = 'joining' and zc.join_deadline <= now()
  loop
    perform public._finalize_join_window_if_due(v_contest.id);
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'contestId', zc.id,
    'zoneId', zc.zone_id,
    'status', zc.status,
    'needsAction', case
      when zc.status = 'awaiting_proof' and zc.winner_id = v_player_id then 'needs_proof'
      when zc.status = 'battling' and exists (
        select 1 from zone_contest_matches m
        where m.contest_id = zc.id and m.round = zc.current_round
          and m.resolved_at is null
          and (m.player_a_id = v_player_id or m.player_b_id = v_player_id)
          and (case when m.player_a_id = v_player_id then m.player_a_move else m.player_b_move end) is null
      ) then 'needs_pick'
      else 'waiting'
    end
  )), '[]'::jsonb)
  into v_result
  from zone_contests zc
  join zone_contest_participants p on p.contest_id = zc.id and p.player_id = v_player_id
  where zc.status in ('joining', 'battling', 'awaiting_proof');

  return v_result;
end;
$$;
grant execute on function public.get_my_active_contests(uuid) to anon;

-- ─── Updates to existing functions (signatures unchanged) ───────────────

-- capture_zone stays instant and, for home zones, is byte-for-byte the
-- same behavior as before (the new block below only ever runs for
-- tier = 'regular'). For regular zones it now also opens/attaches to the
-- zone's background contest window, and refuses to run at all if the zone
-- is already being legitimately contested by someone else — closing the
-- gap where a client could call this directly to bypass the tournament.
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
  v_participant_count int;
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
    select zc.id, zc.status into v_contest_id, v_status
    from zone_contests zc
    where zc.zone_id = v_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
    for update;

    if v_contest_id is null then
      insert into zone_contests (zone_id, join_deadline)
      values (v_zone_id, now() + interval '1 minute')
      on conflict (zone_id) where status in ('joining', 'battling', 'awaiting_proof')
      do nothing
      returning id, status into v_contest_id, v_status;

      if v_contest_id is null then
        select zc.id, zc.status into v_contest_id, v_status
        from zone_contests zc
        where zc.zone_id = v_zone_id and zc.status in ('joining', 'battling', 'awaiting_proof')
        for update;
      end if;
    end if;

    select count(*) into v_participant_count
    from zone_contest_participants where contest_id = v_contest_id;

    if v_status = 'joining' and (
      v_participant_count = 0
      or (v_participant_count = 1 and exists (
            select 1 from zone_contest_participants
            where contest_id = v_contest_id and player_id = v_player_id
          ))
    ) then
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
-- No new grant needed — capture_zone(uuid, text, text, text, text) is
-- already granted to anon from 01_create.sql.

-- get_zones gains one new field per zone: active_contest_id, so the client
-- can show a live "contest in progress" badge and know, before the player
-- taps Capture, whether to expect the instant path or the join path.
create or replace function public.get_zones(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not exists (select 1 from players where session_token = p_session_token) then
    raise exception 'Not authenticated';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', z.id,
      'name', z.name,
      'nickname', z.nickname,
      'tier', z.tier,
      'owner_id', z.owner_id,
      'polygon', z.polygon,
      'active_contest_id', (
        select zc.id from zone_contests zc
        where zc.zone_id = z.id and zc.status in ('joining', 'battling', 'awaiting_proof')
        limit 1
      ),
      'places', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'location', p.location))
        from places p where p.zone_id = z.id
      ), '[]'::jsonb),
      'capture_events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'place_id', c.place_id, 'place_name', c.place_name,
          'player_id', c.player_id, 'caption', c.caption, 'photo_url', c.photo_url,
          'previous_owner_id', c.previous_owner_id, 'created_at', c.created_at
        ))
        from capture_events c where c.zone_id = z.id
      ), '[]'::jsonb)
    )
    order by z.name
  ), '[]'::jsonb)
  into v_result
  from zones z;

  return v_result;
end;
$$;
-- No new grant needed — get_zones(uuid) is already granted to anon from
-- 01_create.sql.
