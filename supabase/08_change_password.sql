-- Lets a logged-in player change their own password from Settings.
-- Requires the current password (re-verified server-side via crypt(), same
-- as log_in) and rotates session_token on success so any other device/tab
-- still using the old token is logged out — the same "one session at a
-- time" model the rest of this auth layer already relies on.

create function public.change_password(p_session_token uuid, p_current_password text, p_new_password text)
returns table (session_token uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_hash text;
  v_new_token uuid;
begin
  select players.id, players.password_hash into v_id, v_hash
  from players where players.session_token = p_session_token;

  if v_id is null then
    raise exception 'Not authenticated';
  end if;
  if v_hash <> crypt(p_current_password, v_hash) then
    raise exception 'Current password is incorrect';
  end if;
  if length(p_new_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;

  v_new_token := gen_random_uuid();
  update players
    set password_hash = crypt(p_new_password, gen_salt('bf')),
        session_token = v_new_token
    where players.id = v_id;

  return query select v_new_token;
end;
$$;
grant execute on function public.change_password(uuid, text, text) to anon;
