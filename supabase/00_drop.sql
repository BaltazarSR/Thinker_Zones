-- Zone Wars — drops EVERYTHING 01_create.sql creates: all data, all
-- accounts, the invite code, and the storage policies. Run this first
-- whenever you want to rebuild from a truly clean slate. Safe to run even
-- if some objects don't exist yet.
--
-- Does NOT delete the "captures"/"avatars" storage buckets or their files —
-- Supabase blocks direct SQL DELETE on storage tables ("Direct deletion
-- from storage tables is not allowed. Use the Storage API instead"). If you
-- want those gone too: Dashboard → Storage → open each bucket → delete it
-- (or delete individual files) before running this. 01_create.sql recreates
-- the buckets either way (on conflict do nothing), so leaving them isn't
-- broken, it just means old avatar/capture-photo files stick around.

drop policy if exists "captures public read" on storage.objects;
drop policy if exists "captures upload with valid session" on storage.objects;
drop policy if exists "avatars public read" on storage.objects;
drop policy if exists "avatars upload with valid session" on storage.objects;
drop policy if exists "avatars update with valid session" on storage.objects;

drop function if exists public.session_owns_folder(text);
drop function if exists public.update_name(uuid, text);
drop function if exists public.set_avatar(uuid, text);

-- Home zones: Boss Raid / Mutiny / Uprising / Plunder / Gifting — see
-- 07_home_zone_boss.sql.
drop function if exists public.cancel_mutiny(uuid, uuid);
drop function if exists public.get_my_active_mutinies(uuid);
drop function if exists public.get_mutiny(uuid, uuid);
drop function if exists public._forfeit_expired_mutiny_pick_if_due(uuid);
drop function if exists public.submit_mutiny_move(uuid, uuid, text);
drop function if exists public._resolve_mutiny_duel_outcome(uuid, uuid, uuid, uuid, text);
drop function if exists public.join_mutiny_crew(uuid, uuid);
drop function if exists public._finalize_mutiny_rally_if_due(uuid);
drop function if exists public.start_mutiny(uuid, text);
drop table if exists public.zone_mutiny_duels cascade;
drop table if exists public.zone_mutiny_crew cascade;
drop table if exists public.zone_mutinies cascade;
drop function if exists public.pledge_uprising_support(uuid, uuid);
drop function if exists public.start_uprising(uuid, text);
drop table if exists public.zone_uprising_supporters cascade;
drop table if exists public.zone_uprisings cascade;
drop function if exists public.transfer_zone(uuid, text, uuid);
drop function if exists public.claim_plunder(uuid, text, text[]);
drop function if exists public._format_time_remaining(timestamptz);
drop table if exists public.zone_attacker_cooldowns cascade;

-- Contested-capture RPS tournaments (regular zones only — see 02_contests.sql).
drop function if exists public.get_my_active_contests(uuid);
drop function if exists public.cancel_contest(uuid, uuid);
drop function if exists public.finalize_capture_from_contest(uuid, uuid, text, text, text, text);
drop function if exists public.submit_rps_move(uuid, uuid, text);
drop function if exists public.get_contest(uuid, uuid);
drop function if exists public.attempt_capture_zone(uuid, text);
drop function if exists public._forfeit_expired_pick_if_due(uuid);
drop function if exists public._finalize_join_window_if_due(uuid);
drop function if exists public._advance_contest_round(uuid, int, uuid[]);
drop function if exists public._apply_capture(uuid, text, text, text, text, boolean, boolean, boolean);
drop table if exists public.zone_contest_matches cascade;
drop table if exists public.zone_contest_participants cascade;
drop table if exists public.zone_contests cascade;

drop function if exists public.capture_zone(uuid, text, text, text);
drop function if exists public.capture_zone(uuid, text, text, text, text);
drop function if exists public.delete_zone(uuid, text);
drop function if exists public.update_zone(uuid, text, text, text, jsonb, jsonb);
drop function if exists public.create_zone(uuid, text, text, text, jsonb, jsonb);
drop function if exists public.get_zones(uuid);
drop function if exists public.get_players(uuid);
drop function if exists public.whoami(uuid);
drop function if exists public.log_out(uuid);
drop function if exists public.log_in(text, text);
drop function if exists public.sign_up(text, text, text, text, text);

drop table if exists public.capture_events cascade;
drop table if exists public.places cascade;
drop table if exists public.zones cascade;
drop table if exists public.players cascade;
drop table if exists public.app_config cascade;

-- Leftovers from an earlier Supabase-Auth-based version of this schema —
-- harmless no-ops if they were never created.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
