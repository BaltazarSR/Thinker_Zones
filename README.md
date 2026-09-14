# Thinkers Zones

A GPS-style territory capture game for a friend group: draw zones on a real
map of Guadalajara, and friends "capture" a zone's places by visiting and
posting a photo. Leaderboard tracks who holds the most zones.

## Stack

- Next.js (App Router) + React
- MapLibre GL JS + self-hosted PMTiles vector tiles (no Mapbox/Google)
- Supabase (Postgres + Storage) — **not** Supabase Auth. Auth is hand-rolled:
  a `players` table with a pgcrypto-hashed password and an invite-code gate
  on signup. See the header comment in `supabase/01_create.sql` for the full
  rationale and the security tradeoff that implies.

## Setup

1. **Env vars** — copy `.env.local.example` to `.env.local` and fill in your
   Supabase project's URL and anon/public key (Settings → API in the
   Supabase dashboard).

2. **Database** — in the Supabase SQL editor, run `supabase/00_drop.sql`
   then `supabase/01_create.sql`, in that order. `01_create.sql` is the
   single source of truth for the whole schema (tables, RLS, RPC functions,
   storage buckets, seed zones) — whenever it changes, re-run both files to
   pick up the change. `00_drop.sql` intentionally leaves `app_config` alone
   if you're doing a targeted re-run, but a full 00→01 pass wipes and
   reseeds everything, including your invite code and all accounts.

3. **Invite code** — `01_create.sql` seeds a placeholder invite code
   (`'CHANGE-ME'` unless already edited). Set your real one:
   ```sql
   update app_config set value = 'your-real-secret' where key = 'invite_code';
   ```

4. **Run it**:
   ```bash
   npm install
   npm run dev
   ```

5. **Make yourself admin** — sign up through the app first, then:
   ```sql
   update players set is_admin = true where name = 'YourName';
   ```
   Admin unlocks the map's zone-drawing/editing tools and zone deletion.
   There's no self-service admin toggle in the UI, by design.

## Map data

`public/data/guadalajara.pmtiles` is the base map (roads, buildings,
landuse) built with Planetiler + the Protomaps `basemaps` profile.
`public/data/guadalajara-roads.pmtiles` is a second, narrower tileset containing
just minor/residential roads, re-tiled directly from the first at a uniform
zoom threshold — it exists because the original tileset thinned out
residential streets inconsistently at low zoom, causing them to render in
visibly two different zooms. `public/styles/zone-wars.json` is the MapLibre
style that combines both sources.

## Known limitations

- No Realtime — a friend's capture won't show up for you until you refresh.
- Capture photos are never deleted or resized; they accumulate in Supabase
  Storage indefinitely, including orphaned ones left behind when a zone is
  deleted (deleting a zone removes its DB rows, not its photo files).
- Session tokens are bare bearer tokens with no expiry, stored in
  `localStorage` — fine for a casual game among trusted friends, not the
  security bar of a real auth provider.
