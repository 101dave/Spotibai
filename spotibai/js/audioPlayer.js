/**
 * audioPlayer.js — the DUAL MEDIA ENGINE + playback controller
 * ---------------------------------------------------------------------------
 * Two collaborating classes:
 *
 *  ┌─ MediaEngine ──────────────────────────────────────────────────────────┐
 *  │ Owns exactly one HTMLAudioElement and, on demand, one <video> element  │
 *  │ or a TikTok <iframe>. It knows how to load/play/pause/seek/volume for  │
 *  │ whichever element is currently authoritative, and normalises their     │
 *  │ events into a single onTime / onState channel.                        │
 *  └───────────────────────────────────────────────────────────────────────┘
 *  ┌─ PlaybackController ───────────────────────────────────────────────────┐
 *  │ Owns the queue, shuffle, repeat and likes. It decides *what* plays     │
 *  │ next, mutates the store, and asks the engine to perform the I/O.       │
 *  └───────────────────────────────────────────────────────────────────────┘
 *
 * MEDIA MODES
 * -----------
 *   audio   — plain MP3/WAV via HTMLAudioElement. Timeline is the audio clock.
 *   video   — a direct video file (mp4/webm, e.g. from the `videos` bucket).
 *             The <video> element becomes the authoritative clock AND audio.
 *   hybrid  — a TikTok post (@spotibai_ph). The official TikTok player is a
 *             cross-origin iframe and cannot be controlled programmatically.
 *             It stays embedded in the app and is loaded only after an explicit
 *             user action. We do not play a generated audio substitute, so the
 *             sound matches the original post.
 */

import {
  clamp,
  ratio,
  tiktokEmbedUrl,
  parseTikTokId,
  throttle,
  shuffleArray,
} from './utils.js';
import { CONFIG } from './config.js';
import {
  getState,
  setPlayback,
  setQueue as storeSetQueue,
  applyShuffle,
} from './store.js';

/** Where the video panel mounts its embed in the DOM. */
const VIDEO_HOST_ID = 'videoMount';

export class MediaEngine {
  /**
   * @param {object} opts
   * @param {HTMLAudioElement} opts.audioEl
   * @param {object} opts.hooks
   * @param {(s:{progress:number,duration:number,buffered:number})=>void} opts.hooks.onTime
   * @param {(playing:boolean)=>void} opts.hooks.onPlayState
   * @param {()=>void} opts.hooks.onEnded
   * @param {(msg:string)=>void} opts.hooks.onError
   * @param {(mode:'audio'|'video'|'hybrid')=>void} opts.hooks.onMode
   * @param {(status:string)=>void} opts.hooks.onVideoStatus
   */
  constructor({ audioEl, hooks = {} }) {
    this.audio = audioEl;
    this.hooks = hooks;

    this.track = null;
    /** @type {'audio'|'video'|'hybrid'} */
    this.mode = 'audio';
    this.videoEl = null;
    this.iframeEl = null;
    this.videoHost = null;
    this.posterEl = null;
    this.fallbackEl = null;
    this._embedTimer = null;
    this._hostInteractHandler = null;
    /** Set once the listener opts into loading embeds for this session. */
    this._embedConsent = false;

    this._bindAudio();
  }

  /* ------------------------------------------------------------- internal */

  _bindAudio() {
    const a = this.audio;
    a.preload = 'metadata';

    const emitTime = throttle(() => {
      if (this.mode === 'video' && this.videoEl) return; // video is the clock
      this._emitTime(a.currentTime, a.duration);
    }, 100);

    a.addEventListener('timeupdate', emitTime);
    a.addEventListener('durationchange', () => this._emitTime(a.currentTime, a.duration));
    a.addEventListener('progress', () => this._emitBuffered());
    a.addEventListener('loadedmetadata', () => this._emitTime(a.currentTime, a.duration));
    a.addEventListener('play', () => this.hooks.onPlayState?.(true));
    a.addEventListener('pause', () => this.hooks.onPlayState?.(false));
    a.addEventListener('ended', () => this.hooks.onEnded?.());
    a.addEventListener('waiting', () => this.hooks.onPlayState?.(false));
    a.addEventListener('error', () => {
      if (!this.track) return;
      // A missing audio bed is expected for video-only TikTok rows.
      if (this.mode === 'hybrid' || this.mode === 'video') return;
      this.hooks.onError?.('This track’s audio could not be loaded.');
    });
  }

  _emitTime(current, duration) {
    const dur = Number.isFinite(duration) && duration > 0 ? duration : this.track?.duration_seconds || 0;
    this.hooks.onTime?.({
      progress: Number(current) || 0,
      duration: dur,
      buffered: this.audio.buffered.length
        ? ratio(this.audio.buffered.end(this.audio.buffered.length - 1), dur)
        : 0,
    });
  }

  _emitBuffered() {
    const duration = this.duration;
    if (this.audio.buffered.length && duration) {
      this.hooks.onTime?.({
        progress: this.audio.currentTime,
        duration,
        buffered: ratio(this.audio.buffered.end(this.audio.buffered.length - 1), duration),
      });
    }
  }

  /** Classify a track's media sources. */
  static resolveMode(track) {
    if (!track) return 'audio';
    const url = track.video_url || '';
    const isDirectVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
    if (isDirectVideo) return 'video';
    if (track.is_tiktok_source) return 'hybrid';
    return 'audio';
  }

  get activeElement() {
    if (this.mode === 'video' && this.videoEl) return this.videoEl;
    return this.audio;
  }

  get videoId() {
    return this.track?.tiktok_video_id || parseTikTokId(this.track?.video_url);
  }

  /* ---------------------------------------------------------------- public */

  /**
   * Load a track. Does not autoplay unless asked.
   * @param {object} track
   * @param {{autoplay?: boolean, startAt?: number}} [opts]
   */
  async load(track, { autoplay = true, startAt = 0 } = {}) {
    if (!track) return;
    this.track = track;
    this.mode = MediaEngine.resolveMode(track);
    this.hooks.onMode?.(this.mode);

    // ---------------- audio bed -----------------------------------------
    this.audio.pause();
    if (track.audio_url) {
      if (this.audio.src !== new URL(track.audio_url, location.href).href) {
        this.audio.src = track.audio_url;
        this.audio.load();
      }
      this.audio.currentTime = startAt;
    } else {
      this.audio.removeAttribute('src');
    }

    // ---------------- video element / embed -----------------------------
    this._teardownVideo();
    if (this.mode === 'video') this._mountNativeVideo(track, startAt);
    if (this.mode === 'hybrid') this._mountTikTokEmbed(track);

    this._emitTime(startAt, track.duration_seconds || 0);
    if (autoplay) await this.play();
  }

  async play() {
    if (!this.track) return;
    try {
      if (this.mode === 'video' && this.videoEl) {
        // Video owns both picture and sound.
        this.audio.pause();
        await this.videoEl.play();
      } else if (this.audio.src) {
        await this.audio.play();
      } else if (this.mode === 'hybrid') {
        // Never substitute a demo audio bed for a TikTok post's original sound.
        // The listener loads and controls the official embed in the in-app panel.
        this.hooks.onPlayState?.(false);
        return;
      }
      this.hooks.onPlayState?.(true);
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        // Autoplay policy: needs a user gesture. State stays paused.
        this.hooks.onPlayState?.(false);
        return;
      }
      this.hooks.onError?.('Playback failed. The media file may be unavailable.');
      this.hooks.onPlayState?.(false);
    }
  }

  pause() {
    this.audio.pause();
    if (this.videoEl) this.videoEl.pause();
    this.hooks.onPlayState?.(false);
  }

  async toggle() {
    if (!this.track) return;
    const playing =
      this.mode === 'video' && this.videoEl ? !this.videoEl.paused : !this.audio.paused;
    if (playing) this.pause();
    else await this.play();
  }

  /** Seek to an absolute position in seconds. */
  seek(seconds) {
    if (!this.track) return 0;
    const target = clamp(Number(seconds) || 0, 0, this.duration || this.track.duration_seconds || 0);
    if (this.mode === 'video' && this.videoEl && Number.isFinite(this.videoEl.duration)) {
      this.videoEl.currentTime = Math.min(target, this.videoEl.duration);
    } else if (this.audio.src) {
      this.audio.currentTime = target;
    }
    this.hooks.onTime?.({
      progress: target,
      duration: this.duration || this.track.duration_seconds || 0,
      buffered: 0,
    });
    return target;
  }

  /** Seek by ratio (0..1) — what the scrubber actually calls. */
  seekRatio(r) {
    const duration = this.duration || this.track?.duration_seconds || 0;
    return this.seek(ratio(r, 1) * duration);
  }

  seekBy(delta) {
    return this.seek((this.currentTime || 0) + delta);
  }

  setVolume(volume) {
    const v = clamp(Number(volume) || 0, 0, 1);
    this.audio.volume = v;
    if (this.videoEl) this.videoEl.volume = v;
    return v;
  }

  setMuted(muted) {
    this.audio.muted = Boolean(muted);
    if (this.videoEl) this.videoEl.muted = Boolean(muted);
    return Boolean(muted);
  }

  get currentTime() {
    if (this.mode === 'video' && this.videoEl && Number.isFinite(this.videoEl.currentTime)) {
      return this.videoEl.currentTime;
    }
    return this.audio.currentTime || 0;
  }

  get duration() {
    if (this.mode === 'video' && this.videoEl && Number.isFinite(this.videoEl.duration)) {
      return this.videoEl.duration;
    }
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration;
    return this.track?.duration_seconds || 0;
  }

  /* --------------------------------------------------------- video mounting */

  _mountNativeVideo(track, startAt) {
    const host = document.getElementById(VIDEO_HOST_ID);
    if (!host) return;
    const video = document.createElement('video');
    video.src = track.video_url;
    video.playsInline = true;
    video.preload = 'metadata';
    video.controls = false;
    video.loop = false;
    video.volume = this.audio.volume;
    video.muted = this.audio.muted;
    if (startAt) video.currentTime = startAt;

    video.addEventListener('loadedmetadata', () => {
      this.hooks.onTime?.({
        progress: video.currentTime,
        duration: video.duration,
        buffered: 0,
      });
    });
    video.addEventListener('timeupdate', () => {
      this.hooks.onTime?.({
        progress: video.currentTime,
        duration: video.duration,
        buffered: video.buffered.length
          ? ratio(video.buffered.end(video.buffered.length - 1), video.duration)
          : 0,
      });
    });
    video.addEventListener('play', () => this.hooks.onPlayState?.(true));
    video.addEventListener('pause', () => this.hooks.onPlayState?.(false));
    video.addEventListener('ended', () => this.hooks.onEnded?.());

    host.replaceChildren(video);
    this.videoEl = video;
    this.videoHost = host;
    this.hooks.onVideoStatus?.('ready');
  }

  /**
   * Mount the TikTok embed now (called automatically when CONFIG.TIKTOK_AUTOLOAD_EMBED
   * is true, or from the "Load TikTok player" button).
   */
  loadTikTokEmbed({ persistConsent = true } = {}) {
    if (persistConsent) this._embedConsent = true;
    if (this.mode !== 'hybrid' || !this.track) return;
    this._mountTikTokEmbed(this.track);
  }

  _mountTikTokEmbed(track) {
    const host = document.getElementById(VIDEO_HOST_ID);
    if (!host) return;
    const id = this.videoId;
    if (!id) {
      this.hooks.onVideoStatus?.('blocked');
      return;
    }

    // Consent gate: show the poster + a button rather than a third-party frame.
    if (!this._embedConsent && !CONFIG.TIKTOK_AUTOLOAD_EMBED) {
      host.replaceChildren();
      this.hooks.onVideoStatus?.('gate');
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = tiktokEmbedUrl(id);
    iframe.title = `TikTok video by @${track.tiktok_author || CONFIG.TIKTOK_HANDLE}`;
    iframe.allow = 'encrypted-media; fullscreen; picture-in-picture; clipboard-write';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.loading = 'lazy';

    // Cross-origin iframes swallow clicks; record that the listener is
    // controlling the official TikTok player rather than local audio.
    const onInteract = () => {
      if (this.mode !== 'hybrid') return;
      this.audio.pause();
      this.hooks.onPlayState?.(false);
      this.hooks.onVideoStatus?.('manual');
    };
    host.replaceChildren(iframe);
    if (this._hostInteractHandler) {
      host.removeEventListener('pointerdown', this._hostInteractHandler);
    }
    this._hostInteractHandler = onInteract;
    host.addEventListener('pointerdown', onInteract);

    this.iframeEl = iframe;
    this.videoHost = host;
    this.hooks.onVideoStatus?.('loading');

    // The iframe's `load` event fires even for error pages, and never fires at
    // all when the embed is network-blocked. A timeout is the only reliable
    // signal we have in a sandboxed/offline environment.
    clearTimeout(this._embedTimer);
    let loaded = false;
    iframe.addEventListener('load', () => {
      loaded = true;
      clearTimeout(this._embedTimer);
      this.hooks.onVideoStatus?.('ready');
    });
    // Slow load is not the same as blocked: only claim "blocked" when we are
    // demonstrably offline, otherwise show a softer "still loading" state that
    // resolves itself the moment the embed completes.
    this._embedTimer = setTimeout(() => {
      if (loaded) return;
      this.hooks.onVideoStatus?.(navigator.onLine === false ? 'blocked' : 'slow');
    }, CONFIG.TIKTOK_EMBED_TIMEOUT_MS);
  }

  _teardownVideo() {
    clearTimeout(this._embedTimer);
    if (this.videoHost && this._hostInteractHandler) {
      this.videoHost.removeEventListener('pointerdown', this._hostInteractHandler);
      this._hostInteractHandler = null;
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load?.();
      this.videoEl = null;
    }
    if (this.iframeEl) {
      this.iframeEl.removeAttribute('src');
      this.iframeEl = null;
    }
    const host = document.getElementById(VIDEO_HOST_ID);
    if (host) host.replaceChildren();
    this.hooks.onVideoStatus?.('idle');
  }

  destroy() {
    this._teardownVideo();
    this.audio.pause();
    this.audio.removeAttribute('src');
  }
}

/* ============================================================================
   PlaybackController
   ============================================================================ */
export class PlaybackController {
  /**
   * @param {MediaEngine} engine
   * @param {object} deps
   * @param {object} deps.repo
   * @param {(msg:string,type?:string)=>void} deps.toast
   * @param {(ids:string[])=>void} deps.onLikesChanged
   */
  constructor(engine, { repo, toast, onLikesChanged } = {}) {
    this.engine = engine;
    this.repo = repo;
    this.toast = toast || (() => {});
    this.onLikesChanged = onLikesChanged || (() => {});
  }

  /* --------------------------------------------------------- queue control */

  /**
   * Replace the queue and start playing at `index`.
   * @param {object[]} tracks
   * @param {number} index
   * @param {{context?: string}} [opts]
   */
  async playQueue(tracks, index = 0, { context = 'app' } = {}) {
    if (!tracks?.length) return;
    const pb = getState().playback;

    if (pb.shuffle) {
      const current = tracks[index];
      const rest = tracks.filter((t) => t.id !== current?.id);
      const shuffled = shuffleArray(rest);
      const queue = current ? [current, ...shuffled] : shuffled;
      storeSetQueue(queue, 0);
      applyShuffle(true);
      await this._start(0, context);
    } else {
      storeSetQueue(tracks, index);
      await this._start(index, context);
    }
  }

  /** Play a single track; keeps the current queue if it already contains it. */
  async playTrack(track, { queue, context = 'app' } = {}) {
    if (!track) return;
    const pb = getState().playback;
    const idx = queue ? queue.findIndex((t) => t.id === track.id) : -1;
    if (queue && idx >= 0) return this.playQueue(queue, idx, { context });

    const existing = pb.queue.findIndex((t) => t.id === track.id);
    if (existing >= 0) {
      setPlayback({ index: existing, track });
      return this._start(existing, context);
    }

    const nextQueue = [...pb.queue, track];
    setPlayback({ queue: nextQueue, originalQueue: [...pb.originalQueue, track] });
    return this.playQueue(nextQueue, nextQueue.length - 1, { context });
  }

  async _start(index) {
    const pb = getState().playback;
    const track = pb.queue[index];
    if (!track) return;

    setPlayback({
      index,
      track,
      isLoading: true,
      error: null,
      // Keep listeners in SpotiBai; show TikTok's player inline, never navigate away.
      videoOpen: track.is_tiktok_source ? true : pb.videoOpen,
      videoStatus: track.is_tiktok_source ? 'loading' : 'idle',
    });

    await this.engine.load(track, { autoplay: true });
    setPlayback({ isLoading: false });

    // Fire-and-forget history + play-count bump.
    try {
      await this.repo.recordPlay?.(track.id);
    } catch {
      /* analytics must never break playback */
    }
  }

  toggle() {
    return this.engine.toggle();
  }

  play() {
    return this.engine.play();
  }

  pause() {
    this.engine.pause();
  }

  /** Advance the queue. `auto` = triggered by track end (respects repeat). */
  async next({ auto = false } = {}) {
    const pb = getState().playback;
    if (!pb.queue.length) return;

    if (auto && pb.repeat === 'one') {
      this.engine.seek(0);
      await this.engine.play();
      return;
    }

    let nextIndex = pb.index + 1;
    if (nextIndex >= pb.queue.length) {
      if (pb.repeat === 'all' || (auto && pb.shuffle)) nextIndex = 0;
      else if (auto) {
        // End of queue: stop cleanly, keep the last track visible.
        this.engine.pause();
        setPlayback({ isPlaying: false, progress: 0 });
        this.engine.seek(0);
        return;
      } else nextIndex = 0;
    }

    await this._start(nextIndex);
  }

  async prev() {
    const pb = getState().playback;
    // Spotify behaviour: restart the track if we're more than 3s in.
    if (this.engine.currentTime > 3) {
      this.engine.seek(0);
      return;
    }
    const prevIndex = pb.index - 1 < 0 ? pb.queue.length - 1 : pb.index - 1;
    if (!pb.queue.length) return;
    await this._start(prevIndex);
  }

  seekRatio(r) {
    this.engine.seekRatio(r);
  }

  seekBy(delta) {
    this.engine.seekBy(delta);
  }

  /* -------------------------------------------------------------- toggles */

  toggleShuffle() {
    const pb = getState().playback;
    const nextShuffle = !pb.shuffle;
    setPlayback({ shuffle: nextShuffle });
    applyShuffle(nextShuffle);
    this.toast(nextShuffle ? 'Shuffle on' : 'Shuffle off');
    return nextShuffle;
  }

  cycleRepeat() {
    const order = ['off', 'all', 'one'];
    const current = getState().playback.repeat;
    const nextMode = order[(order.indexOf(current) + 1) % order.length];
    setPlayback({ repeat: nextMode });
    this.toast(
      nextMode === 'off' ? 'Repeat off' : nextMode === 'all' ? 'Repeat queue' : 'Repeat track',
    );
    return nextMode;
  }

  setVolume(v) {
    this.engine.setVolume(v);
    setPlayback({ volume: v, muted: v === 0 ? true : false });
    return v;
  }

  toggleMute() {
    const nextMuted = !getState().playback.muted;
    this.engine.setMuted(nextMuted);
    setPlayback({ muted: nextMuted });
    return nextMuted;
  }

  /* ---------------------------------------------------------------- likes */

  async toggleLike(trackId) {
    const state = getState();
    const isLiked = state.library.likedIds.has(trackId);
    // Optimistic update — the UI should never wait on the network for a heart.
    const next = new Set(state.library.likedIds);
    if (isLiked) next.delete(trackId);
    else next.add(trackId);
    this.onLikesChanged([...next], { optimistic: true });

    try {
      const ids = await this.repo.likeTrack(trackId, !isLiked);
      this.onLikesChanged(ids || [...next]);
      this.toast(isLiked ? 'Removed from Liked Songs' : 'Added to Liked Songs');
    } catch (err) {
      this.onLikesChanged([...state.library.likedIds]); // revert
      this.toast(err.message || 'Could not update Liked Songs', 'error');
    }
    return !isLiked;
  }
}
