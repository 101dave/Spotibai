/** Resolve bundled media independently of the page's deployment directory. */
const bundledCovers = new Set([
  'artist-baij.svg', 'artist-rene.svg', 'artist-lucky.svg', 'artist-spotibai.svg',
  'album-bisaya-sunrise.svg', 'album-fyp-vol1.svg', 'album-hugot-sessions.svg',
  'album-tangalog-nights.svg', 'playlist-tangalog-heat.svg',
  'tiktok-coron-song.svg', 'tiktok-malupit-na-bai.svg',
]);

export function localAssetUrl(bucket, path) {
  if (!path) return null;
  const raw = String(path).trim();
  // Older catalog rows may contain public Storage URLs rather than seed paths.
  // Only substitute known demo covers; uploaded/custom artwork stays remote.
  if (/^https?:/i.test(raw)) {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/storage\/v1\/object\/public\/covers\/([^/]+)$/);
    if (bucket === 'covers' && match && bundledCovers.has(match[1])) {
      return new URL(`../assets/covers/${match[1]}`, import.meta.url).href;
    }
    return raw;
  }
  if (/^data:/i.test(raw)) return raw;
  const match = raw.match(/(?:^|\/)assets\/(audio|covers|videos)\/(.+)$/i);
  if (match && match[1].toLowerCase() === bucket) {
    return new URL(`../assets/${bucket}/${match[2]}`, import.meta.url).href;
  }
  if (bucket === 'covers' && bundledCovers.has(raw)) {
    return new URL(`../assets/covers/${raw}`, import.meta.url).href;
  }
  return raw;
}
