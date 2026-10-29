# ARCHITECTURE — SpotiBai

A lightweight Spotify clone with **two playback engines** (HTML5 audio + TikTok
video) built on vanilla ES modules and Supabase.

---

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BROWSER (no build step, no framework)                                    │
│                                                                          │
│  index.html ── semantic shell + inline SVG sprite                        │
│      │                                                                   │
│      └── js/app.js ──────────────── orchestrator (only DOM↔store layer)   │
│             ├── js/store.js ─────── observable state (slices)            │
│             ├── js/audioPlayer.js ─ dual media engine + queue controller │
│             ├── js/supabaseClient.js ─ repository factory                │
│             │        ├── SupabaseRepository ──┐                          │
│             │        └── localProvider ───────┤ same async interface     │
│             └── js/ui/                        │                          │
│                      ├── views.js ──── pure render fns (fetch+template)  │
│                      ├── components.js ─ pure HTML builders              │
│                      ├── router.js ──── hash router                      │
│                      ├── modal.js ───── auth / settings / queue dialogs  │
│                      └── toast.js                                        │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │                              │
        ┌───────────▼──────────┐      ┌────────────▼────────────┐
        │ SUPABASE             │      │ TikTok (third-party)    │
        │ ─ Postgres + RLS     │      │ ─ /embed/v2/<id> iframe │
        │ ─ Auth (JWT)         │      │ ─ share URLs            │
        │ ─ Storage buckets    │      └─────────────────────────┘
        │ ─ RPC (record_play)  │
        └──────────────────────┘
```

**Dependency rule:** dependencies point *inward* to pure modules.
`components.js` and `views.js` know nothing about the store, the DOM, or the
network beyond the repository interface they are handed. `app.js` is the only
place where state, network, and DOM meet.

---

## 2. Layered responsibilities

| Layer | Files | Knows about | Must never |
|---|---|---|---|
| Shell | `index.html` | DOM ids, sprite | contain logic |
| Orchestrator | `app.js` | everything | be imported by anything |
| State | `store.js` | nothing | touch the DOM |
| Media | `audioPlayer.js` | store, utils, config | build HTML |
| Repository | `supabaseClient.js`, `data/*` | Supabase SDK, seed | touch the DOM |
| Views | `ui/views.js`, `ui/components.js` | repo interface, utils | mutate state directly |
| Presentation | `css/tokens.css`, `styles.css` | — | — |

---

## 3. Data model (ERD)

```
auth.users 1──1 profiles
                  │
                  ├──1:N playlists ──1:N playlist_tracks ──N:1 tracks
                  ├──1:N liked_songs ─────────────────────N:1 tracks
                  └──1:N play_history ───────────────────N:1 tracks

artists 1──N albums 1──N tracks
   └───────1:N tracks (artist_id, denormalised + trigger-synced)
```

Design decisions worth calling out:

1. **`tracks.artist_id` is deliberately denormalised.** Singles have no album,
   and every list query would otherwise need a 3-table join. The
   `tracks_sync_artist` trigger keeps it aligned with `albums.artist_id`, so it
   can never drift.
2. **Ownership is anchored once.** Only `artists.owner_id` stores a writer.
   Albums and tracks inherit permission through FK sub-selects in RLS. This
   removes three duplicate owner columns that could disagree.
3. **`tiktok_video_id` is a generated column.** The `(/video/|/photo/)\d{6,25}`
   regex runs in Postgres, so JS, SQL and any future worker agree on the same
   aweme id. The client parses only as a fallback (`parseTikTokId`).
4. **Two independent media flags, not one enum.**
   `is_tiktok_source` decides *engine routing*; `video_url IS NOT NULL` decides
   *whether a video exists at all*. An mp4 in the `videos` bucket is a normal
   track with a video; a TikTok post is a hybrid. A `CHECK` enforces
   `audio_url IS NOT NULL OR video_url IS NOT NULL` so no row is unplayable.
5. **`playlist_tracks` has no surrogate key** — `(playlist_id, track_id)` is the
   PK, which makes duplicate insertion a 23505 that the client turns into the
   toast "Already in that playlist". `position` is auto-assigned by a trigger
   when omitted, so a plain `INSERT` always appends.

---

## 4. The dual media engine

### 4.1 Routing matrix

| Track shape | `mode` | Authoritative clock | Audio source | UI |
|---|---|---|---|---|
| `audio_url` only | `audio` | `<audio>` | `<audio>` | audio player |
| `video_url` = `.mp4/.webm` | `video` | `<video>` | `<video>` | video mounted in panel |
| `is_tiktok_source` | `hybrid` | `<audio>` bed | `<audio>` bed | TikTok embed + poster |

### 4.2 Why TikTok is "hybrid" and not "video"

TikTok's player is delivered as a **cross-origin iframe with no postMessage
API**. From the parent page you cannot read `currentTime`, you cannot seek, and
you cannot observe play/pause. Any app that makes the embed its *only* media
source therefore loses:

* a scrubbable timeline,
* accurate progress/duration,
* `ENDED`-driven auto-advance,
* playback when the embed is blocked (offline, region, cookie restrictions,
  rate limiting).

So for `is_tiktok_source` tracks we mount the embed **for visuals** and
simultaneously play the track's own `audio_url` bed, which provides the real
clock. Consequences baked into the UI:

* the scrubber keeps working (it seeks the bed),
* the timeline tooltip explains the coupling,
* a `pointerdown` on the embed stage pauses the bed, so a listener driving the
  TikTok player never gets double audio (`videoStatus = 'manual'`),
* if the embed never loads, we show the poster + fallback card instead of a
  white error frame, and audio keeps playing.

This is exactly why `schema.sql` keeps **both** `audio_url` and `video_url` on
TikTok rows instead of making video exclusive.

### 4.3 Embed loading policy

`CONFIG.TIKTOK_AUTOLOAD_EMBED = false` by default. The panel shows poster art,
caption, hashtags and engagement counts, with an explicit **"Load TikTok
player"** gate. That buys:

* no third-party cookies/trackers before consent (GDPR-friendly),
* graceful degradation when TikTok rate-limits or blocks the origin,
* a fast first paint — no iframe blocking the panel.

Set it to `true` to auto-mount. Either way the state machine is:

```
idle → loading → ready
             ↘  slow     (online, but > TIKTOK_EMBED_TIMEOUT_MS)
             ↘  blocked  (navigator.onLine === false)
     → manual            (listener touched the embed)
     → gate              (autoload disabled, awaiting consent)
```

### 4.4 Engine internals

`MediaEngine` owns exactly one `<audio>` element for its whole lifetime (no
listener leaks on track change) and creates `<video>`/`<iframe>` on demand,
tearing them down in `_teardownVideo()`. Both are normalised into three hooks —
`onTime`, `onPlayState`, `onEnded` — so `PlaybackController` is media-agnostic.

`PlaybackController` owns queue semantics:

* **Shuffle** reorders the queue but pins the current track at index 0, keeping
  `originalQueue` so toggling back restores the album order exactly.
* **Repeat** cycles `off → all → one`; `one` seeks to 0 on `ended`, `all` wraps.
* **Prev** restarts the track if `currentTime > 3s` (Spotify behaviour).
* **Likes** are optimistic: the store updates immediately, then reconciles or
  reverts on failure.

---

## 5. State shape

```js
{
  source: 'demo' | 'supabase',
  session:  { user, profile },
  view:     { name, params },
  library:  { playlists: [], likedIds: Set, loading },
  playback: {
    track, queue, originalQueue, index,
    isPlaying, isLoading, mode, error,
    progress, duration, buffered,        // seconds / ratio
    volume, muted, shuffle, repeat,      // persisted to localStorage
    videoOpen, videoStatus
  }
}
```

* Nested patches merge one level deep (`setPlayback({ isPlaying })` never
  clobbers `track`).
* Notifications are batched into a microtask, so a burst of `timeupdate` events
  collapses into one render pass.
* `volume/muted/shuffle/repeat` are debounced-persisted; everything else is
  ephemeral by design.

---

## 6. Security model (RLS)

| Table | anon read | authenticated read | write |
|---|---|---|---|
| `profiles` | ✅ all | ✅ all | own row only |
| `artists` | ✅ | ✅ | `owner_id = auth.uid()` |
| `albums` | ✅ | ✅ | artist owner (sub-select) |
| `tracks` | ✅ | ✅ | artist owner (sub-select) |
| `playlists` | public only | public + own | own |
| `playlist_tracks` | follows playlist | follows playlist | playlist owner |
| `liked_songs` | ❌ | own | own |
| `play_history` | ❌ | own | own |
| `storage.objects` | public buckets | public buckets | `foldername[1] = auth.uid()` |

Notes:

* `auth.uid()` is always wrapped as `(select auth.uid())` so Postgres promotes
  it to an InitPlan and evaluates it **once per query** instead of once per row
  — the single biggest RLS performance lever on list endpoints.
* Storage write policies require the object key to start with the uploader's
  uid, which prevents users overwriting each other's audio.
* `record_play()` is `security definer` because it bumps a counter on a row the
  caller does not own; it still stamps history with `auth.uid()`.
* The anon key is public by design. It can read the catalog and write only rows
  the signed-in user owns.

---

## 7. Ingestion pipeline for `@spotibai_ph`

The schema is ingest-ready; the collector is deliberately out of the client:

```
┌────────────┐   ┌─────────────────┐   ┌──────────────────┐   ┌───────────┐
│ TikTok URL │──▶│ Edge Function   │──▶│ upsert into      │──▶│ Storage   │
│ (share)    │   │ parse + oEmbed  │   │ tracks (service  │   │ audio/    │
└────────────┘   │ + poster fetch  │   │ role key)        │   │ covers/   │
                 └─────────────────┘   └──────────────────┘   └───────────┘
```

Contract for a row created by the collector:

```
title             = caption's first clause, or the track name
video_url         = https://www.tiktok.com/@spotibai_ph/video/<id>
is_tiktok_source  = true
tiktok_video_id   = (generated by Postgres — do not send it)
tiktok_author     = 'spotibai_ph'
tiktok_caption    = raw caption
tiktok_hashtags   = ['SpotiBaiPH','Tangalog','OfficialSpotiBaiPH','bainabai🔥','SpotiBai']
tiktok_like_count / comment / share / posted_at = engagement snapshot
thumbnail_url     = uploaded poster frame (covers bucket)
audio_url         = the licensed audio bed (optional but strongly recommended,
                    because it powers the hybrid clock — see §4.2)
```

Two production guards already in the schema:

* `track_source_unique` on `video_url` makes re-ingesting a post idempotent —
  use `ON CONFLICT (video_url) DO UPDATE` to refresh engagement counts.
* `tiktok_requires_id` rejects a row flagged as TikTok whose URL has no parsable
  id, so the client can never mount an empty iframe.

---

## 8. Performance notes

* **No framework, no bundler.** ~60 KB of JS/CSS total; first paint is a single
  request chain of static files, and the Supabase SDK is dynamically imported
  *only* when credentials exist.
* **Skeletons over spinners** so layout never shifts.
* `content-visibility`-friendly list rendering: rows are plain strings, swapped
  in one `innerHTML` assignment; only the *active* row is patched afterwards
  (`syncActiveRows`) — no virtual DOM, no list diffing.
* Views register their arrays in a `collections` registry, so clicking a row
  rebuilds its exact queue with zero refetching.
* Artwork is SVG (a few KB each) generated by `tools/gen_covers.py`; audio is
  96 kbps mono MP3 to keep the demo payload under ~10 MB.

---

## 9. Extension points

| Want to… | Do this |
|---|---|
| Add an Equalizer / visualiser | Subscribe in `MediaEngine.play()` via `createMediaElementSource(audio)` |
| Add lyrics | New `lyrics` table + a panel in `views.js`; timestamps align to `progress` |
| Add a real queue drawer | `openQueueModal` already exists — promote it to a sidebar |
| Support SoundCloud/YouTube | Add a `source_platform` enum + a branch in `MediaEngine.resolveMode` |
| Offline PWA playback | Cache `assets/audio` in a service worker; store already persists prefs |
| Replace the UI | `store.subscribe()` is the only contract a new renderer needs |
