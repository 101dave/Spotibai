/**
 * components.js — pure HTML string builders (no side effects, no DOM reads).
 *
 * Everything here is a pure function of its arguments, which keeps the views
 * declarative and makes re-rendering trivially safe: build a string, swap it in.
 * All untrusted values pass through `esc()`.
 */

import { esc, icon, fmtTime, fmtCount, fmtRelative, summarizeTracks } from '../utils.js';

/* ------------------------------------------------------------------ cards */

/**
 * Generic media card (album / playlist / artist / track).
 * @param {object} opts
 */
export function mediaCard({
  href = '',
  title,
  meta = '',
  art,
  round = false,
  badge = '',
  stats = '',
  playCollection = '',
  playLabel = 'Play',
  tiktok = false,
  extraClass = '',
}) {
  return `
    <article class="card${round ? ' card--round' : ''}${tiktok ? ' card--tiktok' : ''} ${extraClass}"
             ${href ? `data-action="navigate" data-href="${esc(href)}" tabindex="0" role="link"` : ''}>
      <div class="card__art">
        ${art ? `<img src="${esc(art)}" alt="" loading="lazy" decoding="async" />` : ''}
        ${badge ? `<span class="card__badge badge ${badge.class}">${badge.label}</span>` : ''}
        ${
          playCollection
            ? `<button class="play-fab card__fab" type="button"
                       data-action="play-collection" data-collection="${esc(playCollection)}"
                       aria-label="${esc(playLabel)}">${icon('play', 20)}</button>`
            : ''
        }
      </div>
      <div class="card__body">
        <span class="card__title">${esc(title)}</span>
        ${meta ? `<span class="card__meta">${esc(meta)}</span>` : ''}
        ${stats}
      </div>
    </article>`;
}

export function albumCard(album) {
  return mediaCard({
    href: `#/album/${album.id}`,
    title: album.title,
    meta: `${album.release_year || ''}${album.release_year && album.artist_name ? ' · ' : ''}${album.artist_name || ''}`,
    art: album.cover_url,
    playCollection: `album:${album.id}`,
    playLabel: `Play ${album.title}`,
  });
}

export function artistCard(artist) {
  return mediaCard({
    href: `#/artist/${artist.id}`,
    title: artist.name,
    meta: artist.track_count ? `${artist.track_count} tracks` : 'Artist',
    art: artist.image_url,
    round: true,
  });
}

export function playlistCard(playlist) {
  return mediaCard({
    href: `#/playlist/${playlist.id}`,
    title: playlist.title,
    meta: `${playlist.track_count ?? 0} tracks${playlist.is_public ? ' · Public' : ''}`,
    art: playlist.cover_url,
    playCollection: `playlist:${playlist.id}`,
  });
}

/** 9:16 TikTok-sourced card with real engagement counts. */
export function tiktokCard(track) {
  const stats = `
    <span class="card__stats">
      <span class="card__stat">${icon('heart', 12)} ${fmtCount(track.tiktok_like_count)}</span>
      <span class="card__stat">${icon('comment', 12)} ${fmtCount(track.tiktok_comment_count)}</span>
      <span class="card__stat">${icon('share', 12)} ${fmtCount(track.tiktok_share_count)}</span>
    </span>`;

  return mediaCard({
    href: `#/track/${track.id}`,
    title: track.title,
    meta: `@${track.tiktok_author || 'spotibai_ph'} · ${fmtRelative(track.tiktok_posted_at) || 'new drop'}`,
    art: track.thumbnail_url || track.cover_url,
    badge: { class: 'badge--tiktok', label: 'TikTok' },
    stats,
    tiktok: true,
    playCollection: `tiktok:${track.id}`,
  });
}

/* ---------------------------------------------------------------- shelves */

export function shelf({ title, iconName = '', moreHref = '', moreLabel = 'Show all', body }) {
  return `
    <section class="shelf">
      <div class="shelf__head">
        <h2 class="shelf__title">${iconName ? icon(iconName, 18) : ''}${esc(title)}</h2>
        ${moreHref ? `<a class="shelf__more" href="${esc(moreHref)}">${esc(moreLabel)}</a>` : ''}
      </div>
      ${body}
    </section>`;
}

export const cardGrid = (html, extra = '') =>
  `<div class="card-grid ${extra}">${html}</div>`;

/* ------------------------------------------------------------- track list */

/**
 * A single track row. Rows are buttons for pointer/keyboard parity, but keep
 * table-like semantics via role="row"/gridcell.
 */
export function trackRow({
  track,
  index,
  collection,
  isActive = false,
  isPlaying = false,
  liked = false,
  showAlbum = true,
  showDate = false,
  showCover = true,
  removeAction = false,
  position,
}) {
  const active = isActive;
  const marker = active
    ? `<span class="eq ${isPlaying ? '' : 'is-paused'}" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`
    : `<span class="track-row__index-num">${position ?? index + 1}</span>`;

  return `
    <div class="track-row ${active ? 'is-active' : ''}"
         role="row"
         tabindex="0"
         data-action="play-row"
         data-track-id="${esc(track.id)}"
         data-collection="${esc(collection)}">
      <div class="track-row__index" aria-hidden="true">
        ${marker}
        <span class="track-row__play">${icon('play', 15)}</span>
      </div>

      <div class="track-row__main" role="gridcell">
        ${
          showCover
            ? `<img class="track-row__art" src="${esc(track.cover_url || '')}" alt="" loading="lazy" decoding="async" />`
            : ''
        }
        <div class="track-row__text">
          <span class="track-row__title" title="${esc(track.title)}">${esc(track.title)}</span>
          <span class="track-row__artist">
            ${
              track.is_tiktok_source
                ? `<span class="badge badge--tiktok" style="font-size:9px;padding:1px 5px">TikTok</span>`
                : ''
            }
            <span class="truncate">${esc(track.artist_name || 'Unknown artist')}</span>
          </span>
        </div>
      </div>

      <span class="track-row__album truncate" role="gridcell">
        ${esc(showAlbum ? track.album_title || '—' : '')}
      </span>

      <span class="track-row__date" role="gridcell">
        ${esc(showDate ? fmtRelative(track.tiktok_posted_at || track.created_at) : '')}
      </span>

      <div class="track-row__actions">
        <button class="icon-btn track-row__like ${liked ? 'is-liked' : ''}" type="button"
                data-action="like-track" data-track-id="${esc(track.id)}"
                aria-label="${liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}"
                aria-pressed="${liked}">
          ${icon('heart', 15)}
        </button>
        <button class="icon-btn" type="button" data-action="add-to-playlist"
                data-track-id="${esc(track.id)}" aria-label="Add to playlist">
          ${icon('plus', 15)}
        </button>
        ${
          removeAction
            ? `<button class="icon-btn" type="button" data-action="remove-from-playlist"
                       data-track-id="${esc(track.id)}" aria-label="Remove from this playlist">
                 ${icon('trash', 15)}
               </button>`
            : ''
        }
      </div>

      <span class="track-row__dur" role="gridcell">${fmtTime(track.duration_seconds)}</span>
    </div>`;
}

/**
 * Full track list with sticky-ish header row.
 * @param {object} opts
 * @param {Array} opts.tracks
 * @param {string} opts.collection  registry key used to resolve the queue
 */
export function trackList({
  tracks = [],
  collection,
  playback,
  likedIds,
  showAlbum = true,
  showDate = false,
  removeAction = false,
}) {
  if (!tracks.length) {
    return emptyState({
      iconName: 'music',
      title: 'Nothing here yet',
      text: 'Tracks you add will show up in this list.',
    });
  }

  const head = `
    <div class="tracklist__head" role="row">
      <span>#</span>
      <span>Title</span>
      <span>${showAlbum ? 'Album' : ''}</span>
      <span>${showDate ? 'Added' : ''}</span>
      <span></span>
      <span style="text-align:right">${icon('clock', 14)}</span>
    </div>`;

  const rows = tracks
    .map((track, index) =>
      trackRow({
        track,
        index,
        collection,
        isActive: playback?.track?.id === track.id,
        isPlaying: playback?.isPlaying && playback?.track?.id === track.id,
        liked: likedIds?.has?.(track.id),
        showAlbum,
        showDate,
        removeAction,
      }),
    )
    .join('');

  return `<div class="tracklist" role="grid" aria-label="Tracks">${head}<div class="tracklist__body">${rows}</div></div>`;
}

/* ------------------------------------------------------------------ hero */

export function hero({
  type,
  title,
  art,
  round = false,
  phone = false,
  description = '',
  ownerName = '',
  ownerHref = '',
  metaParts = [],
  tint = 'rgba(29,185,84,.22)',
}) {
  return `
    <header class="hero" style="--hero-tint:${esc(tint)}">
      <img class="hero__art ${round ? 'hero__art--round' : ''} ${phone ? 'hero__art--phone' : ''}"
           src="${esc(art || '')}" alt="" />
      <div class="hero__meta">
        <span class="hero__type">${esc(type)}</span>
        <h1 class="hero__title">${esc(title)}</h1>
        ${description ? `<p class="hero__desc">${esc(description)}</p>` : ''}
        <div class="hero__stats">
          ${
            ownerName
              ? `<a class="hero__owner" href="${esc(ownerHref || '#')}">${esc(ownerName)}</a><span class="dot">·</span>`
              : ''
          }
          ${metaParts.filter(Boolean).map((p) => `<span>${p}</span>`).join('<span class="dot">·</span>')}
        </div>
      </div>
    </header>`;
}

export function actionBar({ collection, isPlaying = false, extra = '' }) {
  return `
    <div class="action-bar">
      <button class="action-bar__play" type="button" data-action="play-collection"
              data-collection="${esc(collection)}"
              aria-label="${isPlaying ? 'Pause' : 'Play'}">
        ${icon(isPlaying ? 'pause' : 'play', 22)}
      </button>
      <div class="action-bar__spacer"></div>
      ${extra}
    </div>`;
}

/* ------------------------------------------------------------ feedback UI */

export function emptyState({ iconName = 'music', title, text, actionHTML = '' }) {
  return `
    <div class="empty">
      <span class="empty__icon">${icon(iconName, 28)}</span>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${actionHTML}
    </div>`;
}

export function skeletonCards(count = 6) {
  return Array.from({ length: count })
    .map(
      () => `
      <div class="card">
        <div class="skeleton skeleton--card"></div>
        <div class="skeleton skeleton--text" style="width:80%"></div>
        <div class="skeleton skeleton--text" style="width:50%;height:9px"></div>
      </div>`,
    )
    .join('');
}

export function skeletonTracks(count = 8) {
  return Array.from({ length: count })
    .map(() => `<div class="skeleton skeleton--row"></div>`)
    .join('');
}

/* --------------------------------------------------- recently played tiles */

export function tileGrid(tracks, collection) {
  return `<div class="tile-grid">
    ${tracks
      .slice(0, 6)
      .map(
        (t) => `
      <div class="tile" data-action="play-row" data-track-id="${esc(t.id)}"
           data-collection="${esc(collection)}" tabindex="0" role="button"
           aria-label="Play ${esc(t.title)}">
        <img class="tile__art" src="${esc(t.cover_url || '')}" alt="" loading="lazy" />
        <span class="tile__title">${esc(t.title)}</span>
        <button class="play-fab" type="button" tabindex="-1" aria-hidden="true">${icon('play', 18)}</button>
      </div>`,
      )
      .join('')}
  </div>`;
}

/* ------------------------------------------------------------ misc pieces */

export const sectionLabel = (text, iconName = '') =>
  `<h2 class="section-label">${iconName ? icon(iconName, 18) : ''}${esc(text)}</h2>`;

export const trackCountLabel = (tracks) => summarizeTracks(tracks);

export const genreChips = (genres = []) =>
  `<div class="row-2" style="flex-wrap:wrap;gap:8px;margin:var(--sp-4) 0">
     ${genres.map((g) => `<button class="chip" type="button" data-action="search-chip" data-q="${esc(g)}">${esc(g)}</button>`).join('')}
   </div>`;
