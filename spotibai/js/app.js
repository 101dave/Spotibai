/**
 * app.js — application orchestrator
 * ---------------------------------------------------------------------------
 * The only module that knows about *both* the DOM and the store. Everything else
 * is a leaf:
 *
 *   app.js ──┬── store.js            (state)
 *            ├── audioPlayer.js      (MediaEngine + PlaybackController)
 *            ├── supabaseClient.js   (repository factory)
 *            └── ui/views.js         (pure HTML builders)
 *
 * Responsibilities:
 *   • boot: resolve repository → session → likes → engine → first route
 *   • render views and keep the player bar / video panel in sync with state
 *   • delegate every interaction (one listener per event type, no per-node binds)
 *   • own the collection registry that maps a rendered row back to its queue
 */

import {
  $,
  $$,
  esc,
  icon,
  clamp,
  ratio,
  fmtTime,
  fmtCount,
  fmtRelative,
  debounce,
  isMobile,
} from './utils.js';
import { CONFIG } from './config.js';
import { createRepository } from './supabaseClient.js';
import { MediaEngine, PlaybackController } from './audioPlayer.js';
import {
  getState,
  subscribe,
  setPlayback,
  setSession,
  setLibrary,
  setState,
  setView,
} from './store.js';
import { parseRoute, onRouteChange, navigate } from './ui/router.js';
import { toast } from './ui/toast.js';
import {
  openAuthModal,
  openSourceModal,
  openCreatePlaylistModal,
  openAddToPlaylistModal,
  openQueueModal,
  openConfirmModal,
} from './ui/modal.js';
import {
  renderHome,
  searchShell,
  searchResultsHTML,
  renderLibrary,
  renderAlbum,
  renderPlaylist,
  renderLiked,
  renderArtist,
  renderTrackView,
  notFound,
  viewSkeleton,
  homeSkeleton,
} from './ui/views.js';

/* ===========================================================================
   Module state
   =========================================================================== */
let repo = null;
let engine = null;
let controller = null;

/** collection key → array of track objects (the queue a row belongs to) */
const collections = new Map();

const GENRES = [
  'Bisaya',
  'Tangalog',
  'Hugot',
  'Open verse',
  'TikTok drops',
  'Bai-J',
  'ReneBai',
  'Lucky7',
];

const dom = {
  viewRoot: $('#viewRoot'),
  playerArt: $('#playerArt'),
  playerArtWrap: $('#playerArtWrap'),
  playerTitle: $('#playerTitle'),
  playerArtist: $('#playerArtist'),
  playerLike: $('[data-action="like-current"]'),
  playToggle: $('#playToggle'),
  scrub: $('#scrub'),
  scrubFill: $('#scrubFill'),
  scrubBuffered: $('#scrubBuffered'),
  timeElapsed: $('#timeElapsed'),
  timeTotal: $('#timeTotal'),
  volumeScrub: $('#volumeScrub'),
  volumeBox: $('#volumeBox'),
  volumeFill: $('#volumeFill'),
  muteBtn: $('#muteBtn'),
  sourceIndicator: $('#sourceIndicator'),
  libraryList: $('#libraryList'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  menuToggle: $('#menuToggle'),
  userMenuList: $('#userMenuList'),
  userName: $('#userName'),
  userAvatar: $('#userAvatar'),
  signOutItem: $('#signOutItem'),
  menuAccountLabel: $('#menuAccountLabel'),
  sourceBadge: $('#sourceBadge'),
  sourceBadgeText: $('#sourceBadgeText'),
  videoPanel: $('#videoPanel'),
  videoPoster: $('#videoPoster'),
  videoFallback: $('#videoFallback'),
  videoCaption: $('#videoCaption'),
  videoTags: $('#videoTags'),
  videoHandle: $('#videoHandle'),
  videoPosted: $('#videoPosted'),
  videoAvatar: $('#videoAvatar'),
  videoLikes: $('#videoLikes'),
  videoComments: $('#videoComments'),
  videoShares: $('#videoShares'),
  videoOpenLink: $('#videoOpenLink'),
  videoFallbackLink: $('#videoFallbackLink'),
  videoNote: $('#videoNote'),
};

/** Shared context handed to every view renderer. */
const ctx = {
  get repo() {
    return repo;
  },
  playback: null,
  likedIds: new Set(),
  user: null,
  profile: null,
  genres: GENRES,
  searchResult: null,
  registerCollection,
  requestPlay: null,
};

/* ===========================================================================
   Collection registry
   =========================================================================== */
function registerCollection(key, tracks) {
  if (!key) return;
  collections.set(key, Array.isArray(tracks) ? tracks : []);
}

/** Resolve a collection key to a queue, fetching from the repo when needed. */
async function resolveCollection(key) {
  if (collections.has(key)) return collections.get(key);

  const [kind, id] = key.split(':');
  let tracks = [];

  try {
    if (kind === 'album') tracks = (await repo.getAlbum(id))?.tracks || [];
    else if (kind === 'playlist') tracks = (await repo.getPlaylist(id))?.tracks || [];
    else if (kind === 'liked') tracks = await repo.likedTracks();
    else if (kind === 'tiktok') {
      const feed = await repo.tiktokTracks();
      tracks = feed.length ? feed : [await repo.getTrack(id)].filter(Boolean);
    } else if (kind === 'track') {
      const track = await repo.getTrack(id);
      tracks = track?.album_id ? (await repo.getAlbum(track.album_id))?.tracks || [track] : [track].filter(Boolean);
    } else if (kind === 'artist') tracks = (await repo.getArtist(id))?.tracks || [];
  } catch (err) {
    console.warn('[app] could not resolve collection', key, err);
  }

  collections.set(key, tracks);
  return tracks;
}

/* ===========================================================================
   Playback entry points
   =========================================================================== */
async function playCollection(key, { trackId = null, toggleIfCurrent = true } = {}) {
  const tracks = await resolveCollection(key);
  if (!tracks.length) {
    toast('Nothing to play here yet.', 'error');
    return;
  }

  const state = getState();
  const index = trackId ? Math.max(0, tracks.findIndex((t) => t.id === trackId)) : 0;

  const isSameQueue =
    state.playback.queue.length === tracks.length &&
    state.playback.queue[0]?.id === tracks[0]?.id &&
    state.playback.queue[state.playback.queue.length - 1]?.id ===
      tracks[tracks.length - 1]?.id;

  if (toggleIfCurrent && isSameQueue && state.playback.track) {
    const clickedCurrent = !trackId || state.playback.track.id === trackId;
    if (clickedCurrent) {
      await controller.toggle();
      return;
    }
    await controller.playQueue(tracks, index, { context: key });
    return;
  }

  await controller.playQueue(tracks, index, { context: key });
}

/* ===========================================================================
   Routing + view mounting
   =========================================================================== */
let currentRoute = { name: 'home', id: null, query: '' };
let renderToken = 0;

async function renderRoute(route = parseRoute()) {
  if (!repo) return; // boot() will render the first route once the repo is ready
  currentRoute = route;
  const token = ++renderToken;

  setView(route.name, { id: route.id, query: route.query });
  markActiveNav(route);
  closeMobileSidebar();

  // Refresh the snapshot views read from.
  const state = getState();
  ctx.playback = state.playback;
  ctx.likedIds = state.library.likedIds;
  ctx.user = state.session.user;
  ctx.profile = state.session.profile;

  if (route.name === 'search') {
    dom.viewRoot.innerHTML = searchShell(route.query);
    dom.viewRoot.scrollTop = 0;
    await runSearch(route.query);
    return;
  }

  dom.viewRoot.innerHTML = route.name === 'home' ? homeSkeleton() : viewSkeleton();

  let html = '';
  try {
    switch (route.name) {
      case 'home':
        html = await renderHome(ctx);
        break;
      case 'library':
        html = await renderLibrary(ctx);
        break;
      case 'liked':
        html = await renderLiked(ctx);
        break;
      case 'album':
        html = await renderAlbum(ctx, route.id);
        break;
      case 'playlist':
        html = await renderPlaylist(ctx, route.id);
        break;
      case 'artist':
        html = await renderArtist(ctx, route.id);
        break;
      case 'track':
        html = await renderTrackView(ctx, route.id);
        break;
      default:
        html = notFound('That link does not match any view.');
    }
  } catch (err) {
    console.error('[app] view failed', err);
    html = notFound(err.message || 'Something went wrong while loading this view.');
  }

  // A newer navigation started while we awaited data — discard this result.
  if (token !== renderToken) return;

  dom.viewRoot.innerHTML = html;
  dom.viewRoot.scrollTop = 0;
  syncPlaybackUI(getState());
}

function markActiveNav(route) {
  const map = { home: 'home', search: 'search', library: 'library', liked: 'library' };
  const active = map[route.name] || '';
  $$('.nav__item').forEach((el) => el.classList.toggle('is-active', el.dataset.nav === active));
}

/* ------------------------------------------------------------------ search */
async function runSearch(query) {
  const resultsEl = $('#searchResults');
  if (!resultsEl) return;

  const q = String(query || '').trim();
  if (!q) {
    ctx.searchResult = null;
    resultsEl.innerHTML = searchResultsHTML(ctx, '');
    return;
  }

  resultsEl.innerHTML = `<div class="stack-2" style="margin-top:8px">
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
    </div>`;

  ctx.searchResult = await repo.search(q).catch(() => ({ tracks: [], albums: [], artists: [] }));
  resultsEl.innerHTML = searchResultsHTML(ctx, q);
  syncPlaybackUI(getState());
}

const debouncedSearch = debounce((q) => {
  runSearch(q);
}, 260);

/* ===========================================================================
   Store → DOM synchronisation
   =========================================================================== */
let isScrubbing = false;

/** Write only when the value actually changed — avoids DOM churn at 4 Hz. */
function setIfChanged(node, key, value) {
  if (!node) return;
  if (node.dataset[key] === String(value)) return;
  node.dataset[key] = String(value);
  return true;
}

/** Tracks the last rendered transport state so we can skip redundant work. */
const lastSync = { trackId: null, isPlaying: null, repeat: null, eqPlaying: null };

function syncPlaybackUI(state) {
  const pb = state.playback;
  const track = pb.track;

  /* ---------------- player bar ---------------------------------------- */
  if (track) {
    dom.playerTitle.textContent = track.title;
    dom.playerTitle.title = track.title;
    dom.playerArtist.textContent =
      track.is_tiktok_source
        ? `${track.artist_name} · @${track.tiktok_author || CONFIG.TIKTOK_HANDLE}`
        : track.artist_name || 'Unknown artist';
    dom.playerArtist.href = track.artist_id ? `#/artist/${track.artist_id}` : '#/home';

    if (track.cover_url) {
      dom.playerArt.src = track.cover_url;
      dom.playerArt.alt = `${track.title} cover`;
      dom.playerArt.hidden = false;
      dom.playerArtWrap.classList.remove('player__art-wrap--empty');
    } else {
      dom.playerArt.hidden = true;
      dom.playerArtWrap.classList.add('player__art-wrap--empty');
    }
  } else {
    dom.playerTitle.textContent = 'Nothing playing';
    dom.playerArtist.textContent = 'Pick a track to start';
    dom.playerArtist.href = '#/home';
    dom.playerArt.hidden = true;
    dom.playerArtWrap.classList.add('player__art-wrap--empty');
  }

  const liked = track ? state.library.likedIds.has(track.id) : false;
  dom.playerLike.classList.toggle('is-liked', liked);
  dom.playerLike.setAttribute('aria-pressed', String(liked));

  /* ---------------- transport ----------------------------------------- */
  const playing = pb.isPlaying;
  if (lastSync.isPlaying !== playing) {
    dom.playToggle.innerHTML = icon(playing ? 'pause' : 'play', 18);
    dom.playToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    lastSync.isPlaying = playing;
  }
  dom.playToggle.disabled = !track;

  const shuffleBtn = $('[data-ctl="shuffle"]');
  shuffleBtn.classList.toggle('is-active', pb.shuffle);
  shuffleBtn.setAttribute('aria-pressed', String(pb.shuffle));
  shuffleBtn.setAttribute('aria-label', pb.shuffle ? 'Disable shuffle' : 'Enable shuffle');

  const repeatBtn = $('[data-ctl="repeat"]');
  repeatBtn.classList.toggle('is-active', pb.repeat !== 'off');
  repeatBtn.setAttribute('aria-pressed', String(pb.repeat !== 'off'));
  if (lastSync.repeat !== pb.repeat) {
    repeatBtn.innerHTML = icon(pb.repeat === 'one' ? 'repeat-one' : 'repeat', 17);
    lastSync.repeat = pb.repeat;
  }
  repeatBtn.setAttribute(
    'aria-label',
    pb.repeat === 'off' ? 'Enable repeat' : pb.repeat === 'all' ? 'Repeat this track' : 'Disable repeat',
  );

  /* ---------------- timeline ------------------------------------------ */
  const duration = pb.duration || track?.duration_seconds || 0;
  const pct = ratio(pb.progress, duration);

  if (!isScrubbing) {
    dom.scrubFill.style.width = `${pct * 100}%`;
    dom.scrub.style.setProperty('--pct', `${pct * 100}%`);
    dom.scrubBuffered.style.width = `${(pb.buffered || 0) * 100}%`;
    dom.timeElapsed.textContent = fmtTime(pb.progress);
  }
  dom.timeTotal.textContent = fmtTime(duration);

  const canSeek = Boolean(track) && duration > 0;
  dom.scrub.classList.toggle('is-disabled', !canSeek);
  dom.scrub.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  dom.scrub.setAttribute('aria-valuetext', `${fmtTime(pb.progress)} of ${fmtTime(duration)}`);
  dom.scrub.title =
    pb.mode === 'hybrid' && track?.audio_url
      ? 'Timeline follows the audio bed — the TikTok embed itself cannot be seeked'
      : pb.mode === 'hybrid'
        ? 'The official TikTok player controls its own timeline'
        : 'Seek';

  /* ---------------- volume -------------------------------------------- */
  const vol = pb.muted ? 0 : pb.volume;
  dom.volumeFill.style.width = `${vol * 100}%`;
  dom.volumeScrub.style.setProperty('--pct', `${vol * 100}%`);
  dom.volumeScrub.setAttribute('aria-valuenow', String(Math.round(vol * 100)));
  dom.volumeBox.classList.toggle('is-muted', pb.muted || vol === 0);
  dom.muteBtn.innerHTML = icon(
    pb.muted || vol === 0 ? 'volume-mute' : vol < 0.5 ? 'volume-low' : 'volume-high',
    18,
  );
  dom.muteBtn.setAttribute('aria-pressed', String(pb.muted));
  dom.muteBtn.setAttribute('aria-label', pb.muted ? 'Unmute' : 'Mute');

  /* ---------------- source indicator ---------------------------------- */
  const hasVideo = Boolean(track && (track.is_tiktok_source || track.video_url));
  dom.sourceIndicator.hidden = !hasVideo;
  dom.sourceIndicator.classList.toggle('is-video', hasVideo && pb.mode === 'hybrid');

  /* ---------------- track rows ---------------------------------------- */
  if (lastSync.trackId !== (track?.id ?? null) || lastSync.eqPlaying !== playing) {
    lastSync.trackId = track?.id ?? null;
    lastSync.eqPlaying = playing;
    syncActiveRows(pb);
  }

  /* ---------------- video panel --------------------------------------- */
  syncVideoPanel(state);

  /* ---------------- action bar play buttons --------------------------- */
  $$('.action-bar__play').forEach((btn) => {
    const key = btn.dataset.collection;
    const isCurrent = Boolean(
      key && track && (collections.get(key) || []).some((t) => t.id === track.id),
    );
    const label = isCurrent && playing ? 'pause' : 'play';
    if (setIfChanged(btn, 'icon', label)) btn.innerHTML = icon(label, 22);
  });
}

/** Toggle the equaliser/active styling on rendered rows without re-rendering. */
function syncActiveRows(pb) {
  const rows = $$('.track-row[data-track-id]');
  if (!rows.length) return;
  rows.forEach((row) => {
    const isActive = pb.track?.id === row.dataset.trackId;
    row.classList.toggle('is-active', isActive);
    const marker = row.querySelector('.track-row__index');
    if (!marker) return;

    const existingEq = marker.querySelector('.eq');
    const existingNum = marker.querySelector('.track-row__index-num');

    if (isActive) {
      if (existingNum) existingNum.remove();
      if (!existingEq) {
        const eq = document.createElement('span');
        eq.className = `eq${pb.isPlaying ? '' : ' is-paused'}`;
        eq.setAttribute('aria-hidden', 'true');
        eq.innerHTML = '<span></span><span></span><span></span><span></span>';
        marker.prepend(eq);
      } else {
        existingEq.classList.toggle('is-paused', !pb.isPlaying);
      }
    } else if (existingEq) {
      existingEq.remove();
    }
  });
}

function syncLikeUI(likedIds) {
  setLibrary({ likedIds });
  $$('[data-action="like-track"]').forEach((btn) => {
    const isLiked = likedIds.has(btn.dataset.trackId);
    btn.classList.toggle('is-liked', isLiked);
    btn.setAttribute('aria-pressed', String(isLiked));
    btn.setAttribute('aria-label', isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs');
  });
  syncPlaybackUI(getState());
}

/* ===========================================================================
   Video panel
   =========================================================================== */
function syncVideoPanel(state) {
  const pb = state.playback;
  const track = pb.track;
  const isTikTok = Boolean(track?.is_tiktok_source);
  const open = isTikTok && pb.videoOpen;

  dom.videoPanel.dataset.open = String(open);
  dom.videoPanel.setAttribute('aria-hidden', String(!open));

  if (!isTikTok) return;

  dom.videoHandle.textContent = `@${track.tiktok_author || CONFIG.TIKTOK_HANDLE}`;
  const profileUrl = `https://www.tiktok.com/@${track.tiktok_author || CONFIG.TIKTOK_HANDLE}`;
  dom.videoAvatar.src = track.artist_image_url || './assets/covers/artist-spotibai.svg';
  dom.videoAvatar.alt = `${track.artist_name} avatar`;
  dom.videoPosted.textContent = track.tiktok_posted_at
    ? `${fmtRelative(track.tiktok_posted_at)} · ${fmtCount(track.tiktok_like_count)} likes`
    : 'TikTok drop';

  dom.videoCaption.textContent = track.tiktok_caption || track.title;
  dom.videoTags.innerHTML = (track.tiktok_hashtags || [])
    .map(
      (tag) =>
        `<a class="video-panel__tag" href="https://www.tiktok.com/tag/${encodeURIComponent(tag)}"
            target="_blank" rel="noopener noreferrer">#${esc(tag)}</a>`,
    )
    .join('');

  dom.videoLikes.textContent = fmtCount(track.tiktok_like_count);
  dom.videoComments.textContent = fmtCount(track.tiktok_comment_count);
  dom.videoShares.textContent = fmtCount(track.tiktok_share_count);

  const videoUrl = track.video_url || profileUrl;
  dom.videoOpenLink.href = videoUrl;
  dom.videoFallbackLink.href = videoUrl;

  // Poster doubles as the visual while the embed loads / after it is blocked.
  dom.videoPoster.src = track.thumbnail_url || track.cover_url || '';
  dom.videoPoster.alt = `${track.title} poster`;
  dom.videoPoster.hidden = false;

  const status = pb.videoStatus;
  const showFallback = status === 'gate' || status === 'blocked' || status === 'slow';
  dom.videoFallback.hidden = !showFallback;
  dom.videoPoster.style.opacity = showFallback ? '1' : '0';

  if (showFallback) {
    const copy = dom.videoFallback.querySelector('p');
    const loadBtn = $('#videoLoadEmbed');
    const link = $('#videoFallbackLink');

    if (status === 'gate') {
      copy.innerHTML = `Load the official TikTok player here to hear the original sound.<br />You’ll stay in SpotiBai.`;
      loadBtn.hidden = false;
      link.className = 'btn btn--sm btn--ghost';
    } else if (status === 'blocked') {
      copy.innerHTML = `The official TikTok player can’t load here right now.<br />No substitute audio will be played.`;
      loadBtn.hidden = true;
      link.className = 'btn btn--sm';
    } else {
      copy.innerHTML = `Still loading the official TikTok player…<br />It will play the original sound when ready.`;
      loadBtn.hidden = true;
      link.className = 'btn btn--sm';
    }
  }

  dom.videoNote.textContent =
    pb.videoStatus === 'manual'
      ? 'You are controlling playback inside the TikTok player'
      : track.audio_url
        ? 'Video + audio bed — timeline follows the audio'
        : 'Video only — no local audio bed';
}

/* ===========================================================================
   Library sidebar
   =========================================================================== */
async function renderLibrarySidebar() {
  if (!repo) return;
  let playlists = [];
  try {
    playlists = await repo.listPlaylists();
  } catch {
    playlists = [];
  }
  const state = getState();
  const likedCount = state.library.likedIds.size;
  const currentId = state.playback.track?.id;

  const likedRow = `
    <a class="library__row ${currentId && state.library.likedIds.has(currentId) ? 'is-playing' : ''}"
       href="#/liked" data-nav-row="liked">
      <span class="library__art library__art--liked">${icon('heart', 20)}</span>
      <span class="library__row-text">
        <span class="library__row-title">Liked Songs</span>
        <span class="library__row-meta">Playlist · ${likedCount} ${likedCount === 1 ? 'song' : 'songs'}</span>
      </span>
    </a>`;

  const playlistRows = playlists
    .map(
      (p) => `
      <a class="library__row" href="#/playlist/${esc(p.id)}" data-nav-row="playlist">
        <img class="library__art" src="${esc(p.cover_url || './assets/covers/playlist-tangalog-heat.svg')}"
             alt="" loading="lazy" />
        <span class="library__row-text">
          <span class="library__row-title">${esc(p.title)}</span>
          <span class="library__row-meta">Playlist · ${p.track_count ?? 0} ${(p.track_count ?? 0) === 1 ? 'song' : 'songs'}</span>
        </span>
      </a>`,
    )
    .join('');

  dom.libraryList.innerHTML = likedRow + playlistRows;
  setLibrary({ playlists });
}

/* ===========================================================================
   Session / chrome
   =========================================================================== */
function renderSessionChrome() {
  const { user, profile } = getState().session;
  const name = profile?.display_name || user?.email?.split('@')[0] || 'Guest listener';

  dom.userName.textContent = name;
  dom.userAvatar.textContent =
    (profile?.display_name || name)
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || 'SB';
  dom.userAvatar.title = name;

  dom.menuAccountLabel.textContent = user
    ? user.email
    : repo?.mode === 'demo'
      ? 'Guest · local demo'
      : 'Not signed in';
  dom.signOutItem.hidden = !user;
  $('[data-action="open-auth"]', dom.userMenuList).hidden = Boolean(user);

  const badgeText =
    repo?.mode === 'supabase' ? 'Supabase' : repo?.degraded ? 'Demo (offline)' : 'Demo data';
  dom.sourceBadgeText.textContent = badgeText;
  dom.sourceBadge.className = `badge ${repo?.mode === 'supabase' ? 'badge--live' : 'badge--demo'}`;
  dom.sourceBadge.title =
    repo?.mode === 'supabase'
      ? 'Connected to Supabase — click to inspect or change'
      : repo?.degraded
        ? `Supabase unreachable (${repo.reason}) — running on demo data`
        : 'Running on local demo data — click to connect Supabase';
}

/* ===========================================================================
   Boot
   =========================================================================== */
async function boot() {
  // 1 — repository -----------------------------------------------------------
  let resolved;
  try {
    resolved = await createRepository();
    repo = resolved.repo;
    repo.degraded = resolved.degraded;
    repo.reason = resolved.reason;
  } catch (err) {
    console.error('[app] repository failed', err);
    dom.viewRoot.innerHTML = notFound(
      'Could not initialise the data layer. Check the browser console, then reload.',
    );
    return;
  }

  setState({ source: repo.mode, ready: true });
  renderSessionChrome();

  // 2 — session + likes ------------------------------------------------------
  try {
    const session = await repo.auth.getSession();
    if (session) setSession(session.user, session.profile);
    const ids = await repo.likedIds();
    setLibrary({ likedIds: new Set(ids || []) });
  } catch (err) {
    console.warn('[app] session bootstrap failed', err);
  }

  repo.auth.onChange?.((session) => {
    if (session) setSession(session.user, session.profile);
    else setSession(null, null);
    renderSessionChrome();
    renderLibrarySidebar();
    syncPlaybackUI(getState());
  });

  // 3 — media engine ---------------------------------------------------------
  engine = new MediaEngine({
    audioEl: $('#audioEl'),
    hooks: {
      onTime: ({ progress, duration, buffered }) => {
        setPlayback({ progress, duration, buffered });
      },
      onPlayState: (isPlaying) => setPlayback({ isPlaying }),
      onEnded: () => controller.next({ auto: true }),
      onError: (msg) => toast(msg, 'error'),
      onMode: (mode) => setPlayback({ mode }),
      onVideoStatus: (videoStatus) => setPlayback({ videoStatus }),
    },
  });

  // Deep links (#/track/:id) ask the view to start playback after mount.
  ctx.requestPlay = ({ collection, trackId }) => {
    setTimeout(() => playCollection(collection, { trackId }), 0);
  };

  controller = new PlaybackController(engine, {
    repo,
    toast,
    onLikesChanged: (ids) => syncLikeUI(new Set(ids)),
  });

  const pb = getState().playback;
  engine.setVolume(pb.volume);
  engine.setMuted(pb.muted);
  setPlayback({ duration: 0 });

  // 4 — state → DOM ----------------------------------------------------------
  subscribe((state) => syncPlaybackUI(state));

  // 5 — first paint ----------------------------------------------------------
  await Promise.all([renderLibrarySidebar(), renderRoute(parseRoute())]);
  renderSessionChrome();
  syncPlaybackUI(getState());
}

/* ===========================================================================
   Interactions
   =========================================================================== */

/* ---- delegated click ----------------------------------------------------- */
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');

  // Close the user menu when clicking outside it.
  if (!event.target.closest('#userMenu')) {
    dom.userMenuList.dataset.open = 'false';
    $('[data-action="toggle-user-menu"]')?.setAttribute('aria-expanded', 'false');
  }

  if (!target) return;
  const { action } = target.dataset;

  switch (action) {
    /* --- navigation ---------------------------------------------------- */
    case 'navigate': {
      event.preventDefault();
      if (target.dataset.href) navigate(target.dataset.href);
      break;
    }

    /* --- playback ------------------------------------------------------ */
    case 'play-row': {
      const { trackId, collection } = target.dataset;
      event.preventDefault();
      await playCollection(collection, { trackId });
      break;
    }

    case 'play-collection': {
      event.preventDefault();
      const key = target.dataset.collection;
      await playCollection(key, { toggleIfCurrent: true });
      break;
    }

    /* --- likes --------------------------------------------------------- */
    case 'like-track': {
      event.preventDefault();
      event.stopPropagation();
      await controller.toggleLike(target.dataset.trackId);
      if (currentRoute.name === 'liked') renderRoute(currentRoute);
      break;
    }

    case 'like-current': {
      event.preventDefault();
      const current = getState().playback.track;
      if (!current) {
        toast('Nothing is playing yet.');
        break;
      }
      await controller.toggleLike(current.id);
      if (currentRoute.name === 'liked') renderRoute(currentRoute);
      break;
    }

    /* --- playlists ----------------------------------------------------- */
    case 'add-to-playlist': {
      event.preventDefault();
      event.stopPropagation();
      const trackId = target.dataset.trackId;
      const track = (await repo.getTrack(trackId)) || { title: 'Track' };
      const playlists = await repo.listPlaylists().catch(() => []);
      openAddToPlaylistModal({
        track,
        playlists,
        onPick: async (playlistId) => {
          try {
            const res = await repo.addTrackToPlaylist(playlistId, trackId);
            toast(
              res?.added === false ? 'Already in that playlist' : 'Added to playlist',
              res?.added === false ? 'info' : 'success',
            );
            renderLibrarySidebar();
            if (currentRoute.name === 'playlist') renderRoute(currentRoute);
          } catch (err) {
            toast(err.message || 'Could not add to playlist', 'error');
          }
        },
        onCreateNew: () => openCreatePlaylistModal({ onCreate: handleCreatePlaylist }),
      });
      break;
    }

    case 'remove-from-playlist': {
      event.preventDefault();
      event.stopPropagation();
      const playlistId = currentRoute.id;
      try {
        await repo.removeTrackFromPlaylist(playlistId, target.dataset.trackId);
        toast('Removed from playlist');
        await renderRoute(currentRoute);
        renderLibrarySidebar();
      } catch (err) {
        toast(err.message || 'Could not remove track', 'error');
      }
      break;
    }

    case 'create-playlist': {
      event.preventDefault();
      openCreatePlaylistModal({ onCreate: handleCreatePlaylist });
      break;
    }

    case 'delete-playlist': {
      event.preventDefault();
      const playlistId = target.dataset.playlistId;
      openConfirmModal({
        title: 'Delete playlist?',
        message: 'This removes the playlist for everyone. The tracks stay in the catalog.',
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await repo.deletePlaylist(playlistId);
            toast('Playlist deleted');
            await renderLibrarySidebar();
            navigate('/library');
          } catch (err) {
            toast(err.message || 'Could not delete playlist', 'error');
          }
        },
      });
      break;
    }

    /* --- auth ---------------------------------------------------------- */
    case 'open-auth': {
      openAuthModal({
        repo,
        onSignedIn: async (session) => {
          setSession(session.user, session.profile);
          renderSessionChrome();
          const ids = await repo.likedIds().catch(() => []);
          setLibrary({ likedIds: new Set(ids) });
          await renderLibrarySidebar();
          syncPlaybackUI(getState());
          toast(`Signed in as ${session.profile?.display_name || session.user.email}`, 'success');
          renderRoute(currentRoute);
        },
      });
      break;
    }

    case 'sign-out': {
      try {
        await repo.auth.signOut();
        setSession(null, null);
        setLibrary({ likedIds: new Set() });
        renderSessionChrome();
        await renderLibrarySidebar();
        renderRoute(currentRoute);
        toast('Signed out');
      } catch (err) {
        toast(err.message || 'Could not sign out', 'error');
      }
      break;
    }

    case 'open-source': {
      openSourceModal({ repo });
      break;
    }

    /* --- menus / panels ------------------------------------------------ */
    case 'toggle-user-menu': {
      const open = dom.userMenuList.dataset.open !== 'true';
      dom.userMenuList.dataset.open = String(open);
      target.setAttribute('aria-expanded', String(open));
      break;
    }

    case 'toggle-video-panel': {
      const pb = getState().playback;
      if (!pb.track?.is_tiktok_source) {
        toast('The video panel appears for TikTok-sourced tracks.');
        break;
      }
      setPlayback({ videoOpen: !pb.videoOpen });
      break;
    }

    case 'load-embed': {
      event.preventDefault();
      if (!getState().playback.track?.is_tiktok_source) break;
      engine.loadTikTokEmbed();
      break;
    }

    case 'close-video': {
      setPlayback({ videoOpen: false, videoExpanded: false });
      dom.videoPanel.dataset.expanded = 'false';
      break;
    }

    case 'toggle-video-expand': {
      const expanded = dom.videoPanel.dataset.expanded === 'true';
      dom.videoPanel.dataset.expanded = String(!expanded);
      target.setAttribute('aria-label', expanded ? 'Expand video panel' : 'Collapse video panel');
      break;
    }

    case 'toggle-queue': {
      openQueueModal({
        playback: getState().playback,
        onJump: (index) => controller.playQueue(getState().playback.queue, index),
      });
      break;
    }

    /* --- search -------------------------------------------------------- */
    case 'search-chip': {
      const q = target.dataset.q;
      navigate(`/search?q=${encodeURIComponent(q)}`);
      break;
    }

    /* --- history ------------------------------------------------------- */
    case 'history-back':
      history.back();
      break;
    case 'history-forward':
      history.forward();
      break;

    default:
      break;
  }
});

/* ---- player transport ---------------------------------------------------- */
$$('[data-ctl]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    switch (btn.dataset.ctl) {
      case 'toggle':
        if (!getState().playback.track) {
          // Nothing loaded yet: start the first thing in the catalog.
          const top = await repo.topTracks(10).catch(() => []);
          if (top.length) {
            registerCollection('quick:top', top);
            await controller.playQueue(top, 0);
          }
          return;
        }
        await controller.toggle();
        break;
      case 'next':
        await controller.next();
        break;
      case 'prev':
        await controller.prev();
        break;
      case 'shuffle':
        controller.toggleShuffle();
        break;
      case 'repeat':
        controller.cycleRepeat();
        break;
      case 'mute':
        controller.toggleMute();
        break;
      default:
        break;
    }
  });
});

/* ---- keyboard on rows ---------------------------------------------------- */
dom.viewRoot.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('[data-action="play-row"], [data-action="navigate"]');
  if (!row) return;
  event.preventDefault();
  // Stop the document-level shortcut handler from also reacting (Space = play).
  event.stopPropagation();
  row.click();
});

/* ---- search input -------------------------------------------------------- */
dom.viewRoot.addEventListener('input', (event) => {
  const input = event.target.closest('[data-search-input]');
  if (!input) return;
  const q = input.value;
  replaceQuerySafe(q);
  debouncedSearch(q);
});

dom.viewRoot.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-search-form]');
  if (!form) return;
  event.preventDefault();
  navigate(`/search?q=${encodeURIComponent(form.q.value.trim())}`);
});

function replaceQuerySafe(q) {
  const url = `${location.pathname}#/search?q=${encodeURIComponent(q)}`;
  history.replaceState({ ...history.state, spotibai: true }, '', url);
}

/* ---- sidebar / mobile ---------------------------------------------------- */
dom.menuToggle.addEventListener('click', () => {
  const open = dom.sidebar.dataset.open !== 'true';
  dom.sidebar.dataset.open = String(open);
  dom.menuToggle.setAttribute('aria-expanded', String(open));
  dom.scrim.hidden = !open;
});

function closeMobileSidebar() {
  if (!isMobile()) return;
  dom.sidebar.dataset.open = 'false';
  dom.menuToggle?.setAttribute('aria-expanded', 'false');
  dom.scrim.hidden = true;
}

dom.scrim.addEventListener('click', () => {
  dom.sidebar.dataset.open = 'false';
  dom.menuToggle.setAttribute('aria-expanded', 'false');
  dom.scrim.hidden = true;
});

/* ===========================================================================
   Scrubbing (timeline + volume)
   =========================================================================== */
function bindScrubber(element, { onScrub, onCommit, isEnabled = () => true }) {
  let active = false;

  const ratioFromEvent = (event) => {
    const rect = element.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  };

  const move = (event) => {
    if (!active) return;
    onScrub(ratioFromEvent(event));
  };

  const up = (event) => {
    if (!active) return;
    active = false;
    element.classList.remove('is-scrubbing');
    onCommit?.(ratioFromEvent(event));
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  element.addEventListener('pointerdown', (event) => {
    if (!isEnabled()) return;
    event.preventDefault();
    active = true;
    isScrubbing = element === dom.scrub;
    element.classList.add('is-scrubbing');
    element.setPointerCapture?.(event.pointerId);
    onScrub(ratioFromEvent(event));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  element.addEventListener('keydown', (event) => {
    if (!isEnabled()) return;
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onScrub(clamp(Number(element.getAttribute('aria-valuenow')) / 100 + step, 0, 1));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onScrub(clamp(Number(element.getAttribute('aria-valuenow')) / 100 - step, 0, 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onScrub(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onScrub(1);
    }
  });

  element.addEventListener('pointerup', () => {
    isScrubbing = false;
  });
}

bindScrubber(dom.scrub, {
  isEnabled: () => {
    const pb = getState().playback;
    return Boolean(pb.track) && (pb.duration || pb.track?.duration_seconds) > 0;
  },
  onScrub: (r) => {
    const duration = getState().playback.duration || getState().playback.track?.duration_seconds || 0;
    dom.scrubFill.style.width = `${r * 100}%`;
    dom.scrub.style.setProperty('--pct', `${r * 100}%`);
    dom.timeElapsed.textContent = fmtTime(r * duration);
  },
  onCommit: (r) => {
    isScrubbing = false;
    controller.seekRatio(r);
  },
});

bindScrubber(dom.volumeScrub, {
  isEnabled: () => true,
  onScrub: (r) => {
    dom.volumeFill.style.width = `${r * 100}%`;
    dom.volumeScrub.style.setProperty('--pct', `${r * 100}%`);
    controller.setVolume(r);
    if (r > 0 && getState().playback.muted) controller.toggleMute();
  },
});

/* ===========================================================================
   Global keyboard shortcuts
   =========================================================================== */
document.addEventListener('keydown', async (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    navigate('/search');
    setTimeout(() => $('[data-search-input]')?.focus(), 60);
    return;
  }

  if (event.key === 'Escape') {
    dom.userMenuList.dataset.open = 'false';
    if (getState().playback.videoOpen) setPlayback({ videoOpen: false });
    closeMobileSidebar();
    return;
  }

  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  // Space activates the focused button natively — do not double-fire it.
  const focusedControl = document.activeElement?.closest(
    'button, a[href], [role="slider"], [role="button"]',
  );

  switch (event.key) {
    case ' ':
      if (focusedControl) return;
      event.preventDefault();
      await controller.toggle();
      break;
    case 'k':
      event.preventDefault();
      await controller.toggle();
      break;
    case 'ArrowRight':
      event.preventDefault();
      controller.seekBy(event.shiftKey ? 30 : 5);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      controller.seekBy(event.shiftKey ? -30 : -5);
      break;
    case 'n':
      await controller.next();
      break;
    case 'p':
      await controller.prev();
      break;
    case 'm':
      controller.toggleMute();
      break;
    case 's':
      controller.toggleShuffle();
      break;
    case 'r':
      controller.cycleRepeat();
      break;
    case 'l':
      if (getState().playback.track) await controller.toggleLike(getState().playback.track.id);
      break;
    default:
      break;
  }
});

/* ===========================================================================
   Helpers bound to controller / repo
   =========================================================================== */
async function handleCreatePlaylist({ title, description, isPublic }) {
  const playlist = await repo.createPlaylist({ title, description, isPublic });
  const state = getState();
  if (state.session.user) {
    // Optimistically open it; the detail fetch confirms from the backend.
    toast('Playlist created', 'success');
    await renderLibrarySidebar();
    navigate(`/playlist/${playlist.id}`);
  } else if (repo.mode === 'demo') {
    toast('Playlist created (demo)', 'success');
    await renderLibrarySidebar();
    navigate(`/playlist/${playlist.id}`);
  } else {
    openAuthModal({
      repo,
      onSignedIn: () => handleCreatePlaylist({ title, description, isPublic }),
    });
  }
}

/* ===========================================================================
   Route subscription + go
   =========================================================================== */
onRouteChange((route) => {
  renderRoute(route);
});

window.addEventListener('online', () => toast('Back online'));
window.addEventListener('offline', () => toast('Offline — playback continues from cache', 'error'));

document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();

/* Expose a tiny debug surface for console poking / smoke tests. */
window.spotibai = {
  get state() {
    return getState();
  },
  get repo() {
    return repo;
  },
  get engine() {
    return engine;
  },
  get controller() {
    return controller;
  },
  playCollection,
  navigate,
  collections,
};
