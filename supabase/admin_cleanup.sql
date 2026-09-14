-- Admin housekeeping — plain SQL to paste into the Supabase SQL console by
-- hand. Not part of the numbered migration chain (00_drop.sql /
-- 01_create.sql / 02+), not folded into either, and no stored functions —
-- just statements you run directly, a section at a time.

-- ─── Nightly cleanup (run once to register the schedule) ─────────────────

-- Registers a pg_cron job that runs the deletes below directly every night
-- at 3am. Only needs to be pasted once per project — re-paste later only if
-- you want to change the schedule or the query. capture_events (the zone
-- history log shown in the UI) is deliberately not touched here, nor is
-- anything else — only these four tables' terminal/expired rows, each
-- cascading to its own child rows:
--   * zone_contests    — status completed/cancelled, >1 day old
--   * zone_uprisings   — status not 'gathering', >1 day old
--   * zone_mutinies    — status not rallying/dueling, >1 day old
--   * zone_attacker_cooldowns — past its 6h window

-- Requires the pg_cron extension enabled on this project. If this errors
-- with insufficient privilege, enable it first via Supabase Dashboard →
-- Database → Extensions → pg_cron, then run it again.
create extension if not exists pg_cron;

-- Drops any existing schedule of the same name first, so re-pasting this
-- (e.g. after editing the query below) doesn't create a duplicate job.
select cron.unschedule(jobid) from cron.job where jobname = 'zone-wars-nightly-cleanup';

-- pg_cron schedules run in UTC regardless of server locale, so 3am Mexico
-- City time (America/Mexico_City, fixed at UTC-6 year-round since Mexico
-- dropped DST in 2022) is 09:00 UTC.
select cron.schedule(
  'zone-wars-nightly-cleanup',
  '0 9 * * *',
  $cron$
    delete from zone_contests
    where status in ('completed', 'cancelled') and created_at < now() - interval '1 day';

    delete from zone_uprisings
    where status <> 'gathering' and created_at < now() - interval '1 day';

    delete from zone_mutinies
    where status not in ('rallying', 'dueling') and created_at < now() - interval '1 day';

    delete from zone_attacker_cooldowns where last_hit_at < now() - interval '6 hours';
  $cron$
);

-- ─── Delete a player and all of their history ─────────────────────────────

-- A real, permanent DELETE — not a soft-delete/deactivation. An anonymous
-- do $$ block, not a stored function: nothing persists in the database
-- after it runs, but the id only needs to be entered once, at the top.
--
-- This also deletes rows *shared* with other players wherever this player
-- was one side of them: a contest match, a mutiny duel, an uprising pledge.
-- That means it also erases that specific event from whoever they played
-- against — e.g. someone else's win over this player disappears from the
-- record too, not just this player's loss. If a zone they founded (home
-- tier) was later taken and is still 'invaded' under someone else, nulling
-- original_owner_id below means that zone can never be reclaimed via
-- Uprising again — there's no rightful claimant left.

-- Replace the id below (look it up with: select id, name from players;),
-- then paste and run this whole block.
do $$
declare
  v_player_id uuid := 'PLAYER_ID_HERE';
begin
  -- Mutinies: delete entirely wherever they're the instigator or the
  -- current incumbent being fought over (cascades that mutiny's own
  -- crew/duels), then clean up any stray duel/crew row from *other*
  -- mutinies where they were only a recruit.
  delete from zone_mutinies where instigator_id = v_player_id or incumbent_id = v_player_id;
  delete from zone_mutiny_duels where challenger_id = v_player_id or winner_id = v_player_id;
  delete from zone_mutiny_crew where player_id = v_player_id;

  -- Uprisings: same idea — delete entirely wherever they're the initiator
  -- (cascades supporters), then stray pledges in other uprisings.
  delete from zone_uprisings where initiator_id = v_player_id;
  delete from zone_uprising_supporters where player_id = v_player_id;

  -- Contests: any active one on a zone they still own has no owner to
  -- resolve against once we release it below, so cancel it now. Then
  -- delete their matches/participation rows, and null the two nullable
  -- references on the contest container itself rather than deleting the
  -- whole contest (other participants' own matches survive).
  update zone_contests set status = 'cancelled'
  where zone_id in (select id from zones where owner_id = v_player_id)
    and status in ('joining', 'battling', 'awaiting_proof');
  delete from zone_contest_matches
  where player_a_id = v_player_id or player_b_id = v_player_id or winner_id = v_player_id;
  delete from zone_contest_participants where player_id = v_player_id;
  update zone_contests set winner_id = null where winner_id = v_player_id;
  update zone_contests set instant_capturer_id = null where instant_capturer_id = v_player_id;

  -- Any uprising still gathering on a zone they own has the same problem —
  -- cancel it before the zone is released below.
  update zone_uprisings set status = 'cancelled'
  where zone_id in (select id from zones where owner_id = v_player_id)
    and status = 'gathering';

  -- Their whole capture/hit/gift/plunder history, and every place they're
  -- named as who a zone was captured *from*.
  delete from capture_events where player_id = v_player_id or previous_owner_id = v_player_id;

  delete from zone_attacker_cooldowns where player_id = v_player_id;

  -- Release every zone they currently own back to a plain, unclaimed
  -- regular zone, then clear any other stray reference to them on zones
  -- they don't own (last hit landed, home zone originally founded by them,
  -- or an open plunder offer against their other zones).
  update zones
  set owner_id = null,
      tier = 'regular',
      nickname = null,
      boss_hp = boss_max_hp,
      last_attacker_id = null,
      original_owner_id = null,
      pending_plunder_from_id = null,
      pending_plunder_deadline = null,
      capture_cooldown_until = null
  where owner_id = v_player_id;
  update zones set last_attacker_id = null where last_attacker_id = v_player_id;
  update zones set original_owner_id = null where original_owner_id = v_player_id;
  update zones set pending_plunder_from_id = null, pending_plunder_deadline = null
  where pending_plunder_from_id = v_player_id;

  -- Finally, the player row itself.
  delete from players where id = v_player_id;
end;
$$;
