/**
 * utils.js — tiny, dependency-free helpers shared across modules.
 * Deliberately no framework: DOM string templates + explicit escaping.
 */

/* ------------------------------------------------------------------ DOM --- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape untrusted strings before interpolating into innerHTML templates. */
export function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline sprite reference. Every icon in the app funnels through this. */
export function icon(name, size = 16, cls = '') {
  return `<svg class="${cls}" width="${size}" height="${size}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/* --------------------------------------------------------------- number --- */
export const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** 0:00 / 3:45 — mm:ss with an hours segment when needed. */
export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 1.2K / 3.4M — engagement counters, TikTok style. */
export function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
}

/** "2 days ago" / "8-26" style relative label. */
export function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "5 tracks · 12 min" total-duration summary for heroes. */
export function summarizeTracks(tracks = []) {
  const total = tracks.reduce((sum, t) => sum + (Number(t.duration_seconds) || 0), 0);
  const mins = Math.round(total / 60);
  const count = tracks.length;
  return `${count} ${count === 1 ? 'track' : 'tracks'} · ${mins} min`;
}

/* -------------------------------------------------------------- strings --- */
export function initials(name = '') {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase() || 'SB'
  );
}

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/* --------------------------------------------------------------- timing --- */
export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 60) {
  let last = 0;
  let queued = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(queued);
      queued = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, wait - (now - last));
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- math ---- */
export const ratio = (value, total) => {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return clamp((Number(value) || 0) / t, 0, 1);
};

/* -------------------------------------------------------------- arrays ---- */
export function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* --------------------------------------------------------------- events --- */
/** Delegated listener helper: on(root, 'click', '[data-action]', handler). */
export function on(root, type, selector, handler, opts = {}) {
  const listener = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, opts);
  return () => root.removeEventListener(type, listener, opts);
}

/* ------------------------------------------------------------ tiktok ----- */
/** Extract the numeric aweme id from any TikTok share/embed URL. */
export function parseTikTokId(url) {
  if (!url) return null;
  const m = String(url).match(/\/(?:video|photo)\/(\d{6,25})/);
  return m ? m[1] : null;
}

/** Hashtags the caption declares, used when the API did not provide a list. */
export function extractHashtags(caption = '') {
  return Array.from(String(caption).matchAll(/#([^\s#]+)/g)).map((m) => m[1]);
}

/** Canonical TikTok embed endpoint (no SDK required). */
export const tiktokEmbedUrl = (videoId) =>
  `https://www.tiktok.com/embed/v2/${videoId}?lang=en&referrer=spotibai`;

/* ---------------------------------------------------------------- misc ---- */
export const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

/** localStorage JSON helpers that never throw (private mode, quota, etc.). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};
