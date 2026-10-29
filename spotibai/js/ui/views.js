/**
 * views.js — the view layer
 * ---------------------------------------------------------------------------
 * Each exported render*() is an async function that:
 *   1. fetches from the active repository (Supabase or demo — identical API),
 *   2. registers its track arrays in the collection registry (so a row click
 *      can rebuild the exact queue it was rendered in),
 *   3. returns an HTML string for #viewRoot.
 *
 * No view touches the store or the DOM directly. app.js owns mounting.
 */

import {
  esc,
  icon,
  fmtCount,
  fmtRelative,
  fmtTime,
  summarizeTracks,
  initials,
} from '../utils.js';
import {
  albumCard,
  artistCard,
  actionBar,
  cardGrid,
  emptyState,
  hero,
  mediaCard,
  playlistCard,
  shelf,
  skeletonCards,
  skeletonTracks,
  tileGrid,
  tiktokCard,
  trackList,
  genreChips,
} from './components.js';

/* --------------------------------------------------------------- helpers -- */

const GREETING = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const TINTS = {
  album: 'rgba(29,185,84,.28)',
  playlist: 'rgba(80,120,255,.26)',
  liked: 'rgba(120,60,220,.34)',
  artist: 'rgba(254,44,85,.22)',
  tiktok: 'rgba(254,44,85,.26)',
};

/* ===========================================================================
   HOME
   =========================================================================== */
export async function renderHome(ctx) {
  const [recent, albums, top, tiktok, artists] = await Promise.all([
    ctx.repo.recentlyPlayed(8).catch(() => []),
    ctx.repo.listAlbums().catch(() => []),
    ctx.repo.topTracks(6).catch(() => []),
    ctx.repo.tiktokTracks(6).catch(() => []),
    ctx.repo.listArtists().catch(() => []),
  ]);

  ctx.registerCollection('home:recent', recent);
  ctx.registerCollection('home:top', top);
  ctx.registerCollection('home:tiktok', tiktok);
  ctx.registerCollection('home:all', top);

  const featured = albums.slice(0, 6);
  const hasContent = albums.length || top.length;

  if (!hasContent) {
    return `${emptyState({
      iconName: 'database',
      title: 'No catalog yet',
      text: 'Run sql/schema.sql and sql/seed.sql in your Supabase project, or connect credentials from the sidebar to load the demo feed.',
    })}`;
  }

  return `
    <div class="view__inner">
      <h1 class="greeting">${GREETING()}</h1>

      ${recent.length ? tileGrid(recent.slice(0, 6), 'home:recent') : ''}

      ${shelf({
        title: 'Featured albums',
        iconName: 'music',
        moreHref: '#/library',
        moreLabel: 'Your library',
        body: cardGrid(featured.map(albumCard).join('')),
      })}

      ${
        tiktok.length
          ? shelf({
              title: 'Trending on @spotibai_ph',
              iconName: 'tiktok',
              moreHref: '#/search?q=tiktok',
              moreLabel: 'All drops',
              body: cardGrid(tiktok.map(tiktokCard).join(''), 'card-grid--tiktok'),
            })
          : ''
      }

      ${shelf({
        title: 'Top tracks this week',
        iconName: 'queue',
        body: trackList({
          tracks: top,
          collection: 'home:top',
          playback: ctx.playback,
          likedIds: ctx.likedIds,
        }),
      })}

      ${shelf({
        title: 'Artists to follow',
        iconName: 'user',
        body: cardGrid(artists.map(artistCard).join('')),
      })}
    </div>`;
}

/** Skeleton shown while the first paint resolves. */
export function homeSkeleton() {
  return `<div class="view__inner">
    <div class="skeleton" style="height:28px;width:220px;margin:8px 0 24px"></div>
    <div class="card-grid">${skeletonCards(6)}</div>
    <div style="margin-top:32px">${skeletonTracks(5)}</div>
  </div>`;
}

/* ===========================================================================
   SEARCH
   =========================================================================== */
const SEARCH_SUGGESTIONS = ['Bai-J', 'Bisaya', 'Tangalog', 'TikTok', 'Hugot', 'Open verse'];

export function searchShell(query = '') {
  return `
    <div class="view__inner">
      <form class="search-field" role="search" data-search-form>
        ${icon('search', 18)}
        <input type="search" name="q" value="${esc(query)}" placeholder="What do you want to listen to?"
               aria-label="Search tracks, albums and artists" autocomplete="off"
               data-search-input autofocus />
      </form>
      <div class="row-2" style="flex-wrap:wrap;gap:8px;margin:var(--sp-4) 0" data-chips>
        ${SEARCH_SUGGESTIONS.map(
          (g) => `<button class="chip" type="button" data-action="search-chip" data-q="${esc(g)}">${esc(g)}</button>`,
        ).join('')}
      </div>
      <div id="searchResults"></div>
    </div>`;
}

export function searchResultsHTML(ctx, query) {
  if (!query) {
    return `
      <h2 class="section-label">${icon('search', 18)}Browse the catalog</h2>
      ${cardGrid(
        ctx.genres
          .map(
            (g) => `
        <button class="card" type="button" data-action="search-chip" data-q="${esc(g)}">
          <div class="card__art" style="display:grid;place-items:center;background:linear-gradient(135deg,#2a2a2a,#151515)">
            ${icon('music', 34)}
          </div>
          <div class="card__body"><span class="card__title">${esc(g)}</span></div>
        </button>`,
          )
          .join(''),
      )}`;
  }

  const { tracks = [], albums = [], artists = [] } = ctx.searchResult || {};
  const nothing = !tracks.length && !albums.length && !artists.length;

  if (nothing) {
    return emptyState({
      iconName: 'search',
      title: `No results for “${query}”`,
      text: 'Try a different spelling, an artist name, or a tag like “bisaya”.',
    });
  }

  ctx.registerCollection('search:tracks', tracks);

  return `
    ${
      tracks.length
        ? `<section class="shelf">
             <h2 class="shelf__title" style="margin-bottom:var(--sp-3)">${icon('music', 18)}Songs</h2>
             ${trackList({
               tracks: tracks.slice(0, 8),
               collection: 'search:tracks',
               playback: ctx.playback,
               likedIds: ctx.likedIds,
             })}
           </section>`
        : ''
    }
    ${
      albums.length
        ? shelf({
            title: 'Albums',
            iconName: 'library',
            body: cardGrid(albums.map(albumCard).join('')),
          })
        : ''
    }
    ${
      artists.length
        ? shelf({
            title: 'Artists',
            iconName: 'user',
            body: cardGrid(artists.map(artistCard).join('')),
          })
        : ''
    }`;
}

/* ===========================================================================
   LIBRARY
   =========================================================================== */
export async function renderLibrary(ctx) {
  const playlists = await ctx.repo.listPlaylists().catch(() => []);
  const liked = ctx.likedIds;
  const likedCount = liked?.size ?? 0;

  const likedCard = mediaCard({
    href: '#/liked',
    title: 'Liked Songs',
    meta: `${likedCount} ${likedCount === 1 ? 'track' : 'tracks'}`,
    art: './assets/covers/album-hugot-sessions.svg',
    playCollection: 'liked',
    playLabel: 'Play Liked Songs',
  });

  return `
    <div class="view__inner">
      <h1 class="greeting">Your Library</h1>
      ${cardGrid(
        likedCard +
          playlists.map(playlistCard).join('') +
          `<button class="card" type="button" data-action="create-playlist">
             <div class="card__art" style="display:grid;place-items:center;background:linear-gradient(135deg,#232323,#151515)">
               ${icon('plus', 34)}
             </div>
             <div class="card__body">
               <span class="card__title">Create playlist</span>
               <span class="card__meta">Start from scratch</span>
             </div>
           </button>`,
      )}
    </div>`;
}

/* ===========================================================================
   ALBUM
   =========================================================================== */
export async function renderAlbum(ctx, id) {
  const data = await ctx.repo.getAlbum(id);
  if (!data) return notFound('That album does not exist (or was removed).');

  const { album, artist, tracks } = data;
  const collection = `album:${album.id}`;
  ctx.registerCollection(collection, tracks);

  return `
    <div class="view__inner">
      ${hero({
        type: 'Album',
        title: album.title,
        art: album.cover_url,
        description: '',
        ownerName: artist?.name || album.artist_name || 'Unknown artist',
        ownerHref: artist ? `#/artist/${artist.id}` : '#',
        metaParts: [String(album.release_year || ''), summarizeTracks(tracks)],
        tint: TINTS.album,
      })}
      ${actionBar({ collection })}
      <div class="content-block">
        ${trackList({
          tracks,
          collection,
          playback: ctx.playback,
          likedIds: ctx.likedIds,
        })}
      </div>
    </div>`;
}

/* ===========================================================================
   PLAYLIST
   =========================================================================== */
export async function renderPlaylist(ctx, id) {
  const data = await ctx.repo.getPlaylist(id);
  if (!data) return notFound('That playlist does not exist, or is private.');

  const { playlist, tracks } = data;
  const collection = `playlist:${playlist.id}`;
  ctx.registerCollection(collection, tracks);

  const ownerId = playlist.user_id;
  const isOwner = !ctx.user || ownerId === ctx.user.id || ownerId === 'demo-user';

  return `
    <div class="view__inner">
      ${hero({
        type: `${playlist.is_public ? 'Public' : 'Private'} playlist`,
        title: playlist.title,
        art: playlist.cover_url || tracks[0]?.cover_url,
        description: playlist.description || '',
        ownerName: playlist.owner_name || (isOwner ? 'You' : 'Listener'),
        ownerHref: '#/library',
        metaParts: [summarizeTracks(tracks)],
        tint: TINTS.playlist,
      })}
      ${actionBar({
        collection,
        extra: isOwner
          ? `<button class="btn btn--ghost btn--sm" type="button" data-action="delete-playlist" data-playlist-id="${esc(playlist.id)}">
               ${icon('trash', 14)} Delete playlist
             </button>`
          : '',
      })}
      <div class="content-block">
        ${trackList({
          tracks,
          collection,
          playback: ctx.playback,
          likedIds: ctx.likedIds,
          removeAction: isOwner,
        })}
      </div>
    </div>`;
}

/* ===========================================================================
   LIKED SONGS
   =========================================================================== */
export async function renderLiked(ctx) {
  const tracks = await ctx.repo.likedTracks().catch(() => []);
  ctx.registerCollection('liked', tracks);

  return `
    <div class="view__inner">
      ${hero({
        type: 'Playlist',
        title: 'Liked Songs',
        art: './assets/covers/album-hugot-sessions.svg',
        description: 'Everything you tapped the heart on.',
        ownerName: ctx.profile?.display_name || 'You',
        ownerHref: '#/library',
        metaParts: [summarizeTracks(tracks)],
        tint: TINTS.liked,
      })}
      ${actionBar({ collection: 'liked' })}
      <div class="content-block">
        ${trackList({
          tracks,
          collection: 'liked',
          playback: ctx.playback,
          likedIds: ctx.likedIds,
        })}
      </div>
    </div>`;
}

/* ===========================================================================
   ARTIST
   =========================================================================== */
export async function renderArtist(ctx, id) {
  const data = await ctx.repo.getArtist(id);
  if (!data) return notFound('That artist is not in the catalog.');

  const { artist, albums, topTracks, tracks } = data;
  ctx.registerCollection(`artist:${artist.id}:top`, topTracks);
  ctx.registerCollection(`artist:${artist.id}:all`, tracks);

  return `
    <div class="view__inner">
      ${hero({
        type: 'Artist',
        title: artist.name,
        art: artist.image_url,
        round: true,
        description: artist.bio || '',
        metaParts: [`${fmtCount(tracks.length)} tracks`],
        tint: TINTS.artist,
      })}
      ${actionBar({ collection: `artist:${artist.id}:top` })}

      <div class="content-block">
        <h2 class="section-label">Popular</h2>
        ${trackList({
          tracks: topTracks,
          collection: `artist:${artist.id}:top`,
          playback: ctx.playback,
          likedIds: ctx.likedIds,
        })}
      </div>

      ${
        albums.length
          ? `<div class="content-block" style="margin-top:var(--sp-7)">
               ${shelf({ title: 'Discography', iconName: 'library', body: cardGrid(albums.map(albumCard).join('')) })}
             </div>`
          : ''
      }

      <div class="content-block" style="margin-top:var(--sp-5)">
        ${shelf({
          title: 'All tracks',
          iconName: 'music',
          body: trackList({
            tracks,
            collection: `artist:${artist.id}:all`,
            playback: ctx.playback,
            likedIds: ctx.likedIds,
          }),
        })}
      </div>
    </div>`;
}

/* ===========================================================================
   TRACK DEEP LINK (#/track/<id>)
   Opens the track and its album as the queue.
   =========================================================================== */
export async function renderTrackView(ctx, id) {
  const track = await ctx.repo.getTrack(id);
  if (!track) return notFound('That track does not exist.');

  const albumData = track.album_id ? await ctx.repo.getAlbum(track.album_id) : null;
  const queue = albumData?.tracks?.length ? albumData.tracks : [track];
  ctx.registerCollection(`track:${id}`, queue);
  ctx.requestPlay?.({ collection: `track:${id}`, trackId: id });

  return `
    <div class="view__inner">
      ${hero({
        type: track.is_tiktok_source ? 'TikTok drop' : 'Track',
        title: track.title,
        art: track.cover_url,
        description: track.tiktok_caption || '',
        ownerName: track.artist_name,
        ownerHref: `#/artist/${track.artist_id}`,
        metaParts: [track.album_title || 'Single', fmtTime(track.duration_seconds)],
        tint: track.is_tiktok_source ? TINTS.tiktok : TINTS.album,
      })}
      <div class="content-block" style="padding-top:var(--sp-4)">
        ${
          track.is_tiktok_source
            ? `<div class="row-2" style="gap:8px;flex-wrap:wrap;margin-bottom:var(--sp-4)">
                 <span class="badge badge--tiktok">${icon('tiktok', 12)} TikTok source</span>
                 <span class="muted" style="font-size:var(--fs-xs)">@${esc(track.tiktok_author || 'spotibai_ph')} · ${fmtCount(track.tiktok_like_count)} likes · ${fmtRelative(track.tiktok_posted_at)}</span>
               </div>`
            : ''
        }
        ${trackList({
          tracks: queue,
          collection: `track:${id}`,
          playback: ctx.playback,
          likedIds: ctx.likedIds,
        })}
      </div>
    </div>`;
}

/* ===========================================================================
   Shared
   =========================================================================== */
export function notFound(message = 'We could not find that page.') {
  return `<div class="view__inner">
    ${emptyState({
      iconName: 'info',
      title: 'Page not found',
      text: message,
      actionHTML: `<a class="btn btn--accent btn--sm" href="#/home">Back to home</a>`,
    })}
  </div>`;
}

export function viewSkeleton() {
  return `<div class="view__inner">
    <div class="skeleton" style="height:180px;border-radius:12px;margin-bottom:24px"></div>
    ${skeletonTracks(8)}
  </div>`;
}

export { initials, genreChips };
