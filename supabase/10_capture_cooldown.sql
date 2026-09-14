-- Anti-ping-pong cooldown: every time a *regular* zone is captured (once the
-- background contest, if any, actually settles — see _apply_capture), it
-- can't be captured again for 2 hours. Home/invaded zones are untouched —
-- they already have their own rules (Boss Raid cooldown/curse, Mutiny,
-- Uprising; see 07_home_zone_boss.sql) and never set this column.

alter table public.zones add column capture_cooldown_until timestamptz;

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
      'capture_cooldown_until', case when z.capture_cooldown_until > now() then z.capture_cooldown_until end,
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
      nickname = case when p_keep_nickname then nickname else nullif(p_nickname, '') end,
      -- Only plain regular-zone captures start the anti-ping-pong cooldown —
      -- home/invaded dethronings below use the curse instead.
      capture_cooldown_until = case when v_tier = 'regular' then now() + interval '2 hours' else capture_cooldown_until end
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
  v_capture_cooldown_until timestamptz;
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

  select tier, owner_id, capture_cooldown_until into v_tier, v_owner_id, v_capture_cooldown_until from zones where id = v_zone_id;

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
    -- Anti-ping-pong: only gates *starting* a fresh contest on an
    -- uncontested zone. Once a contest already exists (checked above),
    -- joining it is never blocked by this — it's racing to settle a
    -- capture that already happened, not starting a new one.
    if v_capture_cooldown_until is not null and v_capture_cooldown_until > now() then
      raise exception 'This zone is cooling down and can''t be captured for %.', public._format_time_remaining(v_capture_cooldown_until);
    end if;

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
  v_capture_cooldown_until timestamptz;
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

  select tier, owner_id, capture_cooldown_until into v_tier, v_owner_id, v_capture_cooldown_until from zones where id = p_zone_id;
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
    -- Anti-ping-pong: only gates *starting* a fresh contest on an
    -- uncontested zone — see the matching comment in capture_zone.
    if v_capture_cooldown_until is not null and v_capture_cooldown_until > now() then
      raise exception 'This zone is cooling down and can''t be captured for %.', public._format_time_remaining(v_capture_cooldown_until);
    end if;

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
