# SpotiBai

A lightweight Spotify clone — **HTML5 · modern CSS (Grid/Flexbox) · vanilla ES modules · Supabase** — with a
dual-media engine that plays standard audio tracks *and* TikTok music-video drops from
[**@spotibai_ph**](https://www.tiktok.com/@spotibai_ph).

No framework. No bundler. No build step.

---

## Run it

```bash
# any static server works — ES modules need http(s), not file://
cd spotibai
python3 -m http.server 4173
# → http://localhost:4173
```

It boots instantly in **demo mode**: a full catalog (4 artists, 4 albums, 8 tracks,
2 playlists), real generated MP3s, generated cover art, working auth, likes,
playlist CRUD and playback — all offline, persisted to `localStorage`.

### Supabase project

This checkout is configured to connect to the SpotiBai Supabase project by default.
Its schema and demo catalog are installed there. The browser uses only the public
anon key; RLS policies protect user data. You can override the project credentials
through the in-app connection settings or with `window.__SPOTIBAI_CONFIG__`.

Upload the bundled tracks and cover art to Supabase Storage once with:

```bash
python3 spotibai/tools/upload_supabase_audio.py
```

The script uploads only the repository's demo MP3/SVG files. Supabase policies
allow anonymous inserts for this fixed filename allowlist only; existing objects
are never overwritten. Catalog asset paths are translated to public Storage URLs.

If Supabase is unreachable or credentials are invalid, the app degrades back to
demo mode with a warning badge.

---

## What's implemented

**Layout** — sidebar (Home / Search / Your Library / Create playlist / profile menu),
scrollable main viewport, persistent bottom player, and a floating TikTok video panel.

**Views** — Home dashboard (recently played tiles, featured albums, trending TikTok
drops, top tracks, artists), Search with debounced live results, Library,
Album, Playlist, Liked Songs, Artist, and a `#/track/:id` deep link that autoplays.

**Player bar** — cover/title/artist, play·pause, next, previous (restarts if >3s in),
shuffle, repeat (off→all→one), scrubbable timeline with elapsed/total, buffered
indicator, volume slider + mute, and a "Video" pill that appears only for
TikTok-sourced tracks.

**Dual media engine**
- standard tracks → `HTMLAudioElement`
- direct video files → `<video>`
- `is_tiktok_source` → the official TikTok player is embedded in the in-app
  panel for the original sound; no generated substitute audio is played. Select
  **Load TikTok player** in the panel, then use its own controls. Playback stays
  in SpotiBai; the app's seek bar cannot control a cross-origin TikTok player.

**State** — one observable store (`js/store.js`): queue, index, is_playing, mode,
volume, shuffle, repeat, video status, session, likes. Player preferences persist.

**TikTok panel** — 9:16 stage, real caption, hashtags, like/comment/share counts,
"open on TikTok", expandable, and a consent gate so no third-party iframe loads
until the listener asks for it.

**Auth** — email/password sign in & sign up, profile menu, sign out, session
restore. Demo mode accepts any email + 6-char password and never sends it anywhere.

**A11y** — semantic landmarks, labelled controls, `aria-pressed` on every toggle,
focus trapping in modals, Escape to close, keyboard-navigable rows.

### Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | play / pause | `→` / `←` | seek ±5s (hold `Shift` for ±30s) |
| `N` | next | `P` | previous |
| `M` | mute | `S` | shuffle |
| `R` | repeat | `L` | like current track |
| `/` | focus search | `Esc` | close panel / menu / drawer |

---

## Project structure

```
spotibai/
├── index.html                  semantic shell + inline SVG icon sprite
├── css/
│   ├── tokens.css              design tokens: colour, type, spacing, motion, z-index
│   └── styles.css              layout + components + responsive (14 sections)
├── js/
│   ├── app.js                  orchestrator: boot, routing, delegation, sync
│   ├── store.js                observable state, queue/pref actions, selectors
│   ├── audioPlayer.js          MediaEngine (dual media) + PlaybackController
│   ├── supabaseClient.js       repository factory: Supabase | demo fallback
│   ├── config.js               runtime config, credential handling
│   ├── utils.js                DOM/format/array helpers (no deps)
│   ├── data/
│   │   ├── demoSeed.js         offline catalog, mirrors sql/seed.sql 1:1
│   │   └── localProvider.js    demo repository (same interface as Supabase)
│   └── ui/
│       ├── router.js           hash router + route parser
│       ├── views.js            pure render functions per view
│       ├── components.js       pure HTML builders (cards, rows, hero, skeletons)
│       ├── modal.js            auth, settings, create playlist, queue, confirm
│       └── toast.js            transient feedback
├── sql/
│   ├── schema.sql              tables, indexes, triggers, views, RPCs, RLS, buckets
│   └── seed.sql                demo catalog incl. verified @spotibai_ph video ids
├── assets/
│   ├── audio/                  generated demo MP3s (see tools/gen_audio.py)
│   └── covers/                 generated SVG artwork
├── tools/
│   ├── gen_audio.py            procedural music generator (numpy + lameenc)
│   └── gen_covers.py           procedural SVG artwork generator
└── docs/ARCHITECTURE.md        blueprint: layers, ERD, media routing, RLS matrix
```

---

## About the TikTok content

The two TikTok rows use **real, verified video ids** from `@spotibai_ph`, with the
live caption and hashtag structure
(`#SpotiBaiPH #Tangalog #OfficialSpotiBaiPH #bainabai🔥 #SpotiBai`):

| Video id | Caption |
|---|---|
| `7681226050852031751` | “Malupit na Bai Spotted on #SpotiBaiPH #Tangalog …” |
| `7678258030735265042` | “#spotibai #bainabai🔥 — coron song bisaya” |

All other music and artwork in the demo is **original and procedurally generated**
for this project — nothing is scraped or redistributed.

Embedding third-party TikTok content requires complying with TikTok's terms and
the creator's rights. The app never proxies or re-hosts TikTok video; it embeds the
official player and links out.

---

## Deployment

It's static files — deploy the folder anywhere:

```bash
# Netlify / Vercel / Cloudflare Pages
#   build command: (none)     output dir: .
# GitHub Pages
git subtree push --prefix spotibai origin gh-pages
# Supabase-hosted
supabase storage cp -r ./spotibai ss:///site --experimental   # or any bucket + CDN
```

Because routing is hash-based (`#/album/:id`), **no server rewrites are needed**.

---

## Regenerating the demo assets

```bash
pip install numpy lameenc
python3 tools/gen_audio.py    # → assets/audio/*.mp3 (+ manifest.json)
python3 tools/gen_covers.py   # → assets/covers/*.svg
```
