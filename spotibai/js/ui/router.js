/**
 * router.js — hash-based SPA router
 * ---------------------------------------------------------------------------
 * Routes are plain hashes, so the app runs from any static host (or file://)
 * with no server rewrite rules:
 *
 *   #/home                     Home dashboard
 *   #/search?q=bisaya          Search (query in the hash so it is shareable)
 *   #/library                  Your Library
 *   #/liked                    Liked Songs
 *   #/album/:id                Album detail
 *   #/playlist/:id             Playlist detail
 *   #/artist/:id               Artist detail
 *   #/track/:id                Deep link that auto-plays a track
 *
 * The router reports the parsed route; app.js decides what to render. Keeping
 * navigation out of the view layer means views stay pure functions.
 */

export const ROUTES = [
  { name: 'home', pattern: /^\/home\/?$/ },
  { name: 'search', pattern: /^\/search\/?$/ },
  { name: 'library', pattern: /^\/library\/?$/ },
  { name: 'liked', pattern: /^\/liked\/?$/ },
  { name: 'album', pattern: /^\/album\/([\w-]+)\/?$/ },
  { name: 'playlist', pattern: /^\/playlist\/([\w-]+)\/?$/ },
  { name: 'artist', pattern: /^\/artist\/([\w-]+)\/?$/ },
  { name: 'track', pattern: /^\/track\/([\w-]+)\/?$/ },
];

/**
 * Parse a location.hash into a route descriptor.
 * @param {string} hash
 * @returns {{name:string, id?:string, query?:string, raw:string}}
 */
export function parseRoute(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/home';
  const [path, search = ''] = raw.split('?');
  const query = new URLSearchParams(search).get('q') || '';

  for (const route of ROUTES) {
    const match = path.match(route.pattern);
    if (match) {
      return { name: route.name, id: match[1] || null, query, raw };
    }
  }
  return { name: 'notfound', id: null, query, raw };
}

/** Public navigation helper. */
export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? '' : '/'}${path}`;
  if (replace) {
    const url = `${location.pathname}${location.search}${target}`;
    history.replaceState({ ...history.state, spotibai: true }, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

/** Subscribe to route changes. Returns an unsubscribe function. */
export function onRouteChange(handler) {
  const listener = () => handler(parseRoute());
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** Update the hash without pushing history (used by live search). */
export function replaceQuery(query) {
  const next = `#/search?q=${encodeURIComponent(query)}`;
  const url = `${location.pathname}${next}`;
  history.replaceState({ ...history.state, spotibai: true }, '', url);
}

export const hrefFor = {
  home: () => '#/home',
  search: (q = '') => (q ? `#/search?q=${encodeURIComponent(q)}` : '#/search'),
  album: (id) => `#/album/${id}`,
  playlist: (id) => `#/playlist/${id}`,
  artist: (id) => `#/artist/${id}`,
  liked: () => '#/liked',
  library: () => '#/library',
};
