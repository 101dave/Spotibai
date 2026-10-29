/**
 * store.js — centralised application state
 * ---------------------------------------------------------------------------
 * A ~100-line observable store. No libraries. Two rules keep it honest:
 *
 *   1. Nothing mutates `state` from the outside. Consumers call the actions in
 *      this module (or `setState`) and everyone re-renders from one snapshot.
 *   2. The store never touches the DOM. It is pure data + notification, so it
 *      can be unit tested or swapped for a different renderer.
 *
 * Nested slices (session / playback / view / library) are merged one level deep
 * so callers can write `setPlayback({ isPlaying: true })` without clobbering
 * track/progress fields.
 */

import { clamp, storage } from './utils.js';
import { STORAGE_KEYS } from './config.js';

/** @typedef {'audio'|'hybrid'|'video'} PlaybackMode */
/** @typedef {'off'|'all'|'one'} RepeatMode */

const persisted = storage.get(STORAGE_KEYS.player, {}) || {};

const initialState = {
  /** 'demo' | 'supabase' — which repository is feeding the UI */
  source: 'demo',
  ready: false,
  bootError: null,

  session: {
    user: null,       // { id, email }
    profile: null,    // { display_name, username, avatar_url }
  },

  view: { name: 'home', params: {} },

  library: {
    playlists: [],
    likedIds: new Set(),
    loading: false,
  },

  playback: {
    track: null,
    queue: [],        // array of track objects
    index: -1,
    originalQueue: [], // pre-shuffle order, restored when shuffle turns off

    isPlaying: false,
    isLoading: false,
    mode: /** @type {PlaybackMode} */ ('audio'),
    error: null,

    progress: 0,      // seconds
    duration: 0,      // seconds
    buffered: 0,      // ratio 0..1

    volume: clamp(Number(persisted.volume ?? 0.7), 0, 1),
    muted: Boolean(persisted.muted),
    shuffle: Boolean(persisted.shuffle),
    repeat: /** @type {RepeatMode} */ (persisted.repeat || 'off'),

    videoOpen: false,
    videoStatus: 'idle', // idle | loading | ready | blocked
  },
};

let state = structuredCloneSafe(initialState);

function structuredCloneSafe(obj) {
  // structuredClone cannot carry Sets in every runtime we target; do it by hand.
  const copy = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Set) copy[k] = new Set(v);
    else if (v && typeof v === 'object') copy[k] = structuredCloneSafe(v);
    else copy[k] = v;
  }
  return copy;
}

const listeners = new Set();

/** Subscribe to every state change. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() {
  return state;
}

let notifyScheduled = false;

/**
 * Merge a patch into state and notify subscribers (batched to a microtask so a
 * burst of updates in one handler produces a single render pass).
 */
export function setState(patch) {
  const next = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Set) &&
      next[key] &&
      typeof next[key] === 'object' &&
      !Array.isArray(next[key]) &&
      !(next[key] instanceof Set)
    ) {
      next[key] = { ...next[key], ...value };
    } else {
      next[key] = value;
    }
  }
  state = next;
  scheduleNotify();
}

function scheduleNotify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.error('[store] subscriber failed', err);
      }
    });
  });
}

/* ===========================================================================
   Slice helpers — used by the engine and views
   =========================================================================== */

export const setPlayback = (patch) => setState({ playback: patch });

export const setView = (name, params = {}) => setState({ view: { name, params } });

export function setSession(user, profile = null) {
  setState({ session: { user, profile } });
}

export function setLibrary(patch) {
  setState({ library: patch });
}

/* ---------------- player preferences (persisted) -------------------------- */
let persistTimer = null;
function persistPlayerPrefs() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { volume, muted, shuffle, repeat } = state.playback;
    storage.set(STORAGE_KEYS.player, { volume, muted, shuffle, repeat });
  }, 200);
}

export function setVolume(volume) {
  const v = clamp(Number(volume) || 0, 0, 1);
  setPlayback({ volume: v, muted: v === 0 ? state.playback.muted : false });
  persistPlayerPrefs();
  return v;
}

export function toggleMute() {
  setPlayback({ muted: !state.playback.muted });
  persistPlayerPrefs();
  return state.playback.muted;
}

export function toggleShuffle() {
  setPlayback({ shuffle: !state.playback.shuffle });
  persistPlayerPrefs();
  return state.playback.shuffle;
}

export function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  const nextMode = order[(order.indexOf(state.playback.repeat) + 1) % order.length];
  setPlayback({ repeat: nextMode });
  persistPlayerPrefs();
  return nextMode;
}

/* ---------------- queue --------------------------------------------------- */

/**
 * Load a new queue and select an index.
 * @param {Array} tracks
 * @param {number} index
 */
export function setQueue(tracks, index = 0) {
  const queue = tracks.slice();
  const originalQueue = queue.slice();
  const startIndex = clamp(index, 0, Math.max(queue.length - 1, 0));
  setPlayback({
    queue,
    originalQueue,
    index: startIndex,
    track: queue[startIndex] || null,
  });
  return queue[startIndex] || null;
}

/** Insert `tracks` after the current position ("Add to queue"). */
export function enqueue(tracks) {
  const list = Array.isArray(tracks) ? tracks : [tracks];
  const pb = state.playback;
  const insertAt = pb.index >= 0 ? pb.index + 1 : pb.queue.length;
  const queue = [...pb.queue];
  queue.splice(insertAt, 0, ...list);
  setPlayback({
    queue,
    originalQueue: [...pb.originalQueue, ...list],
    track: pb.track || list[0] || null,
    index: pb.track ? pb.index : insertAt,
  });
}

/** Apply shuffle order without moving the currently playing track. */
export function applyShuffle(shuffleOn) {
  const pb = state.playback;
  const current = pb.track;
  let queue;

  if (shuffleOn) {
    const rest = pb.queue.filter((t) => t.id !== current?.id);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue = current ? [current, ...rest] : rest;
  } else {
    queue = pb.originalQueue.length ? pb.originalQueue.slice() : pb.queue.slice();
  }

  const index = Math.max(0, queue.findIndex((t) => t.id === current?.id));
  setPlayback({ queue, index });
}

/* ------------------- derived selectors ------------------------------------ */
export const selectCurrentTrack = () => state.playback.track;
export const selectIsPlaying = () => state.playback.isPlaying;
export const selectIsLiked = (trackId) => state.library.likedIds.has(trackId);
export const selectIsSignedIn = () => Boolean(state.session.user);

/** Test hook: reset to a clean slate (used by the debug panel / tests). */
export function __resetStore() {
  state = structuredCloneSafe(initialState);
  scheduleNotify();
}
