-- Lowers the number of pledges an Uprising needs to succeed from 3 to 2.
-- Only affects Uprisings started after this runs — one already gathering
-- keeps whatever threshold it was created with, since that value is
-- captured per-row on zone_uprisings.threshold at start_uprising time.

alter table public.zone_uprisings alter column threshold set default 2;

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
  values (p_zone_id, v_player_id, 2, now() + interval '24 hours')
  returning id, deadline into v_uprising_id, v_deadline;

  return jsonb_build_object(
    'id', v_uprising_id, 'zoneId', p_zone_id, 'status', 'gathering',
    'threshold', 2, 'supporterCount', 0, 'deadline', v_deadline
  );
end;
$$;
grant execute on function public.start_uprising(uuid, text) to anon;
