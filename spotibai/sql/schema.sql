-- ============================================================================
--  SPOTIBAI — schema.sql
--  A lightweight Spotify clone with first-class TikTok music-video support.
--  Target: Supabase (PostgreSQL 15+)
--
--  Run order:  schema.sql  ->  seed.sql
--  Paste this whole file into the Supabase SQL Editor and execute.
-- ============================================================================
--
--  ARCHITECTURAL NOTES
--  -------------------
--  1. `profiles` is a 1:1 satellite of `auth.users`. Never write to auth.users
--     directly; the `on_auth_user_created` trigger mirrors signups for us.
--  2. Catalog tables (artists/albums/tracks) are PUBLIC READ, OWNER WRITE.
--     Ownership is anchored once, on `artists.owner_id`, and inherited by
--     albums and tracks through FK + RLS sub-selects. This keeps the policy
--     graph shallow (no duplicated owner columns to drift out of sync).
--  3. `tracks` is polymorphic over the media source. Two independent flags:
--        is_tiktok_source = TRUE  -> the `video_url` is authoritative and the
--                                    client mounts the TikTok video engine.
--        video_url IS NOT NULL    -> a video exists but audio is the default.
--     A CHECK constraint guarantees at least one playable source exists.
--  4. `tiktok_video_id` is a GENERATED column. We never trust the client to
--     parse TikTok URLs twice — the DB derives the aweme id (the numeric
--     segment of /@user/video/<id>) so Python/JS/SQL consumers all agree.
--  5. Every table gets RLS. Default deny. Policies are explicit and
--     least-privilege, with `(select auth.uid())` wrapped in a sub-select so
--     Postgres caches it as an InitPlan instead of re-evaluating per row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. EXTENSIONS
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive usernames
create extension if not exists "pg_trgm";    -- fuzzy search indexes

-- Dedicated schema for helper functions keeps `public` clean in the API.
create schema if not exists app;
grant usage on schema app to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. ENUMS
-- ----------------------------------------------------------------------------
do $$ begin
  create type media_kind as enum ('audio', 'tiktok_video', 'video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type playlist_visibility as enum ('private', 'unlisted', 'public');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2. PROFILES  (1:1 with auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      citext unique,
  display_name  text,
  avatar_url    text,
  country       text default 'PH',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint username_format check (
    username is null or username ~ '^[a-z0-9._]{3,30}$'
  )
);

comment on table public.profiles is 'Public user metadata mirrored from auth.users.';

-- Auto-create a profile row on signup -----------------------------------------
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, app
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    -- Fall back to a unique handle so the NOT NULL-ish UX never blocks signup.
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      'user_' || substr(replace(new.id::text, '-', ''), 1, 10)
    ),
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, 'listener'), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- Keep updated_at honest -------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. ARTISTS
-- ----------------------------------------------------------------------------
create table if not exists public.artists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  bio         text,
  image_url   text,
  -- NULL owner = platform-curated (system) artist. Only service_role edits it.
  owner_id    uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint artist_name_len check (char_length(name) between 1 and 120)
);

create index if not exists artists_name_trgm_idx
  on public.artists using gin (name gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- 4. ALBUMS
-- ----------------------------------------------------------------------------
create table if not exists public.albums (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  artist_id    uuid not null references public.artists (id) on delete cascade,
  cover_url    text,
  release_year int check (release_year between 1900 and 2100),
  created_at   timestamptz not null default now(),
  constraint album_title_len check (char_length(title) between 1 and 160),
  constraint album_unique_per_artist unique (artist_id, title)
);

create index if not exists albums_artist_idx on public.albums (artist_id);
create index if not exists albums_title_trgm_idx
  on public.albums using gin (title gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- 5. TRACKS  (dual-media: audio file *or* TikTok video)
-- ----------------------------------------------------------------------------
create table if not exists public.tracks (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  album_id         uuid references public.albums (id) on delete set null,
  -- Denormalised on purpose: singles need no album, and every list query needs
  -- the artist without a 3-table join. A trigger keeps these in sync.
  artist_id        uuid not null references public.artists (id) on delete cascade,
  duration_seconds int  not null default 0 check (duration_seconds >= 0),
  track_number     int  check (track_number > 0),

  -- Media sources -----------------------------------------------------------
  audio_url        text,          -- Storage object path or absolute CDN URL
  video_url        text,          -- TikTok share URL / mp4 / embeddable URL
  is_tiktok_source boolean not null default false,

  -- TikTok presentation metadata (populated for @spotibai_ph drops) ---------
  tiktok_video_id  text generated always as (
                      case
                        when video_url ~ '/video/([0-9]{6,25})'
                          then substring(video_url from '/video/([0-9]{6,25})')
                        when video_url ~ '/photo/([0-9]{6,25})'
                          then substring(video_url from '/photo/([0-9]{6,25})')
                        else null
                      end
                    ) stored,
  tiktok_author    text,          -- e.g. 'spotibai_ph'
  tiktok_caption   text,          -- raw caption from the source post
  tiktok_hashtags  text[] not null default '{}',
  tiktok_like_count    int not null default 0,
  tiktok_comment_count int not null default 0,
  tiktok_share_count   int not null default 0,
  tiktok_posted_at     timestamptz,
  thumbnail_url    text,

  -- Engagement / ordering ---------------------------------------------------
  play_count       bigint not null default 0,
  explicit         boolean not null default false,
  created_at       timestamptz not null default now(),

  constraint track_title_len check (char_length(title) between 1 and 200),

  -- A track must be playable by *something*.
  constraint track_has_media check (
    audio_url is not null or video_url is not null
  ),

  -- If flagged as a TikTok source we require a parsable aweme id, otherwise
  -- the client-side video engine would mount an empty iframe.
  constraint tiktok_requires_id check (
    not is_tiktok_source
    or (video_url is not null and video_url ~ '/(video|photo)/[0-9]{6,25}')
  ),

  -- Same asset should not be ingested twice from the same platform.
  constraint track_source_unique unique (video_url)
);

comment on column public.tracks.is_tiktok_source is
  'TRUE -> client routes playback to the TikTok video engine (@spotibai_ph feeds).';
comment on column public.tracks.tiktok_video_id is
  'Derived aweme id used for oEmbed/player embeds. Never client-supplied.';

create index if not exists tracks_album_idx   on public.tracks (album_id, track_number);
create index if not exists tracks_artist_idx  on public.tracks (artist_id);
create index if not exists tracks_tiktok_idx  on public.tracks (is_tiktok_source)
  where is_tiktok_source;
create index if not exists tracks_popular_idx on public.tracks (play_count desc);
create index if not exists tracks_title_trgm_idx
  on public.tracks using gin (title gin_trgm_ops);

-- A track with no track_number inherits the next free slot in its album.
create or replace function app.assign_track_number()
returns trigger language plpgsql as $$
begin
  if new.track_number is null and new.album_id is not null then
    select coalesce(max(track_number), 0) + 1
      into new.track_number
      from public.tracks
     where album_id = new.album_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tracks_assign_number on public.tracks;
create trigger tracks_assign_number
  before insert on public.tracks
  for each row execute function app.assign_track_number();

-- Keep tracks.artist_id aligned with the album's artist.
create or replace function app.sync_track_artist()
returns trigger language plpgsql as $$
declare album_artist uuid;
begin
  if new.album_id is not null then
    select artist_id into album_artist
      from public.albums where id = new.album_id;
    if album_artist is not null then
      new.artist_id := album_artist;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tracks_sync_artist on public.tracks;
create trigger tracks_sync_artist
  before insert or update of album_id on public.tracks
  for each row execute function app.sync_track_artist();

-- ----------------------------------------------------------------------------
-- 6. PLAYLISTS
-- ----------------------------------------------------------------------------
create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null,
  description text,
  is_public   boolean not null default false,
  cover_url   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint playlist_title_len check (char_length(title) between 1 and 160)
);

create index if not exists playlists_user_idx on public.playlists (user_id, created_at desc);
create index if not exists playlists_public_idx on public.playlists (is_public) where is_public;

drop trigger if exists playlists_touch on public.playlists;
create trigger playlists_touch
  before update on public.playlists
  for each row execute function app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 7. PLAYLIST_TRACKS  (junction, ordered)
-- ----------------------------------------------------------------------------
create table if not exists public.playlist_tracks (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  track_id    uuid not null references public.tracks (id) on delete cascade,
  added_at    timestamptz not null default now(),
  position    int not null default 0,
  added_by    uuid references public.profiles (id) on delete set null,
  primary key (playlist_id, track_id)          -- no duplicate rows
);

create index if not exists playlist_tracks_order_idx
  on public.playlist_tracks (playlist_id, position, added_at);
create index if not exists playlist_tracks_track_idx
  on public.playlist_tracks (track_id);

-- Append to the end when the caller omits `position`.
create or replace function app.assign_playlist_position()
returns trigger language plpgsql as $$
begin
  if new.position is null or new.position = 0 then
    select coalesce(max(position), 0) + 1
      into new.position
      from public.playlist_tracks
     where playlist_id = new.playlist_id;
  end if;
  return new;
end;
$$;

drop trigger if exists playlist_tracks_position on public.playlist_tracks;
create trigger playlist_tracks_position
  before insert on public.playlist_tracks
  for each row execute function app.assign_playlist_position();

-- ----------------------------------------------------------------------------
-- 8. LIKED_SONGS
-- ----------------------------------------------------------------------------
create table if not exists public.liked_songs (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  track_id   uuid not null references public.tracks (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists liked_songs_user_idx  on public.liked_songs (user_id, created_at desc);
create index if not exists liked_songs_track_idx on public.liked_songs (track_id);

-- ----------------------------------------------------------------------------
-- 9. PLAY_HISTORY  (powers the "Recently Played" rail)
-- ----------------------------------------------------------------------------
create table if not exists public.play_history (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  track_id  uuid not null references public.tracks (id) on delete cascade,
  played_at timestamptz not null default now(),
  source    text default 'app'   -- 'app' | 'album:uuid' | 'playlist:uuid'
);

create index if not exists play_history_user_idx
  on public.play_history (user_id, played_at desc);

-- ----------------------------------------------------------------------------
-- 10. READ MODEL — flat view the client selects from
-- ----------------------------------------------------------------------------
create or replace view public.track_details
with (security_invoker = true) as
select
  t.id,
  t.title,
  t.duration_seconds,
  t.track_number,
  t.audio_url,
  t.video_url,
  t.is_tiktok_source,
  t.tiktok_video_id,
  t.tiktok_author,
  t.tiktok_caption,
  t.tiktok_hashtags,
  t.tiktok_like_count,
  t.tiktok_comment_count,
  t.tiktok_share_count,
  t.tiktok_posted_at,
  coalesce(t.thumbnail_url, al.cover_url) as cover_url,
  t.play_count,
  t.explicit,
  t.created_at,
  t.album_id,
  al.title       as album_title,
  al.cover_url   as album_cover_url,
  al.release_year,
  t.artist_id,
  ar.name        as artist_name,
  ar.image_url   as artist_image_url,
  case when t.is_tiktok_source then 'tiktok_video' else 'audio' end::media_kind as media_kind
from public.tracks t
join public.artists ar on ar.id = t.artist_id
left join public.albums al on al.id = t.album_id;

-- ----------------------------------------------------------------------------
-- 11. RPCs
-- ----------------------------------------------------------------------------

-- Full-catalog search used by the Search view (tracks + albums + artists).
create or replace function public.search_catalog(q text, max_rows int default 25)
returns table (
  result_type text,
  id          uuid,
  title       text,
  subtitle    text,
  image_url   text,
  is_tiktok_source boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with needle as (select trim(coalesce(q, '')) as term)
  select * from (
    select 'track'::text as result_type, t.id, t.title,
           ar.name as subtitle,
           coalesce(t.thumbnail_url, al.cover_url) as image_url,
           t.is_tiktok_source
      from public.tracks t
      join public.artists ar on ar.id = t.artist_id
      left join public.albums al on al.id = t.album_id,
      needle n
     where n.term <> ''
       and (t.title ilike '%' || n.term || '%' or ar.name ilike '%' || n.term || '%')

    union all

    select 'album', al.id, al.title, ar.name, al.cover_url, false
      from public.albums al
      join public.artists ar on ar.id = al.artist_id, needle n
     where n.term <> '' and al.title ilike '%' || n.term || '%'

    union all

    select 'artist', ar.id, ar.name, 'Artist', ar.image_url, false
      from public.artists ar, needle n
     where n.term <> '' and ar.name ilike '%' || n.term || '%'
  ) results
  limit greatest(1, least(max_rows, 100));
$$;

-- Record a play and bump the denormalised counter atomically.
create or replace function public.record_play(p_track_id uuid, p_source text default 'app')
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.play_history (user_id, track_id, source)
    values (auth.uid(), p_track_id, p_source);
  end if;
  update public.tracks set play_count = play_count + 1 where id = p_track_id;
end;
$$;

-- Reorder a playlist in one round trip: {track_id: position} map.
create or replace function public.reorder_playlist(p_playlist_id uuid, p_order jsonb)
returns void
language plpgsql
security invoker set search_path = public
as $$
begin
  update public.playlist_tracks pt
     set position = (item.value)::int
    from jsonb_each_text(p_order) as item(key, value)
   where pt.playlist_id = p_playlist_id
     and pt.track_id = item.key::uuid;
end;
$$;

-- Resolve the "Liked Songs" pseudo-playlist for a given user.
create or replace function public.liked_tracks(p_user uuid default auth.uid())
returns setof public.track_details
language sql stable security invoker set search_path = public as $$
  select td.*
    from public.track_details td
    join public.liked_songs ls on ls.track_id = td.id
   where ls.user_id = p_user
   order by ls.created_at desc;
$$;

-- ============================================================================
-- 12. ROW LEVEL SECURITY
-- ============================================================================
alter table public.profiles        enable row level security;
alter table public.artists         enable row level security;
alter table public.albums          enable row level security;
alter table public.tracks          enable row level security;
alter table public.playlists       enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.liked_songs     enable row level security;
alter table public.play_history    enable row level security;

-- ---- profiles --------------------------------------------------------------
drop policy if exists "profiles are publicly readable"   on public.profiles;
drop policy if exists "users update their own profile"   on public.profiles;
drop policy if exists "users insert their own profile"   on public.profiles;

create policy "profiles are publicly readable"
  on public.profiles for select using (true);

create policy "users insert their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ---- artists ---------------------------------------------------------------
drop policy if exists "artists are publicly readable"    on public.artists;
drop policy if exists "artists insert by owner"          on public.artists;
drop policy if exists "artists update by owner"          on public.artists;
drop policy if exists "artists delete by owner"          on public.artists;

create policy "artists are publicly readable"
  on public.artists for select using (true);

create policy "artists insert by owner"
  on public.artists for insert to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "artists update by owner"
  on public.artists for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "artists delete by owner"
  on public.artists for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- ---- albums (ownership inherited from artist) -------------------------------
drop policy if exists "albums are publicly readable" on public.albums;
drop policy if exists "albums write by owner"        on public.albums;

create policy "albums are publicly readable"
  on public.albums for select using (true);

create policy "albums write by owner"
  on public.albums for all to authenticated
  using (
    exists (select 1 from public.artists a
             where a.id = albums.artist_id and a.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.artists a
             where a.id = albums.artist_id and a.owner_id = (select auth.uid()))
  );

-- ---- tracks ----------------------------------------------------------------
drop policy if exists "tracks are publicly readable" on public.tracks;
drop policy if exists "tracks write by owner"        on public.tracks;

create policy "tracks are publicly readable"
  on public.tracks for select using (true);

create policy "tracks write by owner"
  on public.tracks for all to authenticated
  using (
    exists (select 1 from public.artists a
             where a.id = tracks.artist_id and a.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.artists a
             where a.id = tracks.artist_id and a.owner_id = (select auth.uid()))
  );

-- ---- playlists -------------------------------------------------------------
drop policy if exists "playlists read public or own" on public.playlists;
drop policy if exists "playlists insert own"         on public.playlists;
drop policy if exists "playlists update own"         on public.playlists;
drop policy if exists "playlists delete own"         on public.playlists;

create policy "playlists read public or own"
  on public.playlists for select
  using (is_public = true or user_id = (select auth.uid()));

create policy "playlists insert own"
  on public.playlists for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "playlists update own"
  on public.playlists for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "playlists delete own"
  on public.playlists for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---- playlist_tracks (write follows the parent playlist) -------------------
drop policy if exists "playlist_tracks follow playlist read" on public.playlist_tracks;
drop policy if exists "playlist_tracks write by playlist owner" on public.playlist_tracks;

create policy "playlist_tracks follow playlist read"
  on public.playlist_tracks for select
  using (
    exists (select 1 from public.playlists p
             where p.id = playlist_tracks.playlist_id
               and (p.is_public = true or p.user_id = (select auth.uid())))
  );

create policy "playlist_tracks write by playlist owner"
  on public.playlist_tracks for all to authenticated
  using (
    exists (select 1 from public.playlists p
             where p.id = playlist_tracks.playlist_id
               and p.user_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.playlists p
             where p.id = playlist_tracks.playlist_id
               and p.user_id = (select auth.uid()))
  );

-- ---- liked_songs (strictly private) ----------------------------------------
drop policy if exists "liked_songs read own"   on public.liked_songs;
drop policy if exists "liked_songs insert own" on public.liked_songs;
drop policy if exists "liked_songs delete own" on public.liked_songs;

create policy "liked_songs read own"
  on public.liked_songs for select to authenticated
  using (user_id = (select auth.uid()));

create policy "liked_songs insert own"
  on public.liked_songs for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "liked_songs delete own"
  on public.liked_songs for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---- play_history (write-only for the owner, read own) ---------------------
drop policy if exists "history read own"   on public.play_history;
drop policy if exists "history insert own" on public.play_history;
drop policy if exists "history delete own" on public.play_history;

create policy "history read own"
  on public.play_history for select to authenticated
  using (user_id = (select auth.uid()));

create policy "history insert own"
  on public.play_history for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "history delete own"
  on public.play_history for delete to authenticated
  using (user_id = (select auth.uid()));

-- ============================================================================
-- 13. STORAGE BUCKETS
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('audio',  'audio',  true, 26214400,  array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/aac']),
  ('covers', 'covers', true, 5242880,   array['image/jpeg','image/png','image/webp','image/avif']),
  ('videos', 'videos', true, 104857600, array['video/mp4','video/webm','video/quicktime'])
on conflict (id) do nothing;

-- Public read for every bucket; writes scoped to the uploader's own folder.
drop policy if exists "public media read"      on storage.objects;
drop policy if exists "authenticated media write" on storage.objects;
drop policy if exists "uploader media update"  on storage.objects;
drop policy if exists "uploader media delete"  on storage.objects;

create policy "public media read"
  on storage.objects for select
  using (bucket_id in ('audio', 'covers', 'videos'));

create policy "authenticated media write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('audio', 'covers', 'videos')
    -- Convention: object key must start with <auth.uid()>/ so users cannot
    -- overwrite each other's assets.
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "uploader media update"
  on storage.objects for update to authenticated
  using ((storage.foldername(name))[1] = (select auth.uid())::text);

create policy "uploader media delete"
  on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = (select auth.uid())::text);

-- ============================================================================
-- 14. GRANTS
-- ============================================================================
grant select on public.track_details to anon, authenticated;
grant execute on function public.search_catalog(text, int) to anon, authenticated;
grant execute on function public.record_play(uuid, text)   to anon, authenticated;
grant execute on function public.reorder_playlist(uuid, jsonb) to authenticated;
grant execute on function public.liked_tracks(uuid)        to authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
