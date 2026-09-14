-- Home zones become a real centerpiece instead of "regular zones without the
-- fight": tier gains a third value, 'invaded', and three brand-new mechanics
-- govern how a home zone changes hands:
--
--   * Boss Raid  — taking a 'home' zone from its rightful (original) owner is
--     a siege: boss_hp/boss_max_hp, hit-by-hit, no soloing (same attacker
--     can't hit twice in a row, and every attacker has a 6h cooldown per
--     zone). The finishing blow flips the zone to 'invaded', curses the
--     dethroned owner, and always opens a "choose your spoils" plunder
--     offer against up to 5 of their other zones.
--   * Mutiny     — taking an already-'invaded' zone from one usurper to
--     another is a recruit-then-duel gauntlet: a challenger rallies a crew
--     (>=1 recruit required), then the crew — and only if every recruit
--     loses, the instigator themselves, always last — duels the incumbent
--     one at a time in plain rock-paper-scissors. Ownership always ends up
--     with the instigator, whoever actually lands the winning duel. No
--     plunder; only unseating the *original* owner counts as real conquest.
--   * Uprising   — the original owner's only way back into their own
--     'invaded' zone: no combat at all, just rallying 3 distinct supporters'
--     pledges. Restores 'home', pardons no one but the ousted invader (who
--     gets cursed same as any dethroning), no plunder.
--
-- All three funnel real ownership changes through the existing
-- _apply_capture helper, which now also curses whoever just lost a
-- non-regular zone (2h, blocks any capture attempt everywhere) and cancels
-- any in-flight Uprising against that same zone (a change of hands by force
-- invalidates it).
--
-- Also adds Zone Gifting: a plain, unilateral owner_id transfer between
-- players (any tier), with none of the above side effects — it's a social
-- side-channel for players to strike their own deals ("help my mutiny and
-- I'll gift you a zone"), not a mechanic the game enforces.
--
-- Additive/idempotent — safe to run once against the live database on top of
-- everything through 06_zone_contest_status.sql. Folded into
-- 01_create.sql/00_drop.sql separately so a from-scratch rebuild picks it up
-- too (see those files' own headers).

-- ─── Schema ──────────────────────────────────────────────────────────────

alter table public.zones
  add column if not exists boss_hp int not null default 10,
  add column if not exists boss_max_hp int not null default 10,
  add column if not exists last_attacker_id uuid references public.players (id),
  add column if not exists original_owner_id uuid references public.players (id),
  add column if not exists pending_plunder_from_id uuid references public.players (id),
  add column if not exists pending_plunder_deadline timestamptz;

alter table public.zones drop constraint if exists zones_tier_check;
alter table public.zones add constraint zones_tier_check check (tier in ('regular', 'home', 'invaded'));

-- Backfill for any zone that was already tier='home' with an owner before
-- this migration — original_owner_id otherwise only ever gets set the
-- moment a home zone is first captured from unclaimed.
update public.zones set original_owner_id = owner_id where tier = 'home' and owner_id is not null and original_owner_id is null;

alter table public.players add column if not exists cursed_until timestamptz;

alter table public.capture_events
  add column if not exists is_hit boolean not null default false,
  add column if not exists is_plunder boolean not null default false,
  add column if not exists is_uprising boolean not null default false,
  add column if not exists is_mutiny boolean not null default false,
  add column if not exists is_gift boolean not null default false;

create table if not exists public.zone_attacker_cooldowns (
  zone_id text not null references public.zones (id) on delete cascade,
  player_id uuid not null references public.players (id),
  last_hit_at timestamptz not null,
  primary key (zone_id, player_id)
);
alter table public.zone_attacker_cooldowns enable row level security;

create table if not exists public.zone_uprisings (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  initiator_id uuid not null references public.players (id),
  status text not null default 'gathering'
    check (status in ('gathering', 'succeeded', 'expired', 'cancelled')),
  threshold int not null default 3,
  deadline timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index if not exists zone_uprisings_active_zone_idx on public.zone_uprisings (zone_id)
  where status = 'gathering';
alter table public.zone_uprisings enable row level security;

create table if not exists public.zone_uprising_supporters (
  id uuid primary key default gen_random_uuid(),
  uprising_id uuid not null references public.zone_uprisings (id) on delete cascade,
  player_id uuid not null references public.players (id),
  pledged_at timestamptz not null default now(),
  unique (uprising_id, player_id)
);
alter table public.zone_uprising_supporters enable row level security;

create table if not exists public.zone_mutinies (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  instigator_id uuid not null references public.players (id),
  status text not null default 'rallying'
    check (status in ('rallying', 'dueling', 'succeeded', 'failed', 'cancelled')),
  rally_deadline timestamptz not null,
  created_at timestamptz not null default now()
);
-- Captured once at start_mutiny time — zones.owner_id changes the moment
-- this Mutiny actually succeeds, so anything that needs to know "who was
-- defending" (including after the fact, e.g. get_mutiny narrating the
-- outcome) must read this instead of live zones.owner_id.
alter table public.zone_mutinies add column if not exists incumbent_id uuid references public.players (id);
create unique index if not exists zone_mutinies_active_zone_idx on public.zone_mutinies (zone_id)
  where status in ('rallying', 'dueling');
alter table public.zone_mutinies enable row level security;

create table if not exists public.zone_mutiny_crew (
  id uuid primary key default gen_random_uuid(),
  mutiny_id uuid not null references public.zone_mutinies (id) on delete cascade,
  player_id uuid not null references public.players (id),
  joined_at timestamptz not null default now(),
  unique (mutiny_id, player_id)
);
alter table public.zone_mutiny_crew enable row level security;

create table if not exists public.zone_mutiny_duels (
  id uuid primary key default gen_random_uuid(),
  mutiny_id uuid not null references public.zone_mutinies (id) on delete cascade,
  challenger_id uuid not null references public.players (id),
  incumbent_move text check (incumbent_move in ('rock', 'paper', 'scissors')),
  challenger_move text check (challenger_move in ('rock', 'paper', 'scissors')),
  tie_count int not null default 0,
  pick_deadline timestamptz,
  winner_id uuid references public.players (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.zone_mutiny_duels enable row level security;
-- Zero policies on every table above, same as the rest of the schema — all
-- access goes through the SECURITY DEFINER functions below.

-- ─── _apply_capture: shared dethroning side-effect ──────────────────────
-- New trailing, defaulted params keep every existing call site working
-- unchanged. p_keep_nickname exists because Uprising/Mutiny success has no
-- user-submitted nickname to apply — without it, passing p_nickname := null
-- would wipe out whatever nickname the zone already had.
--
-- Adding parameters changes a function's identity as far as Postgres is
-- concerned (even with defaults) — CREATE OR REPLACE on the old 5-arg
-- signature would silently create a *second*, overloaded function instead
-- of replacing it, leaving any 5-arg call ambiguous between the two. Drop
-- the original signature explicitly first so this migration is safe to run
-- both on a fresh schema and on top of the pre-Home-Zones one.
drop function if exists public._apply_capture(uuid, text, text, text, text);

create or replace function public._apply_capture(
  p_player_id uuid,
  p_place_id text,
  p_caption text,
  p_photo_url text,
  p_nickname text,
  p_is_uprising boolean default false,
  p_is_mutiny boolean default false,
  p_keep_nickname boolean default false
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
  v_tier text;
  v_event public.capture_events;
begin
  select zone_id, name into v_zone_id, v_place_name from places where id = p_place_id;
  if v_zone_id is null then
    raise exception 'Place not found';
  end if;

  select owner_id, tier into v_previous_owner, v_tier from zones where id = v_zone_id;
  if v_previous_owner = p_player_id then
    raise exception 'You already own this zone';
  end if;

  insert into capture_events (
    place_id, place_name, zone_id, player_id, caption, photo_url, previous_owner_id,
    is_uprising, is_mutiny
  )
  values (
    p_place_id, v_place_name, v_zone_id, p_player_id, coalesce(nullif(p_caption, ''), 'Zone captured.'), p_photo_url, v_previous_owner,
    p_is_uprising, p_is_mutiny
  )
  returning * into v_event;

  update zones
  set owner_id = p_player_id,
      nickname = case when p_keep_nickname then nickname else nullif(p_nickname, '') end
  where id = v_zone_id;

  -- Any non-regular dethroning curses the loser and invalidates any
  -- in-flight Uprising/Mutiny against this same zone — see file header.
  -- (A Mutiny resolving itself already marked its own row 'succeeded'
  -- before calling this, so it never matches the 'rallying'/'dueling'
  -- filter below and doesn't self-cancel — this only ever catches a
  -- *different* still-active Mutiny left stale by, e.g., an Uprising
  -- succeeding against the same invaded zone out from under it.)
  if v_tier <> 'regular' then
    if v_previous_owner is not null then
      update players set cursed_until = now() + interval '2 hours' where id = v_previous_owner;
    end if;
    update zone_uprisings set status = 'cancelled' where zone_id = v_zone_id and status = 'gathering';
    update zone_mutinies set status = 'cancelled' where zone_id = v_zone_id and status in ('rallying', 'dueling');
  end if;

  return jsonb_build_object(
    'id', v_event.id, 'place_id', v_event.place_id, 'place_name', v_event.place_name,
    'player_id', v_event.player_id, 'caption', v_event.caption, 'photo_url', v_event.photo_url,
    'previous_owner_id', v_event.previous_owner_id, 'created_at', v_event.created_at,
    'is_uprising', v_event.is_uprising, 'is_mutiny', v_event.is_mutiny
  );
end;
$$;

-- Shared "1h 59m" formatting for every cursed-player rejection message below
-- — one place to keep them consistent (and matching the client's own
-- countdown() helpers in ZoneDetailSheet/MutinyRallyScreen/UprisingScreen).
create or replace function public._format_time_remaining(p_until timestamptz)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_minutes int;
  v_hours int;
  v_minutes int;
begin
  v_total_minutes := greatest(1, ceil(extract(epoch from (p_until - now())) / 60)::int);
  v_hours := v_total_minutes / 60;
  v_minutes := v_total_minutes % 60;
  if v_hours < 1 then
    return v_minutes || 'm';
  elsif v_minutes > 0 then
    return v_hours || 'h ' || v_minutes || 'm';
  else
    return v_hours || 'h';
  end if;
end;
$$;

-- ─── capture_zone: Boss Raid branch replaces the old "home = instant" one ─

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
  v_cursed_until timestamptz;
  v_zone_id text;
  v_place_name text;
  v_tier text;
  v_owner_id uuid;
  v_boss_hp int;
  v_boss_max_hp int;
  v_last_attacker_id uuid;
  v_cooldown_last_hit timestamptz;
  v_event public.capture_events;
  v_result jsonb;
  v_contest_id uuid;
  v_status text;
  v_instant_capturer_id uuid;
begin
  select id, cursed_until into v_player_id, v_cursed_until from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if v_cursed_until is not null and v_cursed_until > now() then
    raise exception 'You are cursed and cannot capture zones for %.', public._format_time_remaining(v_cursed_until);
  end if;

  select zone_id, name into v_zone_id, v_place_name from places where id = p_place_id;
  if v_zone_id is null then
    raise exception 'Place not found';
  end if;

  select tier, owner_id into v_tier, v_owner_id from zones where id = v_zone_id;

  if v_tier = 'home' then
    select boss_hp, boss_max_hp, last_attacker_id
      into v_boss_hp, v_boss_max_hp, v_last_attacker_id
    from zones where id = v_zone_id
    for update;

    if v_owner_id is null then
      -- Never claimed before — first capture is free, no siege.
      update zones set original_owner_id = v_player_id where id = v_zone_id;
      return public._apply_capture(v_player_id, p_place_id, p_caption, p_photo_url, p_nickname);
    end if;

    if v_owner_id = v_player_id then
      raise exception 'You already own this zone';
    end if;
    if v_last_attacker_id = v_player_id then
      raise exception 'Someone else has to land the next hit — call in backup!';
    end if;

    select last_hit_at into v_cooldown_last_hit
    from zone_attacker_cooldowns where zone_id = v_zone_id and player_id = v_player_id;
    if v_cooldown_last_hit is not null and now() - v_cooldown_last_hit < interval '6 hours' then
      raise exception 'You already hit this zone recently — someone else needs a turn first.';
    end if;

    v_boss_hp := greatest(v_boss_hp - 1, 0);
    insert into zone_attacker_cooldowns (zone_id, player_id, last_hit_at)
    values (v_zone_id, v_player_id, now())
    on conflict (zone_id, player_id) do update set last_hit_at = excluded.last_hit_at;

    if v_boss_hp > 0 then
      update zones set boss_hp = v_boss_hp, last_attacker_id = v_player_id where id = v_zone_id;

      insert into capture_events (place_id, place_name, zone_id, player_id, caption, photo_url, previous_owner_id, is_hit)
      values (p_place_id, v_place_name, v_zone_id, v_player_id, coalesce(nullif(p_caption, ''), 'Landed a hit on the boss!'), p_photo_url, v_owner_id, true)
      returning * into v_event;

      return jsonb_build_object(
        'id', v_event.id, 'place_id', v_event.place_id, 'place_name', v_event.place_name,
        'player_id', v_event.player_id, 'caption', v_event.caption, 'photo_url', v_event.photo_url,
        'previous_owner_id', v_event.previous_owner_id, 'created_at', v_event.created_at,
        'is_hit', true, 'boss_hp', v_boss_hp, 'boss_max_hp', v_boss_max_hp
      );
    end if;

    -- Finishing blow: the rightful owner is dethroned. tier flips to
    -- 'invaded' *before* calling _apply_capture, so its shared dethroning
    -- side-effect (curse + cancel any gathering Uprising) fires correctly.
    delete from zone_attacker_cooldowns where zone_id = v_zone_id;
    update zones set tier = 'invaded', boss_hp = boss_max_hp, last_attacker_id = null where id = v_zone_id;

    v_result := public._apply_capture(v_player_id, p_place_id, p_caption, p_photo_url, p_nickname);

    -- A home zone's owner is always its original_owner_id by invariant, so
    -- this always dethrones the rightful owner — plunder always applies.
    update zones
    set pending_plunder_from_id = v_owner_id, pending_plunder_deadline = now() + interval '15 minutes'
    where id = v_zone_id;

    return v_result || jsonb_build_object('is_hit', false, 'boss_hp', v_boss_max_hp, 'boss_max_hp', v_boss_max_hp);
  end if;

  if v_tier = 'invaded' then
    raise exception 'This zone is being fought over by usurpers — start or join a Mutiny instead.';
  end if;

  -- tier = 'regular': existing contest-window logic, unchanged.
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

  if v_status = 'joining' and v_instant_capturer_id = v_player_id then
    insert into zone_contest_participants (contest_id, player_id)
    values (v_contest_id, v_player_id)
    on conflict do nothing;
  else
    raise exception 'This zone is already being contested — join the fight instead.';
  end if;

  return public._apply_capture(v_player_id, p_place_id, p_caption, p_photo_url, p_nickname);
end;
$$;

create or replace function public.attempt_capture_zone(p_session_token uuid, p_zone_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_cursed_until timestamptz;
  v_tier text;
  v_owner_id uuid;
  v_contest_id uuid;
  v_status text;
  v_mode text;
begin
  select id, cursed_until into v_player_id, v_cursed_until from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if v_cursed_until is not null and v_cursed_until > now() then
    raise exception 'You are cursed and cannot capture zones for %.', public._format_time_remaining(v_cursed_until);
  end if;

  select tier, owner_id into v_tier, v_owner_id from zones where id = p_zone_id;
  if v_tier is null then
    raise exception 'Zone not found';
  end if;
  if v_tier = 'home' then
    raise exception 'Home zones are captured directly — attack the boss.';
  end if;
  if v_tier = 'invaded' then
    raise exception 'This zone is being fought over by usurpers — start or join a Mutiny instead.';
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

-- ─── Plunder ─────────────────────────────────────────────────────────────

create or replace function public.claim_plunder(p_session_token uuid, p_zone_id text, p_zone_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_owner_id uuid;
  v_from_id uuid;
  v_deadline timestamptz;
  v_row record;
  v_new_tier text;
  v_plundered jsonb := '[]'::jsonb;
  v_place_id text;
  v_place_name text;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id, pending_plunder_from_id, pending_plunder_deadline
    into v_owner_id, v_from_id, v_deadline
  from zones where id = p_zone_id
  for update;

  if v_owner_id is null then
    raise exception 'Zone not found';
  end if;
  if v_owner_id <> v_player_id then
    raise exception 'Only the new owner can claim spoils here';
  end if;
  if v_from_id is null or v_deadline is null or now() > v_deadline then
    raise exception 'There is nothing left to plunder here.';
  end if;
  if coalesce(array_length(p_zone_ids, 1), 0) > 5 then
    raise exception 'You can only plunder up to 5 zones.';
  end if;

  for v_row in
    select z.id, z.name, z.nickname, z.tier, z.original_owner_id
    from zones z
    where z.id = any (p_zone_ids)
      and z.id <> p_zone_id
      and z.owner_id = v_from_id
      and not exists (
        select 1 from zone_contests zc
        where zc.zone_id = z.id and zc.status in ('joining', 'battling', 'awaiting_proof')
      )
  loop
    v_new_tier := case
      when v_row.tier = 'regular' then 'regular'
      when v_row.original_owner_id = v_player_id then 'home'
      else 'invaded'
    end;

    update zones
    set owner_id = v_player_id,
        tier = v_new_tier,
        boss_hp = case when v_row.tier <> 'regular' then boss_max_hp else boss_hp end,
        last_attacker_id = case when v_row.tier <> 'regular' then null else last_attacker_id end
    where id = v_row.id;

    select id, name into v_place_id, v_place_name from places where zone_id = v_row.id limit 1;

    insert into capture_events (place_id, place_name, zone_id, player_id, caption, photo_url, previous_owner_id, is_plunder)
    values (v_place_id, v_place_name, v_row.id, v_player_id, 'Plundered as spoils of war.', null, v_from_id, true);

    v_plundered := v_plundered || jsonb_build_object('id', v_row.id, 'name', coalesce(v_row.nickname, v_row.name));
  end loop;

  update zones set pending_plunder_from_id = null, pending_plunder_deadline = null where id = p_zone_id;

  return jsonb_build_object('plundered_zones', v_plundered);
end;
$$;
grant execute on function public.claim_plunder(uuid, text, text[]) to anon;

-- ─── Zone Gifting ────────────────────────────────────────────────────────

create or replace function public.transfer_zone(p_session_token uuid, p_zone_id text, p_to_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_owner_id uuid;
  v_tier text;
  v_original_owner_id uuid;
  v_new_tier text;
  v_place_id text;
  v_place_name text;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if p_to_player_id = v_player_id then
    raise exception 'You already own this zone';
  end if;
  if not exists (select 1 from players where id = p_to_player_id) then
    raise exception 'That player does not exist';
  end if;

  select owner_id, tier, original_owner_id into v_owner_id, v_tier, v_original_owner_id
  from zones where id = p_zone_id
  for update;

  if v_owner_id is null then
    raise exception 'Zone not found';
  end if;
  if v_owner_id <> v_player_id then
    raise exception 'You do not own this zone';
  end if;

  v_new_tier := case
    when v_tier = 'regular' then 'regular'
    when v_original_owner_id = p_to_player_id then 'home'
    else 'invaded'
  end;

  update zones set owner_id = p_to_player_id, tier = v_new_tier where id = p_zone_id;

  -- The new holder is a different person now, so any in-flight Uprising
  -- (rallying to depose whoever *was* squatting here) or Mutiny (recruiting
  -- to duel whoever *was* the incumbent) no longer makes sense — cancel
  -- both rather than letting them resolve against a holder who never
  -- actually earned it through the fight/rally. No curse, though — a gift
  -- isn't a dethroning.
  if v_tier <> 'regular' then
    update zone_uprisings set status = 'cancelled' where zone_id = p_zone_id and status = 'gathering';
    update zone_mutinies set status = 'cancelled' where zone_id = p_zone_id and status in ('rallying', 'dueling');
  end if;

  select id, name into v_place_id, v_place_name from places where zone_id = p_zone_id limit 1;

  insert into capture_events (place_id, place_name, zone_id, player_id, caption, photo_url, previous_owner_id, is_gift)
  values (v_place_id, v_place_name, p_zone_id, p_to_player_id, 'Received as a gift.', null, v_player_id, true);
end;
$$;
grant execute on function public.transfer_zone(uuid, text, uuid) to anon;

-- ─── Uprising ────────────────────────────────────────────────────────────

create or replace function public.start_uprising(p_session_token uuid, p_zone_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_cursed_until timestamptz;
  v_tier text;
  v_original_owner_id uuid;
  v_uprising_id uuid;
  v_deadline timestamptz;
begin
  select id, cursed_until into v_player_id, v_cursed_until from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if v_cursed_until is not null and v_cursed_until > now() then
    raise exception 'You are cursed and cannot start an Uprising for %.', public._format_time_remaining(v_cursed_until);
  end if;

  select tier, original_owner_id into v_tier, v_original_owner_id from zones where id = p_zone_id;
  if v_tier is null then
    raise exception 'Zone not found';
  end if;
  if v_tier <> 'invaded' then
    raise exception 'This zone is not currently invaded.';
  end if;
  if v_original_owner_id <> v_player_id then
    raise exception 'Only this zone''s original owner can rally an Uprising for it.';
  end if;
  if exists (select 1 from zone_uprisings where zone_id = p_zone_id and status = 'gathering') then
    raise exception 'An Uprising is already gathering for this zone.';
  end if;

  insert into zone_uprisings (zone_id, initiator_id, threshold, deadline)
  values (p_zone_id, v_player_id, 3, now() + interval '24 hours')
  returning id, deadline into v_uprising_id, v_deadline;

  return jsonb_build_object(
    'id', v_uprising_id, 'zoneId', p_zone_id, 'status', 'gathering',
    'threshold', 3, 'supporterCount', 0, 'deadline', v_deadline
  );
end;
$$;
grant execute on function public.start_uprising(uuid, text) to anon;

create or replace function public.pledge_uprising_support(p_session_token uuid, p_uprising_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_zone_id text;
  v_initiator_id uuid;
  v_status text;
  v_deadline timestamptz;
  v_threshold int;
  v_owner_id uuid;
  v_count int;
  v_place_id text;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select zone_id, initiator_id, status, deadline, threshold
    into v_zone_id, v_initiator_id, v_status, v_deadline, v_threshold
  from zone_uprisings
  where id = p_uprising_id
  for update;

  if v_zone_id is null then
    raise exception 'Uprising not found';
  end if;

  if v_status = 'gathering' and v_deadline < now() then
    update zone_uprisings set status = 'expired' where id = p_uprising_id;
    v_status := 'expired';
  end if;
  if v_status <> 'gathering' then
    raise exception 'This Uprising is no longer accepting support.';
  end if;

  select owner_id into v_owner_id from zones where id = v_zone_id;
  if v_player_id = v_initiator_id then
    raise exception 'You already started this Uprising.';
  end if;
  if v_player_id = v_owner_id then
    raise exception 'You currently hold this zone — you can''t pledge against yourself.';
  end if;

  insert into zone_uprising_supporters (uprising_id, player_id)
  values (p_uprising_id, v_player_id)
  on conflict (uprising_id, player_id) do nothing;

  select count(*) into v_count from zone_uprising_supporters where uprising_id = p_uprising_id;

  if v_count >= v_threshold then
    update zone_uprisings set status = 'succeeded' where id = p_uprising_id;

    update zones set tier = 'home', boss_hp = boss_max_hp, last_attacker_id = null where id = v_zone_id;
    delete from zone_attacker_cooldowns where zone_id = v_zone_id;

    select id into v_place_id from places where zone_id = v_zone_id limit 1;
    perform public._apply_capture(v_initiator_id, v_place_id, 'Reclaimed the throne via Uprising!', null, null, true, false, true);

    v_status := 'succeeded';
  end if;

  return jsonb_build_object(
    'id', p_uprising_id, 'zoneId', v_zone_id, 'status', v_status,
    'threshold', v_threshold, 'supporterCount', v_count, 'deadline', v_deadline
  );
end;
$$;
grant execute on function public.pledge_uprising_support(uuid, uuid) to anon;

-- ─── Mutiny ──────────────────────────────────────────────────────────────

create or replace function public.start_mutiny(p_session_token uuid, p_zone_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_cursed_until timestamptz;
  v_tier text;
  v_owner_id uuid;
  v_original_owner_id uuid;
  v_mutiny_id uuid;
  v_deadline timestamptz;
begin
  select id, cursed_until into v_player_id, v_cursed_until from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if v_cursed_until is not null and v_cursed_until > now() then
    raise exception 'You are cursed and cannot start a Mutiny for %.', public._format_time_remaining(v_cursed_until);
  end if;

  select tier, owner_id, original_owner_id into v_tier, v_owner_id, v_original_owner_id
  from zones where id = p_zone_id;
  if v_tier is null then
    raise exception 'Zone not found';
  end if;
  if v_tier <> 'invaded' then
    raise exception 'This zone is not currently invaded.';
  end if;
  if v_player_id = v_original_owner_id then
    raise exception 'Rally an Uprising instead — you can''t Mutiny against your own throne.';
  end if;
  if v_player_id = v_owner_id then
    raise exception 'You already hold this zone.';
  end if;
  if exists (select 1 from zone_mutinies where zone_id = p_zone_id and status in ('rallying', 'dueling')) then
    raise exception 'A Mutiny is already underway for this zone.';
  end if;

  insert into zone_mutinies (zone_id, instigator_id, incumbent_id, rally_deadline)
  values (p_zone_id, v_player_id, v_owner_id, now() + interval '1 hour')
  returning id, rally_deadline into v_mutiny_id, v_deadline;

  return jsonb_build_object(
    'id', v_mutiny_id, 'zoneId', p_zone_id, 'status', 'rallying',
    'instigatorId', v_player_id, 'rallyDeadline', v_deadline, 'crewIds', '[]'::jsonb
  );
end;
$$;
grant execute on function public.start_mutiny(uuid, text) to anon;

create or replace function public._finalize_mutiny_rally_if_due(p_mutiny_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_deadline timestamptz;
  v_first_challenger uuid;
begin
  select status, rally_deadline into v_status, v_deadline
  from zone_mutinies where id = p_mutiny_id
  for update;

  if v_status is null or v_status <> 'rallying' or now() < v_deadline then
    return;
  end if;

  select player_id into v_first_challenger
  from zone_mutiny_crew
  where mutiny_id = p_mutiny_id
  order by joined_at
  limit 1;

  if v_first_challenger is null then
    update zone_mutinies set status = 'cancelled' where id = p_mutiny_id;
    return;
  end if;

  update zone_mutinies set status = 'dueling' where id = p_mutiny_id;

  insert into zone_mutiny_duels (mutiny_id, challenger_id, pick_deadline)
  values (p_mutiny_id, v_first_challenger, now() + interval '30 seconds');
end;
$$;

create or replace function public.join_mutiny_crew(p_session_token uuid, p_mutiny_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_zone_id text;
  v_instigator_id uuid;
  v_status text;
  v_deadline timestamptz;
  v_owner_id uuid;
  v_original_owner_id uuid;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select zone_id, instigator_id, status, rally_deadline
    into v_zone_id, v_instigator_id, v_status, v_deadline
  from zone_mutinies
  where id = p_mutiny_id
  for update;

  if v_zone_id is null then
    raise exception 'Mutiny not found';
  end if;

  if v_status = 'rallying' and v_deadline <= now() then
    perform public._finalize_mutiny_rally_if_due(p_mutiny_id);
    select status into v_status from zone_mutinies where id = p_mutiny_id;
  end if;
  if v_status <> 'rallying' then
    raise exception 'This Mutiny is no longer rallying support.';
  end if;

  select owner_id, original_owner_id into v_owner_id, v_original_owner_id from zones where id = v_zone_id;

  if v_player_id = v_instigator_id then
    raise exception 'You already started this Mutiny.';
  end if;
  if v_player_id = v_owner_id then
    raise exception 'You currently hold this zone.';
  end if;
  if v_player_id = v_original_owner_id then
    raise exception 'Rally an Uprising instead — you can''t Mutiny against your own throne.';
  end if;

  insert into zone_mutiny_crew (mutiny_id, player_id)
  values (p_mutiny_id, v_player_id)
  on conflict (mutiny_id, player_id) do nothing;

  return jsonb_build_object('id', p_mutiny_id, 'status', 'rallying');
end;
$$;
grant execute on function public.join_mutiny_crew(uuid, uuid) to anon;

create or replace function public._resolve_mutiny_duel_outcome(
  p_mutiny_id uuid, p_winner_id uuid, p_owner_id uuid, p_instigator_id uuid, p_zone_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_challenger uuid;
  v_place_id text;
begin
  if p_winner_id = p_owner_id then
    -- Incumbent survives — next un-duelled crew member, or the instigator
    -- last if the crew's spent.
    select player_id into v_next_challenger
    from zone_mutiny_crew
    where mutiny_id = p_mutiny_id
      and player_id not in (select challenger_id from zone_mutiny_duels where mutiny_id = p_mutiny_id)
    order by joined_at
    limit 1;

    if v_next_challenger is null
       and p_instigator_id not in (select challenger_id from zone_mutiny_duels where mutiny_id = p_mutiny_id) then
      v_next_challenger := p_instigator_id;
    end if;

    if v_next_challenger is null then
      update zone_mutinies set status = 'failed' where id = p_mutiny_id;
    else
      insert into zone_mutiny_duels (mutiny_id, challenger_id, pick_deadline)
      values (p_mutiny_id, v_next_challenger, now() + interval '30 seconds');
    end if;
  else
    -- A challenger broke through — the instigator takes the throne
    -- regardless of which crew member (or the instigator themself) won.
    update zone_mutinies set status = 'succeeded' where id = p_mutiny_id;
    select id into v_place_id from places where zone_id = p_zone_id limit 1;
    perform public._apply_capture(p_instigator_id, v_place_id, 'Seized in a Mutiny!', null, null, false, true, true);
  end if;
end;
$$;

create or replace function public.submit_mutiny_move(p_session_token uuid, p_duel_id uuid, p_move text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_mutiny_id uuid;
  v_challenger_id uuid;
  v_incumbent_move text;
  v_challenger_move text;
  v_resolved timestamptz;
  v_zone_id text;
  v_incumbent_id uuid;
  v_instigator_id uuid;
  v_winner uuid;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;
  if p_move not in ('rock', 'paper', 'scissors') then
    raise exception 'Invalid move';
  end if;

  select d.mutiny_id, d.challenger_id, d.incumbent_move, d.challenger_move, d.resolved_at
    into v_mutiny_id, v_challenger_id, v_incumbent_move, v_challenger_move, v_resolved
  from zone_mutiny_duels d
  where d.id = p_duel_id
  for update;

  if v_mutiny_id is null then
    raise exception 'Duel not found';
  end if;
  if v_resolved is not null then
    raise exception 'This duel is already resolved';
  end if;

  select m.zone_id, m.instigator_id, m.incumbent_id
    into v_zone_id, v_instigator_id, v_incumbent_id
  from zone_mutinies m where m.id = v_mutiny_id;

  if v_player_id <> v_incumbent_id and v_player_id <> v_challenger_id then
    raise exception 'You are not in this duel';
  end if;
  if (v_player_id = v_incumbent_id and v_incumbent_move is not null)
     or (v_player_id = v_challenger_id and v_challenger_move is not null) then
    raise exception 'You already picked';
  end if;

  if v_player_id = v_incumbent_id then
    update zone_mutiny_duels set incumbent_move = p_move where id = p_duel_id;
    v_incumbent_move := p_move;
  else
    update zone_mutiny_duels set challenger_move = p_move where id = p_duel_id;
    v_challenger_move := p_move;
  end if;

  if v_incumbent_move is not null and v_challenger_move is not null then
    if v_incumbent_move = v_challenger_move then
      update zone_mutiny_duels
      set incumbent_move = null, challenger_move = null,
          tie_count = tie_count + 1,
          pick_deadline = now() + interval '30 seconds'
      where id = p_duel_id;
    else
      if (v_incumbent_move = 'rock' and v_challenger_move = 'scissors')
         or (v_incumbent_move = 'scissors' and v_challenger_move = 'paper')
         or (v_incumbent_move = 'paper' and v_challenger_move = 'rock') then
        v_winner := v_incumbent_id;
      else
        v_winner := v_challenger_id;
      end if;

      update zone_mutiny_duels set winner_id = v_winner, resolved_at = now() where id = p_duel_id;
      perform public._resolve_mutiny_duel_outcome(v_mutiny_id, v_winner, v_incumbent_id, v_instigator_id, v_zone_id);
    end if;
  end if;

  return public.get_mutiny(p_session_token, v_mutiny_id);
end;
$$;
grant execute on function public.submit_mutiny_move(uuid, uuid, text) to anon;

create or replace function public._forfeit_expired_mutiny_pick_if_due(p_duel_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mutiny_id uuid;
  v_challenger_id uuid;
  v_incumbent_move text;
  v_challenger_move text;
  v_resolved timestamptz;
  v_deadline timestamptz;
  v_zone_id text;
  v_incumbent_id uuid;
  v_instigator_id uuid;
  v_winner uuid;
begin
  select d.mutiny_id, d.challenger_id, d.incumbent_move, d.challenger_move, d.resolved_at, d.pick_deadline
    into v_mutiny_id, v_challenger_id, v_incumbent_move, v_challenger_move, v_resolved, v_deadline
  from zone_mutiny_duels d
  where d.id = p_duel_id
  for update;

  if v_mutiny_id is null or v_resolved is not null or v_deadline is null or now() < v_deadline then
    return;
  end if;

  select m.zone_id, m.instigator_id, m.incumbent_id
    into v_zone_id, v_instigator_id, v_incumbent_id
  from zone_mutinies m where m.id = v_mutiny_id;

  if v_incumbent_move is not null and v_challenger_move is null then
    v_winner := v_incumbent_id;
  elsif v_challenger_move is not null and v_incumbent_move is null then
    v_winner := v_challenger_id;
  elsif v_incumbent_move is null and v_challenger_move is null then
    v_winner := (array[v_incumbent_id, v_challenger_id])[1 + floor(random() * 2)::int];
  else
    return;
  end if;

  update zone_mutiny_duels set winner_id = v_winner, resolved_at = now() where id = p_duel_id;
  perform public._resolve_mutiny_duel_outcome(v_mutiny_id, v_winner, v_incumbent_id, v_instigator_id, v_zone_id);
end;
$$;

create or replace function public.get_mutiny(p_session_token uuid, p_mutiny_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_zone_id text;
  v_incumbent_id uuid;
  v_duel record;
  v_result jsonb;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  -- incumbent_id (captured once at start_mutiny) rather than zones.owner_id
  -- — the latter is only accurate until the moment this Mutiny actually
  -- succeeds, and get_mutiny still needs to narrate every past duel
  -- correctly after that point.
  select zone_id, incumbent_id into v_zone_id, v_incumbent_id from zone_mutinies where id = p_mutiny_id;
  if v_zone_id is null then
    raise exception 'Mutiny not found';
  end if;

  perform public._finalize_mutiny_rally_if_due(p_mutiny_id);

  for v_duel in
    select id from zone_mutiny_duels
    where mutiny_id = p_mutiny_id and resolved_at is null and pick_deadline is not null
  loop
    perform public._forfeit_expired_mutiny_pick_if_due(v_duel.id);
  end loop;

  select jsonb_build_object(
    'id', zm.id,
    'zoneId', zm.zone_id,
    'status', zm.status,
    'instigatorId', zm.instigator_id,
    'rallyDeadline', zm.rally_deadline,
    'crewIds', coalesce((
      select jsonb_agg(c.player_id order by c.joined_at) from zone_mutiny_crew c where c.mutiny_id = zm.id
    ), '[]'::jsonb),
    -- Every duel this Mutiny has had, oldest first — mirrors Contest.matches
    -- so the client can hold each duel's own win/lose reveal open (via
    -- resolvedAt + an acknowledged-ids set) instead of just being handed
    -- whatever duel is "current" and never seeing one that already finished.
    'duels', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id,
        'round', 1,
        'playerAId', v_incumbent_id,
        'playerBId', d.challenger_id,
        'myMove', case
          when v_incumbent_id = v_player_id then d.incumbent_move
          when d.challenger_id = v_player_id then d.challenger_move
          else null end,
        'opponentHasMoved', case
          when v_incumbent_id = v_player_id then d.challenger_move is not null
          when d.challenger_id = v_player_id then d.incumbent_move is not null
          else null end,
        'opponentMove', case
          when d.resolved_at is null then null
          when v_incumbent_id = v_player_id then d.challenger_move
          when d.challenger_id = v_player_id then d.incumbent_move
          else null end,
        'tieCount', d.tie_count,
        'pickDeadline', d.pick_deadline,
        'winnerId', d.winner_id,
        'resolvedAt', d.resolved_at
      ) order by d.created_at)
      from zone_mutiny_duels d
      where d.mutiny_id = zm.id
    ), '[]'::jsonb)
  )
  into v_result
  from zone_mutinies zm
  where zm.id = p_mutiny_id;

  return v_result;
end;
$$;
grant execute on function public.get_mutiny(uuid, uuid) to anon;

create or replace function public.get_my_active_mutinies(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_result jsonb;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'mutinyId', zm.id,
    'zoneId', zm.zone_id,
    'status', zm.status,
    'needsAction', case
      when zm.status = 'dueling' and exists (
        select 1 from zone_mutiny_duels d
        where d.mutiny_id = zm.id and d.resolved_at is null
          and (
            (z.owner_id = v_player_id and d.incumbent_move is null)
            or (d.challenger_id = v_player_id and d.challenger_move is null)
          )
      ) then 'needs_pick'
      -- Only the incumbent gets a passive "under Mutiny" warning for the
      -- whole window — the instigator and crew have nothing to watch for
      -- until it's specifically their turn, so they'd otherwise get a
      -- banner nagging them for the whole rally window with nothing to do.
      when zm.status in ('rallying', 'dueling') and z.owner_id = v_player_id then 'watching'
      else 'waiting'
    end
  )), '[]'::jsonb)
  into v_result
  from zone_mutinies zm
  join zones z on z.id = zm.zone_id
  where zm.status in ('rallying', 'dueling')
    and (
      zm.instigator_id = v_player_id
      or z.owner_id = v_player_id
      or exists (select 1 from zone_mutiny_crew c where c.mutiny_id = zm.id and c.player_id = v_player_id)
    );

  return v_result;
end;
$$;
grant execute on function public.get_my_active_mutinies(uuid) to anon;

create or replace function public.cancel_mutiny(p_session_token uuid, p_mutiny_id uuid)
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
  update zone_mutinies set status = 'cancelled' where id = p_mutiny_id and status in ('rallying', 'dueling');
end;
$$;
grant execute on function public.cancel_mutiny(uuid, uuid) to anon;

-- ─── get_zones / get_players / whoami: expose the new state ─────────────

create or replace function public.get_zones(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_result jsonb;
  v_mutiny record;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Lazily settle anything whose deadline has passed before reporting state.
  update zone_uprisings set status = 'expired' where status = 'gathering' and deadline < now();
  for v_mutiny in select id from zone_mutinies where status = 'rallying' and rally_deadline <= now() loop
    perform public._finalize_mutiny_rally_if_due(v_mutiny.id);
  end loop;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', z.id,
      'name', z.name,
      'nickname', z.nickname,
      'tier', z.tier,
      'owner_id', z.owner_id,
      'polygon', z.polygon,
      'boss_hp', case when z.tier <> 'regular' then z.boss_hp end,
      'boss_max_hp', case when z.tier <> 'regular' then z.boss_max_hp end,
      'last_attacker_id', case when z.tier <> 'regular' then z.last_attacker_id end,
      'original_owner_id', z.original_owner_id,
      'pending_plunder_from_id', case when z.pending_plunder_deadline > now() then z.pending_plunder_from_id end,
      'pending_plunder_deadline', case when z.pending_plunder_deadline > now() then z.pending_plunder_deadline end,
      'my_cooldown_until', (
        select c.last_hit_at + interval '6 hours'
        from zone_attacker_cooldowns c
        where c.zone_id = z.id and c.player_id = v_player_id
      ),
      'active_contest_id', (
        select zc.id from zone_contests zc
        where zc.zone_id = z.id and zc.status in ('joining', 'battling', 'awaiting_proof')
        limit 1
      ),
      'active_contest_status', (
        select zc.status from zone_contests zc
        where zc.zone_id = z.id and zc.status in ('joining', 'battling', 'awaiting_proof')
        limit 1
      ),
      'active_contest_participant_ids', coalesce((
        select jsonb_agg(p.player_id)
        from zone_contests zc
        join zone_contest_participants p on p.contest_id = zc.id
        where zc.zone_id = z.id and zc.status in ('joining', 'battling', 'awaiting_proof')
      ), '[]'::jsonb),
      'active_uprising_id', (
        select u.id from zone_uprisings u where u.zone_id = z.id and u.status = 'gathering' limit 1
      ),
      'active_uprising_deadline', (
        select u.deadline from zone_uprisings u where u.zone_id = z.id and u.status = 'gathering' limit 1
      ),
      'active_uprising_threshold', (
        select u.threshold from zone_uprisings u where u.zone_id = z.id and u.status = 'gathering' limit 1
      ),
      'active_uprising_supporter_count', (
        select count(*) from zone_uprisings u
        join zone_uprising_supporters s on s.uprising_id = u.id
        where u.zone_id = z.id and u.status = 'gathering'
      ),
      'active_uprising_supporter_ids', coalesce((
        select jsonb_agg(s.player_id) from zone_uprisings u
        join zone_uprising_supporters s on s.uprising_id = u.id
        where u.zone_id = z.id and u.status = 'gathering'
      ), '[]'::jsonb),
      'active_mutiny_id', (
        select m.id from zone_mutinies m where m.zone_id = z.id and m.status in ('rallying', 'dueling') limit 1
      ),
      'active_mutiny_instigator_id', (
        select m.instigator_id from zone_mutinies m where m.zone_id = z.id and m.status in ('rallying', 'dueling') limit 1
      ),
      'active_mutiny_status', (
        select m.status from zone_mutinies m where m.zone_id = z.id and m.status in ('rallying', 'dueling') limit 1
      ),
      'active_mutiny_rally_deadline', (
        select m.rally_deadline from zone_mutinies m where m.zone_id = z.id and m.status = 'rallying' limit 1
      ),
      'active_mutiny_crew_ids', coalesce((
        select jsonb_agg(c.player_id order by c.joined_at) from zone_mutinies m
        join zone_mutiny_crew c on c.mutiny_id = m.id
        where m.zone_id = z.id and m.status in ('rallying', 'dueling')
      ), '[]'::jsonb),
      'places', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'location', p.location))
        from places p where p.zone_id = z.id
      ), '[]'::jsonb),
      'capture_events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'place_id', c.place_id, 'place_name', c.place_name,
          'player_id', c.player_id, 'caption', c.caption, 'photo_url', c.photo_url,
          'previous_owner_id', c.previous_owner_id, 'created_at', c.created_at,
          'is_hit', c.is_hit, 'is_plunder', c.is_plunder, 'is_uprising', c.is_uprising,
          'is_mutiny', c.is_mutiny, 'is_gift', c.is_gift
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
grant execute on function public.get_zones(uuid) to anon;

drop function if exists public.get_players(uuid);
create function public.get_players(p_session_token uuid)
returns table (id uuid, name text, color text, initials text, avatar_url text, is_admin boolean, cursed_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from players where session_token = p_session_token) then
    raise exception 'Not authenticated';
  end if;
  return query
    select players.id, players.name, players.color, players.initials, players.avatar_url, players.is_admin, players.cursed_until
    from players;
end;
$$;
grant execute on function public.get_players(uuid) to anon;

drop function if exists public.whoami(uuid);
create function public.whoami(p_session_token uuid)
returns table (id uuid, name text, color text, initials text, avatar_url text, is_admin boolean, cursed_until timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, name, color, initials, avatar_url, is_admin, cursed_until from players where session_token = p_session_token;
$$;
grant execute on function public.whoami(uuid) to anon;
