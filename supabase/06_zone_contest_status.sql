-- Exposes a contested zone's contest status (not just its id) so the
-- client can tell "the join window is still open" apart from "this is
-- already battling/awaiting proof" without an extra round trip — needed so
-- a non-participant who taps a zone mid-fight sees "Spectate" instead of a
-- misleading "Join the fight" (the window's already closed to them by
-- then). Additive/idempotent — safe to run on top of already-applied
-- earlier migrations.

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
-- No new grant needed — signature is unchanged.
