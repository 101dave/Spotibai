/**
 * config.js — runtime configuration
 * ---------------------------------------------------------------------------
 * Credentials are intentionally not hard-coded in source control. Provide them
 * either by:
 *   1. Editing the defaults below, or
 *   2. The in-app "Connection settings" dialog (persisted to localStorage), or
 *   3. An optional `window.__SPOTIBAI_CONFIG__` injected by your host page.
 *
 * When no valid credentials are present the app boots into DEMO mode: a fully
 * functional local repository (js/data/localProvider.js) backed by
 * localStorage, so every screen works offline with zero setup.
 */

const STORAGE_KEY = 'spotibai:config';

const DEFAULTS = {
  // Public project endpoint/key for the connected SpotiBai Supabase project.
  // The anon key is safe to expose in browser code; row-level security protects data.
  SUPABASE_URL: 'https://ptqxzebijbnrlzjafwms.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0cXh6ZWJpamJucmx6amFmd21zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMTMzMDUsImV4cCI6MjEwODc4OTMwNX0.bD7r7Mj5JxrMn65_7IU7Z_QXOB8ndVx8-ziDd_CttHM',

  /** ESM entry point for supabase-js. Swap for a self-hosted bundle if needed. */
  SUPABASE_MODULE: 'https://esm.sh/@supabase/supabase-js@2.45.4?bundle',

  /** The TikTok account whose drops feed the video rail. */
  TIKTOK_HANDLE: 'spotibai_ph',
  TIKTOK_PROFILE: 'https://www.tiktok.com/@spotibai_ph',

  /** Where public Supabase Storage buckets live (derived automatically). */
  BUCKETS: { audio: 'audio', covers: 'covers', videos: 'videos' },

  /** How long to wait for the TikTok embed before showing the fallback card. */
  TIKTOK_EMBED_TIMEOUT_MS: 4500,

  /**
   * Mount the TikTok iframe automatically, or only after the listener taps
   * "Load TikTok player". Gated (false) is the default because it:
   *   • avoids third-party cookies/trackers until consent,
   *   • survives TikTok rate-limiting and region blocks gracefully,
   *   • keeps the poster art on screen instead of a white error frame.
   */
  TIKTOK_AUTOLOAD_EMBED: false,

  /** Simulated latency for the demo repository (keeps skeletons honest). */
  DEMO_LATENCY_MS: 140,
};

function readOverrides() {
  const fromWindow =
    typeof window !== 'undefined' && window.__SPOTIBAI_CONFIG__
      ? window.__SPOTIBAI_CONFIG__
      : {};

  let fromStorage = {};
  try {
    fromStorage = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    fromStorage = {};
  }

  return { ...fromStorage, ...fromWindow };
}

export const CONFIG = { ...DEFAULTS, ...readOverrides() };

export const SUPABASE_URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i;

/** True when both a plausible project URL and a JWT-ish anon key are present. */
export function hasSupabaseCredentials(cfg = CONFIG) {
  return (
    SUPABASE_URL_RE.test(String(cfg.SUPABASE_URL || '').replace(/\/$/, '')) &&
    typeof cfg.SUPABASE_ANON_KEY === 'string' &&
    cfg.SUPABASE_ANON_KEY.length > 60
  );
}

/** Persist credentials from the settings dialog. Pass empty strings to clear. */
export function saveSupabaseCredentials(url, anonKey) {
  const next = {
    ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}),
    SUPABASE_URL: String(url || '').trim().replace(/\/$/, ''),
    SUPABASE_ANON_KEY: String(anonKey || '').trim(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  Object.assign(CONFIG, next);
  return next;
}

/** Build a public storage URL from a bucket + object path, when configured. */
export function publicStorageUrl(bucket, path) {
  if (!path) return null;
  const raw = String(path).trim();
  if (/^(https?:|data:)/i.test(raw)) return raw;

  // The SQL seed references the bundled assets as /assets/<bucket>/<file>.
  // Resolve those known media paths to their public Supabase Storage objects.
  const seededAsset = raw.replace(/^\.\//, '').replace(/^\//, '');
  const match = seededAsset.match(/^assets\/(audio|covers|videos)\/(.+)$/i);
  const objectPath = match && match[1].toLowerCase() === bucket
    ? match[2]
    : (/^(\/|\.\/)/.test(raw) ? null : raw);

  if (!objectPath) return raw;
  return `${CONFIG.SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export const STORAGE_KEYS = {
  config: STORAGE_KEY,
  player: 'spotibai:player',
  demoDb: 'spotibai:demo-db',
  demoSession: 'spotibai:demo-session',
};
