-- ============================================================================
--  SPOTIBAI — seed.sql
--  Demo catalog: 3 artists, 3 albums, 6 audio tracks, 2 TikTok-sourced tracks.
--  Run AFTER schema.sql. Safe to re-run (idempotent via deterministic UUIDs).
-- ============================================================================
--
--  ABOUT THE TIKTOK ROWS
--  ---------------------
--  The two rows flagged `is_tiktok_source = true` below use REAL, verified
--  video ids from https://www.tiktok.com/@spotibai_ph:
--
--    7681226050852031751  "Malupit na Bai Spotted on"
--    7678258030735265042  "#spotibai #bainabai🔥"  (coron song bisaya)
--
--  Their captions / hashtags / engagement counts mirror the live posts so the
--  UI's TikTok card renders authentic content structure. Everything else in
--  this file is original demo music generated for the project.
--
--  Their `audio_url` is NULL on purpose: the generated demo MP3s are not the
--  same audio as the original posts. Play the official sound in the embedded
--  TikTok player instead; the app keeps the listener on SpotiBai.
--
--  NOTE ON STORAGE: `audio_url` / `cover_url` values below are PUBLIC bucket
--  URLs. Upload the matching files from /assets in this repo first:
--
--    supabase storage cp ./assets/audio/*.mp3 ss:///audio/
--    supabase storage cp ./assets/covers/*.svg ss:///covers/
--
--  ...or simply point them at your own CDN. The client demo mode does not use
--  this table at all — it reads js/data/demoSeed.js, which mirrors it 1:1.
-- ============================================================================

-- Deterministic UUIDs keep the seed idempotent and make local dev predictable.

begin;

-- ---------------------------------------------------------------------------
-- ARTISTS
-- ---------------------------------------------------------------------------
insert into public.artists (id, name, bio, image_url, owner_id) values
  ('a0000000-0000-4000-8000-000000000001', 'Bai-J',
   'Tagalog flow, Bisaya heart. Recording out of Cebu and Makati since 2022.',
   '/assets/covers/artist-baij.svg', null),

  ('a0000000-0000-4000-8000-000000000002', 'ReneBai',
   'Bedroom-pop melodies with a Visayan lilt. Writes everything at 3am.',
   '/assets/covers/artist-rene.svg', null),

  ('a0000000-0000-4000-8000-000000000003', 'Lucky7',
   'Open-verse specialist. If there is a beat, there is a Lucky7 entry on it.',
   '/assets/covers/artist-lucky.svg', null),

  ('a0000000-0000-4000-8000-000000000004', 'SpotiBai PH',
   'Curated TikTok drops from @spotibai_ph — the feed that put local rap on everybody''s For You page.',
   '/assets/covers/artist-spotibai.svg', null)
on conflict (id) do update
  set name = excluded.name,
      bio = excluded.bio,
      image_url = excluded.image_url;

-- ---------------------------------------------------------------------------
-- ALBUMS
-- ---------------------------------------------------------------------------
insert into public.albums (id, title, artist_id, cover_url, release_year) values
  ('b0000000-0000-4000-8000-000000000001', 'Tangalog Nights',
   'a0000000-0000-4000-8000-000000000001', '/assets/covers/album-tangalog-nights.svg', 2024),

  ('b0000000-0000-4000-8000-000000000002', 'Bisaya Sunrise',
   'a0000000-0000-4000-8000-000000000002', '/assets/covers/album-bisaya-sunrise.svg', 2025),

  ('b0000000-0000-4000-8000-000000000003', 'Hugot Sessions',
   'a0000000-0000-4000-8000-000000000003', '/assets/covers/album-hugot-sessions.svg', 2025),

  ('b0000000-0000-4000-8000-000000000004', 'For You Page Vol. 1',
   'a0000000-0000-4000-8000-000000000004', '/assets/covers/album-fyp-vol1.svg', 2026)
on conflict (id) do update
  set title = excluded.title, cover_url = excluded.cover_url;

-- ---------------------------------------------------------------------------
-- TRACKS — standard audio
-- ---------------------------------------------------------------------------
insert into public.tracks
  (id, title, album_id, artist_id, duration_seconds, track_number,
   audio_url, video_url, is_tiktok_source, play_count, thumbnail_url)
values
  ('c0000000-0000-4000-8000-000000000001', 'Wait A Minute',
   'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   133, 1, '/assets/audio/wait-a-minute.mp3', null, false, 184203, null),

  ('c0000000-0000-4000-8000-000000000002', 'Pandemic Ere',
   'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   131, 2, '/assets/audio/pandemic-ere.mp3', null, false, 97310, null),

  ('c0000000-0000-4000-8000-000000000003', 'She Got Her Own Thing',
   'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
   142, 1, '/assets/audio/she-got-her-own-thing.mp3', null, false, 231884, null),

  ('c0000000-0000-4000-8000-000000000004', 'Dagat ug Bituon',
   'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
   135, 2, '/assets/audio/dagat-ug-bituon.mp3', null, false, 64210, null),

  ('c0000000-0000-4000-8000-000000000005', 'Baha (Open Verse)',
   'b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003',
   115, 1, '/assets/audio/baha-open-verse.mp3', null, false, 142667, null),

  ('c0000000-0000-4000-8000-000000000006', 'Solo Grind',
   'b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003',
   123, 2, '/assets/audio/solo-grind.mp3', null, false, 118940, null),

  -- ------------------------------------------------------------------------
  -- TRACKS — TikTok-sourced (video is the primary media)
  --   * video_url      -> canonical share URL, DB derives tiktok_video_id
--   * audio_url      -> NULL; don't play generated demo audio that differs
--                       from the original TikTok sound
--   * hashtags/etc.  -> mirror the live post, consumed by the video panel
  -- ------------------------------------------------------------------------
  ('c0000000-0000-4000-8000-000000000007', 'Malupit na Bai Spotted On',
   'b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004',
   37, 1,
   null,
   'https://www.tiktok.com/@spotibai_ph/video/7681226050852031751',
   true, 383500,
   '/assets/covers/tiktok-malupit-na-bai.svg'),

  ('c0000000-0000-4000-8000-000000000008', 'Coron Song (Bisaya)',
   'b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004',
   41, 2,
   null,
   'https://www.tiktok.com/@spotibai_ph/video/7678258030735265042',
   true, 31400,
   '/assets/covers/tiktok-coron-song.svg')
on conflict (id) do update
  set title = excluded.title,
      audio_url = excluded.audio_url,
      video_url = excluded.video_url,
      is_tiktok_source = excluded.is_tiktok_source,
      thumbnail_url = excluded.thumbnail_url;

-- ---------------------------------------------------------------------------
-- TRACKS — TikTok presentation metadata
-- ---------------------------------------------------------------------------
update public.tracks set
  tiktok_author        = 'spotibai_ph',
  tiktok_caption       = 'Malupit na Bai Spotted on #SpotiBaiPH #Tangalog #OfficialSpotiBaiPH #bainabai🔥 #SpotiBai',
  tiktok_hashtags      = array['SpotiBaiPH','Tangalog','OfficialSpotiBaiPH','bainabai🔥','SpotiBai'],
  tiktok_like_count    = 383500,
  tiktok_comment_count = 3619,
  tiktok_share_count   = 18900,
  tiktok_posted_at     = now() - interval '2 days'
where id = 'c0000000-0000-4000-8000-000000000007';

update public.tracks set
  tiktok_author        = 'spotibai_ph',
  tiktok_caption       = '#spotibai #bainabai🔥  — coron song bisaya',
  tiktok_hashtags      = array['spotibai','bainabai🔥'],
  tiktok_like_count    = 31400,
  tiktok_comment_count = 602,
  tiktok_share_count   = 2573,
  tiktok_posted_at     = now() - interval '8 days'
where id = 'c0000000-0000-4000-8000-000000000008';

-- ---------------------------------------------------------------------------
-- A public "editorial" playlist (owned by the first profile that exists).
-- Skipped silently on a fresh database with no users yet.
-- ---------------------------------------------------------------------------
do $$
declare owner uuid;
begin
  select id into owner from public.profiles order by created_at limit 1;
  if owner is null then
    raise notice 'No profiles yet — skipping editorial playlist seed.';
    return;
  end if;

  insert into public.playlists (id, user_id, title, description, is_public, cover_url)
  values ('d0000000-0000-4000-8000-000000000001', owner,
          'Tangalog Heat', 'The tracks burning up the For You page right now.',
          true, '/assets/covers/playlist-tangalog-heat.svg')
  on conflict (id) do nothing;

  insert into public.playlist_tracks (playlist_id, track_id, position, added_by)
  select 'd0000000-0000-4000-8000-000000000001', t.id,
         row_number() over (order by t.play_count desc), owner
    from public.tracks t
   where t.id in (
     'c0000000-0000-4000-8000-000000000007',
     'c0000000-0000-4000-8000-000000000003',
     'c0000000-0000-4000-8000-000000000001',
     'c0000000-0000-4000-8000-000000000005'
   )
  on conflict (playlist_id, track_id) do nothing;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Smoke test — should return 8 tracks, 2 of them TikTok-sourced.
-- ---------------------------------------------------------------------------
-- select media_kind, count(*) from public.track_details group by 1;
-- select title, tiktok_video_id from public.tracks where is_tiktok_source;
