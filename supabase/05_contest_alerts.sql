-- Extends get_my_active_contests with a new needsAction value, 'contested',
-- for the gap where a player's instant-captured zone has been joined by
-- someone else (or they've joined someone else's) but it's not yet their
-- specific turn to pick or claim — previously this state was lumped in
-- with 'waiting' and the client's alert banner filtered it out entirely,
-- so a player had no way to learn their zone was under attack short of
-- reopening it manually. Additive/idempotent — safe to run on top of an
-- already-applied 02_contests.sql (and later migrations).

create or replace function public.get_my_active_contests(p_session_token uuid)
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
-- No new grant needed — signature is unchanged.
