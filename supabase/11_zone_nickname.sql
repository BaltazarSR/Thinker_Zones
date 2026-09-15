-- Lets a zone's current owner rename it themselves, without going through
-- the admin-only update_zone RPC or waiting for their next capture.
create function public.set_zone_nickname(p_session_token uuid, p_zone_id text, p_nickname text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_owner_id uuid;
begin
  select id into v_player_id from players where session_token = p_session_token;
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner_id from zones where id = p_zone_id;
  if v_owner_id is null then
    raise exception 'Zone not found';
  end if;
  if v_owner_id <> v_player_id then
    raise exception 'Only the current owner can rename this zone';
  end if;

  update zones set nickname = nullif(trim(p_nickname), '') where id = p_zone_id;
end;
$$;
grant execute on function public.set_zone_nickname(uuid, text, text) to anon;
