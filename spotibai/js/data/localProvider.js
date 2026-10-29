/**
 * localProvider.js — the DEMO repository
 * ---------------------------------------------------------------------------
 * Implements the exact same async interface as `SupabaseRepository`, backed by
 * `demoSeed.js` + localStorage. This is what boots when no Supabase credentials
 * are configured, which means:
 *
 *   • the app is fully explorable with zero setup and zero network,
 *   • every view/component is exercised identically in both modes,
 *   • swapping to real Supabase is a one-line change in supabaseClient.js.
 *
 * Mutations (playlists, likes, history) persist to localStorage so the demo
 * survives reloads. Nothing leaves the browser.
 */

import {
  tracks as seedTracks,
  albums as seedAlbums,
  artists as seedArtists,
  playlists as seedPlaylists,
  initialLikedIds,
  recentTrackIds,
  demoProfile,
} from './demoSeed.js';
import { STORAGE_KEYS, CONFIG } from '../config.js';
import { parseTikTokId, sleep, storage } from '../utils.js';

const DB_KEY = STORAGE_KEYS.demoDb;
const SESSION_KEY = STORAGE_KEYS.demoSession;

/* ---------------------------------------------------------------- state --- */
let db = null; // { likes: string[], playlists: [...], history: [{trackId, at}] }

function loadDb() {
  const saved = storage.get(DB_KEY, null);
  if (saved && Array.isArray(saved.likes) && Array.isArray(saved.playlists)) {
    return saved;
  }
  return {
    likes: initialLikedIds.slice(),
    playlists: seedPlaylists.map((p) => ({ ...p, trackIds: p.trackIds.slice() })),
    history: recentTrackIds.map((id, i) => ({
      trackId: id,
      at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
    })),
  };
}

function persist() {
  storage.set(DB_KEY, db);
}

const latency = () => sleep(CONFIG.DEMO_LATENCY_MS * (0.6 + Math.random() * 0.8));

/* ------------------------------------------------------------- hydration -- */

/** Join a raw track row into the `track_details` view shape used app-wide. */
export function hydrateTrack(row) {
  const album = seedAlbums.find((a) => a.id === row.album_id) || null;
  const artist = seedArtists.find((a) => a.id === row.artist_id) || null;
  return {
    id: row.id,
    title: row.title,
    duration_seconds: row.duration_seconds,
    track_number: row.track_number ?? null,
    audio_url: row.audio_url ?? null,
    video_url: row.video_url ?? null,
    is_tiktok_source: Boolean(row.is_tiktok_source),
    tiktok_video_id: row.tiktok_video_id ?? parseTikTokId(row.video_url),
    tiktok_author: row.tiktok_author ?? null,
    tiktok_caption: row.tiktok_caption ?? '',
    tiktok_hashtags: row.tiktok_hashtags ?? [],
    tiktok_like_count: row.tiktok_like_count ?? 0,
    tiktok_comment_count: row.tiktok_comment_count ?? 0,
    tiktok_share_count: row.tiktok_share_count ?? 0,
    tiktok_posted_at: row.tiktok_posted_at ?? null,
    thumbnail_url: row.thumbnail_url ?? null,
    cover_url: row.thumbnail_url || album?.cover_url || artist?.image_url || null,
    album_cover_url: album?.cover_url ?? null,
    play_count: row.play_count ?? 0,
    explicit: Boolean(row.explicit),
    created_at: row.created_at ?? null,
    album_id: row.album_id ?? null,
    album_title: album?.title ?? null,
    release_year: album?.release_year ?? null,
    artist_id: row.artist_id,
    artist_name: artist?.name ?? 'Unknown artist',
    artist_image_url: artist?.image_url ?? null,
    media_kind: row.is_tiktok_source ? 'tiktok_video' : 'audio',
  };
}

const allTracks = () => seedTracks.map(hydrateTrack);
const trackById = (id) => allTracks().find((t) => t.id === id) || null;

/* ============================================================================
   Repository
   ============================================================================ */
export const localProvider = {
  mode: 'demo',

  async init() {
    db = loadDb();
    persist();
    return { mode: 'demo' };
  },

  /* ------------------------------------------------------------------ auth */
  auth: {
    async getSession() {
      const saved = storage.get(SESSION_KEY, null);
      return saved && saved.user ? saved : null;
    },

    /** Demo auth accepts any well-formed credentials — it never leaves the tab. */
    async signIn({ email, password }) {
      if (!email || !password || password.length < 6) {
        throw new Error('Enter an email and a password of at least 6 characters.');
      }
      const session = {
        user: { id: demoProfile.id, email },
        profile: { ...demoProfile, display_name: email.split('@')[0] },
        demo: true,
      };
      storage.set(SESSION_KEY, session);
      return session;
    },

    async signUp({ email, password, username }) {
      if (!email || !password || password.length < 6) {
        throw new Error('Enter an email and a password of at least 6 characters.');
      }
      const session = {
        user: { id: demoProfile.id, email },
        profile: {
          ...demoProfile,
          username: username || email.split('@')[0],
          display_name: username || email.split('@')[0],
        },
        demo: true,
      };
      storage.set(SESSION_KEY, session);
      return session;
    },

    async signOut() {
      storage.remove(SESSION_KEY);
      return null;
    },

    /** The demo provider has no remote session to listen to. */
    onChange() {
      return () => {};
    },
  },

  /* --------------------------------------------------------------- catalog */
  async listAlbums() {
    await latency();
    return seedAlbums.map((album) => {
      const artist = seedArtists.find((a) => a.id === album.artist_id);
      const albumTracks = allTracks().filter((t) => t.album_id === album.id);
      return {
        ...album,
        artist_name: artist?.name ?? 'Unknown artist',
        artist_image_url: artist?.image_url ?? null,
        track_count: albumTracks.length,
      };
    });
  },

  async getAlbum(id) {
    await latency();
    const album = seedAlbums.find((a) => a.id === id);
    if (!album) return null;
    const artist = seedArtists.find((a) => a.id === album.artist_id) || null;
    const tracks = allTracks()
      .filter((t) => t.album_id === id)
      .sort((a, b) => (a.track_number ?? 0) - (b.track_number ?? 0));
    return { album: { ...album, artist_name: artist?.name }, artist, tracks };
  },

  async listArtists() {
    await latency();
    return seedArtists.map((artist) => ({
      ...artist,
      track_count: allTracks().filter((t) => t.artist_id === artist.id).length,
    }));
  },

  async getArtist(id) {
    await latency();
    const artist = seedArtists.find((a) => a.id === id);
    if (!artist) return null;
    const artistTracks = allTracks().filter((t) => t.artist_id === id);
    return {
      artist,
      albums: seedAlbums.filter((a) => a.artist_id === id),
      topTracks: artistTracks.sort((a, b) => b.play_count - a.play_count).slice(0, 5),
      tracks: artistTracks,
    };
  },

  async getTrack(id) {
    await latency();
    return trackById(id);
  },

  async listTracks({ limit = 50 } = {}) {
    await latency();
    return allTracks().slice(0, limit);
  },

  async topTracks(limit = 10) {
    await latency();
    return allTracks()
      .slice()
      .sort((a, b) => b.play_count - a.play_count)
      .slice(0, limit);
  },

  async tiktokTracks(limit = 12) {
    await latency();
    return allTracks()
      .filter((t) => t.is_tiktok_source)
      .sort((a, b) => new Date(b.tiktok_posted_at) - new Date(a.tiktok_posted_at))
      .slice(0, limit);
  },

  async recentlyPlayed(limit = 10) {
    await latency();
    const seen = new Set();
    const ordered = [];
    for (const entry of db.history.slice().sort((a, b) => new Date(b.at) - new Date(a.at))) {
      if (seen.has(entry.trackId)) continue;
      const track = trackById(entry.trackId);
      if (!track) continue;
      seen.add(entry.trackId);
      ordered.push({ ...track, played_at: entry.at });
      if (ordered.length >= limit) break;
    }
    return ordered;
  },

  async search(query) {
    await latency();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { tracks: [], albums: [], artists: [] };
    const tracks = allTracks().filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist_name.toLowerCase().includes(q) ||
        (t.album_title || '').toLowerCase().includes(q),
    );
    const albums = seedAlbums
      .filter((a) => a.title.toLowerCase().includes(q))
      .map((a) => ({ ...a, artist_name: seedArtists.find((x) => x.id === a.artist_id)?.name }));
    const artists = seedArtists.filter((a) => a.name.toLowerCase().includes(q));
    return { tracks, albums, artists };
  },

  /* ------------------------------------------------------------- playlists */
  async listPlaylists() {
    await latency();
    return db.playlists.map((p) => ({
      ...p,
      track_count: p.trackIds.length,
      cover_url:
        p.cover_url ||
        trackById(p.trackIds[0])?.cover_url ||
        './assets/covers/playlist-tangalog-heat.svg',
    }));
  },

  async getPlaylist(id) {
    await latency();
    const playlist = db.playlists.find((p) => p.id === id);
    if (!playlist) return null;
    const tracks = playlist.trackIds.map(trackById).filter(Boolean);
    return {
      playlist: { ...playlist, track_count: tracks.length },
      tracks,
    };
  },

  async createPlaylist({ title, description = '', isPublic = false }) {
    await latency();
    const playlist = {
      id: crypto.randomUUID(),
      user_id: demoProfile.id,
      title: title?.trim() || 'My Playlist',
      description,
      is_public: Boolean(isPublic),
      cover_url: './assets/covers/playlist-tangalog-heat.svg',
      created_at: new Date().toISOString(),
      trackIds: [],
    };
    db.playlists.unshift(playlist);
    persist();
    return playlist;
  },

  async updatePlaylist(id, patch) {
    await latency();
    const playlist = db.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('Playlist not found');
    Object.assign(playlist, patch);
    persist();
    return playlist;
  },

  async deletePlaylist(id) {
    await latency();
    db.playlists = db.playlists.filter((p) => p.id !== id);
    persist();
    return true;
  },

  async addTrackToPlaylist(playlistId, trackId) {
    await latency();
    const playlist = db.playlists.find((p) => p.id === playlistId);
    if (!playlist) throw new Error('Playlist not found');
    if (playlist.trackIds.includes(trackId)) {
      return { added: false, reason: 'already-present' };
    }
    playlist.trackIds.push(trackId);
    persist();
    return { added: true };
  },

  async removeTrackFromPlaylist(playlistId, trackId) {
    await latency();
    const playlist = db.playlists.find((p) => p.id === playlistId);
    if (!playlist) throw new Error('Playlist not found');
    playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
    persist();
    return true;
  },

  /* ----------------------------------------------------------------- likes */
  async likedIds() {
    return db.likes.slice();
  },

  async likedTracks() {
    await latency();
    return db.likes.map(trackById).filter(Boolean);
  },

  async likeTrack(trackId, liked) {
    await latency();
    const isLiked = db.likes.includes(trackId);
    if (liked && !isLiked) db.likes.unshift(trackId);
    if (!liked && isLiked) db.likes = db.likes.filter((id) => id !== trackId);
    persist();
    return db.likes.slice();
  },

  /* --------------------------------------------------------------- history */
  async recordPlay(trackId) {
    db.history.unshift({ trackId, at: new Date().toISOString() });
    db.history = db.history.slice(0, 200);
    persist();
  },

  /** Dev helper used by the settings dialog: wipe local demo state. */
  async reset() {
    storage.remove(DB_KEY);
    db = loadDb();
    persist();
    return true;
  },
};
