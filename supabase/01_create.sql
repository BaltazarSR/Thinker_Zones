-- Zone Wars — creates everything the app needs. Run 00_drop.sql first if
-- rebuilding from scratch; safe to run this alone on a fresh project.
--
-- There is no Supabase Auth here at all — this is a hand-rolled auth layer:
--   * public.players holds name + a pgcrypto-hashed password.
--   * sign_up()/log_in() check the password and hand back a random
--     session_token, which the client stores in localStorage and passes
--     back as a plain parameter on every later call.
--   * Every table has RLS enabled with ZERO policies, so anon can't read or
--     write any of them directly over REST. The only way in is through the
--     functions below (all SECURITY DEFINER, so they bypass RLS internally
--     — each one validates the session token itself before doing anything).
--
-- Tradeoff worth knowing: a session_token is a bare bearer token with no
-- expiry, readable by anyone with access to that browser's localStorage.
-- That's an acceptable bar for a casual game among trusted friends; it is
-- not the security level of a real auth provider.

create extension if not exists pgcrypto;

-- ─── Tables ──────────────────────────────────────────────────────────────

create table public.app_config (
  key text primary key,
  value text not null
);
insert into public.app_config (key, value) values ('invite_code', 'thinker_code');
-- Change the invite code any time with:
--   update app_config set value = 'something-else' where key = 'invite_code';

create table public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  password_hash text not null,
  session_token uuid,
  color text not null,
  initials text not null,
  avatar_url text,
  is_admin boolean not null default false,
  -- Set for 2h whenever this player is dethroned from a home/invaded zone by
  -- any of Boss Raid / Mutiny / Uprising (see 07_home_zone_boss.sql) —
  -- blocks every capture/contest/mutiny entry point until it passes.
  cursed_until timestamptz,
  created_at timestamptz not null default now()
);

create table public.zones (
  id text primary key,
  name text not null,
  nickname text,
  tier text not null default 'regular' check (tier in ('regular', 'home', 'invaded')),
  owner_id uuid references public.players (id),
  polygon jsonb not null,
  -- Boss Raid state (home zones only; see 07_home_zone_boss.sql). A
  -- home-tier zone's owner_id always equals original_owner_id by
  -- invariant — that's what distinguishes 'home' from 'invaded'.
  boss_hp int not null default 10,
  boss_max_hp int not null default 10,
  last_attacker_id uuid references public.players (id),
  original_owner_id uuid references public.players (id),
  -- Open "choose your spoils" offer after a Boss Raid finishing blow.
  pending_plunder_from_id uuid references public.players (id),
  pending_plunder_deadline timestamptz,
  created_at timestamptz not null default now()
);

create table public.places (
  id text primary key,
  zone_id text not null references public.zones (id) on delete cascade,
  name text not null,
  location jsonb
);

create table public.capture_events (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places (id) on delete cascade,
  place_name text not null,
  zone_id text not null references public.zones (id) on delete cascade,
  player_id uuid not null references public.players (id),
  caption text not null,
  photo_url text,
  previous_owner_id uuid references public.players (id),
  -- Flags distinguishing what kind of event this was — see
  -- 07_home_zone_boss.sql. A plain capture/contest-win has all of these
  -- false.
  is_hit boolean not null default false,
  is_plunder boolean not null default false,
  is_uprising boolean not null default false,
  is_mutiny boolean not null default false,
  is_gift boolean not null default false,
  created_at timestamptz not null default now()
);

create index zones_owner_id_idx on public.zones (owner_id);
create index places_zone_id_idx on public.places (zone_id);
create index capture_events_zone_id_idx on public.capture_events (zone_id);
create index capture_events_created_at_idx on public.capture_events (created_at desc);

alter table public.app_config enable row level security;
alter table public.players enable row level security;
alter table public.zones enable row level security;
alter table public.places enable row level security;
alter table public.capture_events enable row level security;
-- Intentionally no policies below this line for any of the five tables
-- above — see the file header.

-- Contested captures: rock-paper-scissors tournaments for regular zones.
-- See 02_contests.sql for the full design notes — folded in here so a
-- from-scratch rebuild picks it up too.
create table public.zone_contests (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  status text not null default 'joining'
    check (status in ('joining', 'battling', 'awaiting_proof', 'completed', 'cancelled')),
  current_round int not null default 0,
  join_deadline timestamptz not null,
  winner_id uuid references public.players (id),
  -- Who's allowed to instantly finalize via capture_zone while the window
  -- is still open — set once at creation. Deliberately NOT inferred from
  -- "is the participant count still 1", since that changes as soon as
  -- anyone else joins even though the original capturer is still legit.
  instant_capturer_id uuid references public.players (id),
  created_at timestamptz not null default now()
);

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
-- Zero policies, same as every other table above.

-- Home zones: Boss Raid (siege a home zone), Mutiny (usurper vs. usurper
-- over an invaded zone), and Uprising (the original owner's only way back
-- in) — see 07_home_zone_boss.sql for the full design notes, folded in here
-- so a from-scratch rebuild picks it up too.

create table public.zone_attacker_cooldowns (
  zone_id text not null references public.zones (id) on delete cascade,
  player_id uuid not null references public.players (id),
  last_hit_at timestamptz not null,
  primary key (zone_id, player_id)
);

create table public.zone_uprisings (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  initiator_id uuid not null references public.players (id),
  status text not null default 'gathering'
    check (status in ('gathering', 'succeeded', 'expired', 'cancelled')),
  threshold int not null default 2,
  deadline timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index zone_uprisings_active_zone_idx on public.zone_uprisings (zone_id)
  where status = 'gathering';

create table public.zone_uprising_supporters (
  id uuid primary key default gen_random_uuid(),
  uprising_id uuid not null references public.zone_uprisings (id) on delete cascade,
  player_id uuid not null references public.players (id),
  pledged_at timestamptz not null default now(),
  unique (uprising_id, player_id)
);

create table public.zone_mutinies (
  id uuid primary key default gen_random_uuid(),
  zone_id text not null references public.zones (id) on delete cascade,
  instigator_id uuid not null references public.players (id),
  status text not null default 'rallying'
    check (status in ('rallying', 'dueling', 'succeeded', 'failed', 'cancelled')),
  rally_deadline timestamptz not null,
  -- Captured once at start_mutiny time — zones.owner_id changes the moment
  -- this Mutiny actually succeeds, so anything narrating past duels (e.g.
  -- get_mutiny after the fact) must read this instead.
  incumbent_id uuid references public.players (id),
  created_at timestamptz not null default now()
);
create unique index zone_mutinies_active_zone_idx on public.zone_mutinies (zone_id)
  where status in ('rallying', 'dueling');

create table public.zone_mutiny_crew (
  id uuid primary key default gen_random_uuid(),
  mutiny_id uuid not null references public.zone_mutinies (id) on delete cascade,
  player_id uuid not null references public.players (id),
  joined_at timestamptz not null default now(),
  unique (mutiny_id, player_id)
);

create table public.zone_mutiny_duels (
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

alter table public.zone_attacker_cooldowns enable row level security;
alter table public.zone_uprisings enable row level security;
alter table public.zone_uprising_supporters enable row level security;
alter table public.zone_mutinies enable row level security;
alter table public.zone_mutiny_crew enable row level security;
alter table public.zone_mutiny_duels enable row level security;
-- Zero policies, same as every other table above.

-- ─── Auth RPCs ───────────────────────────────────────────────────────────

create function public.sign_up(
  p_name text,
  p_password text,
  p_invite_code text,
  p_color text,
  p_initials text
)
returns table (id uuid, name text, session_token uuid, is_admin boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_expected_code text;
  v_id uuid;
  v_token uuid;
begin
  select value into v_expected_code from app_config where key = 'invite_code';
  if v_expected_code is null or p_invite_code <> v_expected_code then
    raise exception 'Wrong invite code';
  end if;
  if length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  if exists (select 1 from players where lower(players.name) = lower(p_name)) then
    raise exception 'That name is already taken';
  end if;

  v_token := gen_random_uuid();
  insert into players (name, password_hash, session_token, color, initials)
  values (p_name, crypt(p_password, gen_salt('bf')), v_token, p_color, p_initials)
  returning players.id into v_id;

  return query select v_id, p_name, v_token, false;
end;
$$;
grant execute on function public.sign_up(text, text, text, text, text) to anon;

create function public.log_in(p_name text, p_password text)
returns table (id uuid, name text, session_token uuid, is_admin boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_hash text;
  v_token uuid;
  v_is_admin boolean;
begin
  select players.id, players.password_hash, players.is_admin
  into v_id, v_hash, v_is_admin
  from players where lower(players.name) = lower(p_name);

  if v_id is null or v_hash <> crypt(p_password, v_hash) then
    raise exception 'Wrong name or password';
  end if;

  v_token := gen_random_uuid();
  update players set session_token = v_token where players.id = v_id;

  return query select v_id, p_name, v_token, v_is_admin;
end;
$$;
grant execute on function public.log_in(text, text) to anon;

create function public.log_out(p_session_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update players set session_token = null where session_token = p_session_token;
$$;
grant execute on function public.log_out(uuid) to anon;

create function public.whoami(p_session_token uuid)
returns table (id uuid, name text, color text, initials text, avatar_url text, is_admin boolean, cursed_until timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, name, color, initials, avatar_url, is_admin, cursed_until from players where session_token = p_session_token;
$$;
grant execute on function public.whoami(uuid) to anon;

create function public.set_avatar(p_session_token uuid, p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from players where session_token = p_session_token) then
    raise exception 'Not authenticated';
  end if;
  update players set avatar_url = p_avatar_url where session_token = p_session_token;
end;
$$;
grant execute on function public.set_avatar(uuid, text) to anon;

create function public.update_name(p_session_token uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from players where session_token = p_session_token;
  if v_id is null then
    raise exception 'Not authenticated';
  end if;
  if exists (select 1 from players where lower(name) = lower(p_name) and id <> v_id) then
    raise exception 'That name is already taken';
  end if;
  update players set name = p_name where id = v_id;
end;
$$;
grant execute on function public.update_name(uuid, text) to anon;

-- ─── Read RPCs ───────────────────────────────────────────────────────────
-- Also token-gated, so a logged-out visitor (or a stranger with just the
-- public anon key) sees nothing — not only writes require a session.

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

create function public.get_zones(p_session_token uuid)
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

-- ─── Write RPCs ──────────────────────────────────────────────────────────

create function public.create_zone(
  p_session_token uuid,
  p_id text,
  p_name text,
  p_nickname text,
  p_polygon jsonb,
  p_places jsonb -- array of {id, name, location}
)
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

  insert into zones (id, name, nickname, tier, owner_id, polygon)
  values (p_id, p_name, p_nickname, 'regular', null, p_polygon);

  insert into places (id, zone_id, name, location)
  select
    coalesce(elem ->> 'id', p_id || '-place-' || (ord - 1)),
    p_id,
    elem ->> 'name',
    nullif(elem -> 'location', 'null'::jsonb)
  from jsonb_array_elements(p_places) with ordinality as t (elem, ord);
end;
$$;
grant execute on function public.create_zone(uuid, text, text, text, jsonb, jsonb) to anon;

create function public.update_zone(
  p_session_token uuid,
  p_id text,
  p_name text,
  p_nickname text,
  p_polygon jsonb,
  p_places jsonb -- array of {id, name, location}; id is null for new pins
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_kept_ids text[];
begin
  select is_admin into v_is_admin from players where session_token = p_session_token;
  if v_is_admin is not true then
    raise exception 'Admins only';
  end if;

  update zones set name = p_name, nickname = p_nickname, polygon = p_polygon where id = p_id;

  select array_agg(elem ->> 'id') filter (where elem ->> 'id' is not null)
  into v_kept_ids
  from jsonb_array_elements(p_places) as elem;

  delete from places
  where zone_id = p_id
    and (v_kept_ids is null or not (id = any (v_kept_ids)));

  insert into places (id, zone_id, name, location)
  select
    coalesce(elem ->> 'id', p_id || '-place-' || (extract(epoch from now())::bigint) || '-' || (ord - 1)),
    p_id,
    elem ->> 'name',
    nullif(elem -> 'location', 'null'::jsonb)
  from jsonb_array_elements(p_places) with ordinality as t (elem, ord)
  on conflict (id) do update set name = excluded.name, location = excluded.location;
end;
$$;
grant execute on function public.update_zone(uuid, text, text, text, jsonb, jsonb) to anon;

create function public.delete_zone(p_session_token uuid, p_zone_id text)
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
  -- places and capture_events cascade-delete via their FKs to zones.
  delete from zones where id = p_zone_id;
end;
$$;
grant execute on function public.delete_zone(uuid, text) to anon;

-- ─── Contested-capture internal helpers (never granted to anon) ─────────
-- Only callable from inside another SECURITY DEFINER function's body, never
-- directly via PostgREST/.rpc(). See 02_contests.sql for design notes.

create function public._apply_capture(
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
  -- in-flight Uprising/Mutiny against this same zone (see
  -- 07_home_zone_boss.sql for why the Mutiny cancel can't self-cancel a
  -- Mutiny that's resolving itself).
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
create function public._format_time_remaining(p_until timestamptz)
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
    return;
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

-- ─── Write RPCs (continued) ──────────────────────────────────────────────

create function public.capture_zone(
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

  -- Boss Raid: sieging a home zone's rightful owner (see 07_home_zone_boss.sql).
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

  -- Regular zones always run through the background contest window (see
  -- 02_contests.sql).
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
  -- players have since joined.
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
grant execute on function public.capture_zone(uuid, text, text, text, text) to anon;

create function public.attempt_capture_zone(p_session_token uuid, p_zone_id text)
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
      when zc.status in ('joining', 'battling') and (
        select count(*) from zone_contest_participants where contest_id = zc.id
      ) > 1 then 'contested'
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

-- ─── Plunder ─────────────────────────────────────────────────────────────

create function public.claim_plunder(p_session_token uuid, p_zone_id text, p_zone_ids text[])
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

create function public.transfer_zone(p_session_token uuid, p_zone_id text, p_to_player_id uuid)
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

  -- The new holder is a different person now, so any in-flight Uprising or
  -- Mutiny targeting whoever *was* here no longer makes sense — cancel
  -- both. No curse, though — a gift isn't a dethroning.
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

create function public.start_uprising(p_session_token uuid, p_zone_id text)
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
  values (p_zone_id, v_player_id, 2, now() + interval '24 hours')
  returning id, deadline into v_uprising_id, v_deadline;

  return jsonb_build_object(
    'id', v_uprising_id, 'zoneId', p_zone_id, 'status', 'gathering',
    'threshold', 2, 'supporterCount', 0, 'deadline', v_deadline
  );
end;
$$;
grant execute on function public.start_uprising(uuid, text) to anon;

create function public.pledge_uprising_support(p_session_token uuid, p_uprising_id uuid)
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

create function public.start_mutiny(p_session_token uuid, p_zone_id text)
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

create function public._finalize_mutiny_rally_if_due(p_mutiny_id uuid)
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

create function public.join_mutiny_crew(p_session_token uuid, p_mutiny_id uuid)
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

create function public._resolve_mutiny_duel_outcome(
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

create function public.submit_mutiny_move(p_session_token uuid, p_duel_id uuid, p_move text)
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

create function public._forfeit_expired_mutiny_pick_if_due(p_duel_id uuid)
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

create function public.get_mutiny(p_session_token uuid, p_mutiny_id uuid)
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

create function public.get_my_active_mutinies(p_session_token uuid)
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

create function public.cancel_mutiny(p_session_token uuid, p_mutiny_id uuid)
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

-- ─── Storage for capture photos + avatars ───────────────────────────────
-- Upload paths are "<session_token>/<filename>" — policies check that
-- folder segment against a currently-valid session token, since there's no
-- Supabase Auth uid to key off of.
--
-- IMPORTANT: RLS policies on storage.objects run as the requesting role
-- (anon) directly, NOT through the security-definer functions above. Since
-- public.players has RLS enabled with zero policies, anon can't see any of
-- its rows in an ordinary query — so the policy can't query players
-- directly, it has to go through this security-definer helper instead
-- (same bypass trick as the RPCs, just invoked from a policy instead).

create function public.session_owns_folder(p_folder text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from players where session_token::text = p_folder);
$$;
grant execute on function public.session_owns_folder(text) to anon;

insert into storage.buckets (id, name, public)
values ('captures', 'captures', true)
on conflict (id) do nothing;

create policy "captures public read" on storage.objects
  for select using (bucket_id = 'captures');

create policy "captures upload with valid session" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'captures'
    and public.session_owns_folder((storage.foldername(name))[1])
  );

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatars upload with valid session" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'avatars'
    and public.session_owns_folder((storage.foldername(name))[1])
  );

-- Avatar uploads use a fixed "<token>/avatar.<ext>" path with upsert:true so
-- re-uploading replaces the old file instead of piling up — which means a
-- second upload is an UPDATE, not an INSERT, so it needs its own policy.
create policy "avatars update with valid session" on storage.objects
  for update to anon
  using (bucket_id = 'avatars' and public.session_owns_folder((storage.foldername(name))[1]))
  with check (bucket_id = 'avatars' and public.session_owns_folder((storage.foldername(name))[1]));

-- ─── Seed zones (ported from the original mock data; all start unowned) ──
-- The mock data's ownerId/history referenced fake player ids that won't
-- exist as real accounts, so every zone ships unclaimed with empty history
-- — real captures build the history from here.

