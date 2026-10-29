/**
 * supabaseClient.js — data access layer
 * ---------------------------------------------------------------------------
 * Exposes ONE repository interface with TWO implementations:
 *
 *   SupabaseRepository  → real Postgres/Auth/Storage (schema.sql)
 *   localProvider       → offline demo (demoSeed.js + localStorage)
 *
 * `createRepository()` decides which to use at boot and guarantees the return
 * value implements the same method surface, so no view or engine ever needs to
 * know which backend is live. If credentials exist but the client cannot load
 * (offline preview, blocked CDN, bad key) we degrade to demo and report it,
 * rather than showing the user an empty, broken app.
 *
 * The Supabase JS SDK is loaded lazily via dynamic import — it is NEVER a
 * render-blocking dependency, and it is not required to run the demo.
 */

import { CONFIG, hasSupabaseCredentials, publicStorageUrl } from './config.js';
import { localProvider } from './data/localProvider.js';
import { parseTikTokId } from './utils.js';

let clientPromise = null;

/**
 * Lazily import supabase-js from an ESM CDN (cached).
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export function loadSupabaseClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const { createClient } = await import(/* @vite-ignore */ CONFIG.SUPABASE_MODULE);
    const client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'spotibai-auth',
      },
      global: { headers: { 'x-application-name': 'spotibai-web' } },
      realtime: { params: { eventsPerSecond: 2 } },
    });
    return client;
  })();

  return clientPromise;
}

/* ============================================================================
   Helpers
   ============================================================================ */

/** Normalise a `track_details` row (and resolve storage paths to public URLs). */
function mapTrack(row) {
  if (!row) return null;
  return {
    ...row,
    audio_url: publicStorageUrl(CONFIG.BUCKETS.audio, row.audio_url),
    // Bundled MP3 fallback keeps seeded tracks playable until Storage uploads finish.
    local_audio_fallback_url: (() => {
      const match = String(row.audio_url || '').match(/^\/?(?:\.\/)?assets\/audio\/([^/?#]+)$/);
      return match ? `./assets/audio/${match[1]}` : null;
    })(),
    video_url: row.video_url,
    cover_url: publicStorageUrl(
      CONFIG.BUCKETS.covers,
      row.cover_url || row.album_cover_url || row.thumbnail_url || null,
    ),
    tiktok_video_id: row.tiktok_video_id || parseTikTokId(row.video_url),
    tiktok_hashtags: row.tiktok_hashtags || [],
    is_tiktok_source: Boolean(row.is_tiktok_source),
    media_kind: row.media_kind || (row.is_tiktok_source ? 'tiktok_video' : 'audio'),
  };
}

/** PostgREST error → Error with a readable message. */
function fail(context, error) {
  console.error(`[supabase] ${context}`, error);
  throw new Error(error?.message || `Request failed: ${context}`);
}

/* ============================================================================
   SupabaseRepository
   ============================================================================ */
export class SupabaseRepository {
  constructor(client) {
    this.mode = 'supabase';
    this.client = client;
    this.db = client.from.bind(client);
  }

  async init() {
    return { mode: 'supabase' };
  }

  /* ------------------------------------------------------------------ auth */
  get auth() {
    const { client, self } = { client: this.client, self: this };
    return {
      async getSession() {
        const { data } = await client.auth.getSession();
        if (!data?.session) return null;
        const profile = await self.fetchProfile(data.session.user.id);
        return { user: data.session.user, profile, demo: false };
      },

      async signIn({ email, password }) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) fail('signIn', error);
        const profile = await self.fetchProfile(data.user.id);
        return { user: data.user, profile, demo: false };
      },

      async signUp({ email, password, username }) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: {
            data: { username, display_name: username },
            emailRedirectTo: `${location.origin}${location.pathname}`,
          },
        });
        if (error) fail('signUp', error);
        // Email confirmation may be on: session can be null until confirmed.
        const profile = data.user ? await self.fetchProfile(data.user.id) : null;
        return { user: data.user, profile, demo: false, needsConfirmation: !data.session };
      },

      async signOut() {
        const { error } = await client.auth.signOut();
        if (error) fail('signOut', error);
        return null;
      },

      onChange(callback) {
        const { data } = client.auth.onAuthStateChange(async (_event, session) => {
          if (!session) return callback(null);
          const profile = await self.fetchProfile(session.user.id);
          callback({ user: session.user, profile, demo: false });
        });
        return () => data?.subscription?.unsubscribe?.();
      },
    };
  }

  async fetchProfile(userId) {
    const { data, error } = await this.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[supabase] profile fetch failed', error.message);
      return null;
    }
    return data;
  }

  /* --------------------------------------------------------------- catalog */
  async listAlbums() {
    const { data, error } = await this.client
      .from('albums')
      .select('id, title, cover_url, release_year, artist_id, artists(name, image_url)')
      .order('release_year', { ascending: false });
    if (error) fail('listAlbums', error);
    return (data || []).map((a) => ({
      ...a,
      cover_url: publicStorageUrl(CONFIG.BUCKETS.covers, a.cover_url),
      artist_name: a.artists?.name ?? 'Unknown artist',
      artist_image_url: a.artists?.image_url ?? null,
    }));
  }

  async getAlbum(id) {
    const [albumRes, tracksRes] = await Promise.all([
      this.client
        .from('albums')
        .select('id, title, cover_url, release_year, artist_id, artists(id, name, image_url, bio)')
        .eq('id', id)
        .maybeSingle(),
      this.client
        .from('track_details')
        .select('*')
        .eq('album_id', id)
        .order('track_number', { ascending: true }),
    ]);
    if (albumRes.error) fail('getAlbum', albumRes.error);
    if (!albumRes.data) return null;
    if (tracksRes.error) fail('getAlbum tracks', tracksRes.error);
    return {
      album: {
        ...albumRes.data,
        cover_url: publicStorageUrl(CONFIG.BUCKETS.covers, albumRes.data.cover_url),
        artist_name: albumRes.data.artists?.name,
      },
      artist: albumRes.data.artists,
      tracks: (tracksRes.data || []).map(mapTrack),
    };
  }

  async listArtists() {
    const { data, error } = await this.client
      .from('artists')
      .select('id, name, bio, image_url')
      .order('name');
    if (error) fail('listArtists', error);
    return data || [];
  }

  async getArtist(id) {
    const [artistRes, albumsRes, tracksRes] = await Promise.all([
      this.client.from('artists').select('id, name, bio, image_url').eq('id', id).maybeSingle(),
      this.client.from('albums').select('id, title, cover_url, release_year, artist_id').eq('artist_id', id),
      this.client
        .from('track_details')
        .select('*')
        .eq('artist_id', id)
        .order('play_count', { ascending: false }),
    ]);
    if (artistRes.error) fail('getArtist', artistRes.error);
    if (!artistRes.data) return null;
    const tracks = (tracksRes.data || []).map(mapTrack);
    return {
      artist: artistRes.data,
      albums: (albumsRes.data || []).map((album) => ({
        ...album,
        cover_url: publicStorageUrl(CONFIG.BUCKETS.covers, album.cover_url),
      })),
      topTracks: tracks.slice(0, 5),
      tracks,
    };
  }

  async getTrack(id) {
    const { data, error } = await this.client
      .from('track_details')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) fail('getTrack', error);
    return mapTrack(data);
  }

  async listTracks({ limit = 50 } = {}) {
    const { data, error } = await this.client
      .from('track_details')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail('listTracks', error);
    return (data || []).map(mapTrack);
  }

  async topTracks(limit = 10) {
    const { data, error } = await this.client
      .from('track_details')
      .select('*')
      .order('play_count', { ascending: false })
      .limit(limit);
    if (error) fail('topTracks', error);
    return (data || []).map(mapTrack);
  }

  async tiktokTracks(limit = 12) {
    const { data, error } = await this.client
      .from('track_details')
      .select('*')
      .eq('is_tiktok_source', true)
      .order('tiktok_posted_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) fail('tiktokTracks', error);
    return (data || []).map(mapTrack);
  }

  async recentlyPlayed(limit = 10) {
    const { data: session } = await this.client.auth.getSession();
    if (!session?.session) return [];
    const { data, error } = await this.client
      .from('play_history')
      .select('track_id, played_at')
      .order('played_at', { ascending: false })
      .limit(limit * 3);
    if (error) return [];
    const ids = [...new Set((data || []).map((r) => r.track_id))].slice(0, limit);
    if (!ids.length) return [];
    const { data: tracks, error: tracksError } = await this.client
      .from('track_details')
      .select('*')
      .in('id', ids);
    if (tracksError) fail('recentlyPlayed', tracksError);
    const byId = new Map((tracks || []).map((t) => [t.id, mapTrack(t)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async search(query) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], albums: [], artists: [] };
    const like = `%${q}%`;
    const [tracksRes, albumsRes, artistsRes] = await Promise.all([
      this.client
        .from('track_details')
        .select('*')
        .or(`title.ilike.${like},artist_name.ilike.${like},album_title.ilike.${like}`)
        .limit(30),
      this.client
        .from('albums')
        .select('id, title, cover_url, release_year, artist_id, artists(name)')
        .ilike('title', like)
        .limit(12),
      this.client.from('artists').select('id, name, image_url').ilike('name', like).limit(12),
    ]);
    return {
      tracks: (tracksRes.data || []).map(mapTrack),
      albums: (albumsRes.data || []).map((a) => ({
        ...a,
        cover_url: publicStorageUrl(CONFIG.BUCKETS.covers, a.cover_url),
        artist_name: a.artists?.name,
      })),
      artists: artistsRes.data || [],
    };
  }

  /* ------------------------------------------------------------- playlists */
  async listPlaylists() {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    let query = this.client
      .from('playlists')
      .select('id, user_id, title, description, is_public, cover_url, created_at, playlist_tracks(count)')
      .order('created_at', { ascending: false });
    if (uid) query = query.or(`is_public.eq.true,user_id.eq.${uid}`);
    else query = query.eq('is_public', true);

    const { data, error } = await query;
    if (error) fail('listPlaylists', error);
    return (data || []).map((p) => ({
      ...p,
      track_count: p.playlist_tracks?.[0]?.count ?? 0,
    }));
  }

  async getPlaylist(id) {
    const [playlistRes, tracksRes] = await Promise.all([
      this.client
        .from('playlists')
        .select('id, user_id, title, description, is_public, cover_url, created_at, profiles(display_name, username)')
        .eq('id', id)
        .maybeSingle(),
      this.client
        .from('playlist_tracks')
        .select('position, added_at, tracks!inner(id)')
        .eq('playlist_id', id)
        .order('position', { ascending: true }),
    ]);
    if (playlistRes.error) fail('getPlaylist', playlistRes.error);
    if (!playlistRes.data) return null;

    const trackIds = (tracksRes.data || []).map((r) => r.tracks.id);
    let tracks = [];
    if (trackIds.length) {
      const { data, error } = await this.client
        .from('track_details')
        .select('*')
        .in('id', trackIds);
      if (error) fail('getPlaylist tracks', error);
      const byId = new Map((data || []).map((t) => [t.id, mapTrack(t)]));
      tracks = trackIds.map((tid) => byId.get(tid)).filter(Boolean);
    }

    return {
      playlist: {
        ...playlistRes.data,
        owner_name: playlistRes.data.profiles?.display_name || 'You',
        track_count: tracks.length,
      },
      tracks,
    };
  }

  async createPlaylist({ title, description = '', isPublic = false }) {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    if (!uid) throw new Error('Sign in to create a playlist.');
    const { data, error } = await this.client
      .from('playlists')
      .insert({ user_id: uid, title: title?.trim() || 'My Playlist', description, is_public: isPublic })
      .select('*')
      .single();
    if (error) fail('createPlaylist', error);
    return data;
  }

  async updatePlaylist(id, patch) {
    const { data, error } = await this.client
      .from('playlists')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) fail('updatePlaylist', error);
    return data;
  }

  async deletePlaylist(id) {
    const { error } = await this.client.from('playlists').delete().eq('id', id);
    if (error) fail('deletePlaylist', error);
    return true;
  }

  async addTrackToPlaylist(playlistId, trackId) {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id ?? null;
    // Position is auto-assigned by the `playlist_tracks_position` trigger.
    const { error } = await this.client
      .from('playlist_tracks')
      .insert({ playlist_id: playlistId, track_id: trackId, added_by: uid });
    if (error) {
      if (error.code === '23505') return { added: false, reason: 'already-present' };
      fail('addTrackToPlaylist', error);
    }
    return { added: true };
  }

  async removeTrackFromPlaylist(playlistId, trackId) {
    const { error } = await this.client
      .from('playlist_tracks')
      .delete()
      .eq('playlist_id', playlistId)
      .eq('track_id', trackId);
    if (error) fail('removeTrackFromPlaylist', error);
    return true;
  }

  /* ----------------------------------------------------------------- likes */
  async likedIds() {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    if (!uid) return [];
    const { data, error } = await this.client
      .from('liked_songs')
      .select('track_id')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) fail('likedIds', error);
    return (data || []).map((r) => r.track_id);
  }

  async likedTracks() {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    if (!uid) return [];
    const ids = await this.likedIds();
    if (!ids.length) return [];
    const { data, error } = await this.client.from('track_details').select('*').in('id', ids);
    if (error) fail('likedTracks', error);
    const byId = new Map((data || []).map((t) => [t.id, mapTrack(t)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async likeTrack(trackId, liked) {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    if (!uid) throw new Error('Sign in to save songs.');
    if (liked) {
      const { error } = await this.client
        .from('liked_songs')
        .upsert({ user_id: uid, track_id: trackId }, { onConflict: 'user_id,track_id' });
      if (error) fail('likeTrack', error);
    } else {
      const { error } = await this.client
        .from('liked_songs')
        .delete()
        .eq('user_id', uid)
        .eq('track_id', trackId);
      if (error) fail('likeTrack', error);
    }
    return this.likedIds();
  }

  /* --------------------------------------------------------------- history */
  async recordPlay(trackId) {
    // Fire-and-forget: playback must never wait on analytics.
    this.client.rpc('record_play', { p_track_id: trackId, p_source: 'app' }).then(
      ({ error }) => {
        if (error) console.warn('[supabase] record_play failed', error.message);
      },
    );
  }

  /* --------------------------------------------------------------- storage */
  /**
   * Upload a file into the user's folder. Returns the object path (store that
   * in tracks.audio_url / video_url / cover_url) plus a ready-to-use URL.
   */
  async upload(bucket, file, { onProgress } = {}) {
    const { data: session } = await this.client.auth.getSession();
    const uid = session?.session?.user?.id;
    if (!uid) throw new Error('Sign in to upload media.');
    const safeName = file.name.replace(/[^\w.-]+/g, '_');
    const path = `${uid}/${crypto.randomUUID()}-${safeName}`;
    onProgress?.(0.1);
    const { error } = await this.client.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    });
    if (error) fail('upload', error);
    onProgress?.(1);
    const { data } = this.client.storage.from(bucket).getPublicUrl(path);
    return { path, publicUrl: data.publicUrl };
  }
}

/* ============================================================================
   Factory
   ============================================================================ */
/**
 * Resolve the active repository.
 * @returns {Promise<{ repo: object, mode: 'supabase'|'demo', degraded?: boolean, reason?: string }>}
 */
export async function createRepository() {
  if (!hasSupabaseCredentials()) {
    await localProvider.init();
    return { repo: localProvider, mode: 'demo', reason: 'no-credentials' };
  }

  try {
    const client = await loadSupabaseClient();
    const repo = new SupabaseRepository(client);
    await repo.init();
    // Cheap connectivity probe so a bad URL/key falls back instead of failing
    // on the first user interaction.
    const { error } = await client.from('artists').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return { repo, mode: 'supabase' };
  } catch (err) {
    console.warn('[spotibai] Supabase unavailable, falling back to demo data:', err?.message);
    await localProvider.init();
    return {
      repo: localProvider,
      mode: 'demo',
      degraded: true,
      reason: err?.message || 'supabase-unreachable',
    };
  }
}
