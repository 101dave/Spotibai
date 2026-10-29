/**
 * modal.js — accessible modal shell + the app's concrete dialogs
 * (auth, connection settings, create playlist, queue, confirm).
 *
 * A single modal can be open at a time. Focus is trapped between the first and
 * last focusable child, Escape closes, and the scrim click closes.
 */

import { $, esc, icon, fmtTime, fmtCount } from '../utils.js';
import { CONFIG, hasSupabaseCredentials, saveSupabaseCredentials } from '../config.js';

let activeModal = null;
let lastFocused = null;

export function closeModal() {
  if (!activeModal) return;
  const { root, onClose } = activeModal;
  root.remove();
  document.removeEventListener('keydown', onKeydown, true);
  activeModal = null;
  lastFocused?.focus?.();
}

function onKeydown(event) {
  if (!activeModal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = activeModal.root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body HTML
 * @param {string} [opts.footer] HTML
 * @param {(root: HTMLElement)=>void} [opts.onMount]
 * @param {()=>void} [opts.onClose]
 * @param {boolean} [opts.dismissible]
 */
export function openModal({ title, body, footer = '', onMount, onClose, dismissible = true }) {
  closeModal();
  lastFocused = document.activeElement;

  const root = document.createElement('div');
  root.className = 'modal-scrim';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal__head">
        <h2 class="modal__title" id="modalTitle">${esc(title)}</h2>
        ${
          dismissible
            ? `<button class="icon-btn" type="button" data-modal-close aria-label="Close dialog">${icon('close', 18)}</button>`
            : ''
        }
      </div>
      <div class="modal__body">${body}</div>
      ${footer ? `<div class="modal__body" style="padding-top:0"><div class="modal__foot">${footer}</div></div>` : ''}
    </div>`;

  root.addEventListener('mousedown', (e) => {
    if (e.target === root && dismissible) closeModal();
  });
  root.querySelectorAll('[data-modal-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal()),
  );

  $('#modalRoot').appendChild(root);
  document.addEventListener('keydown', onKeydown, true);
  activeModal = { root, onClose };

  onMount?.(root);

  const firstField = root.querySelector('input, button[data-autofocus], .btn--accent');
  firstField?.focus();
  return { root, close: closeModal };
}

/* ===========================================================================
   Auth dialog
   =========================================================================== */
export function openAuthModal({ repo, onSignedIn }) {
  let mode = 'signin';

  const body = `
    <div class="tabs" role="tablist">
      <button class="tabs__btn is-active" type="button" role="tab" data-tab="signin">Sign in</button>
      <button class="tabs__btn" type="button" role="tab" data-tab="signup">Create account</button>
    </div>

    <form id="authForm" class="stack-2" novalidate>
      <div class="field" data-field="username" hidden>
        <label for="authUsername">Username</label>
        <input id="authUsername" name="username" autocomplete="username"
               placeholder="tangalog_bai" minlength="3" maxlength="30" />
      </div>
      <div class="field">
        <label for="authEmail">Email</label>
        <input id="authEmail" name="email" type="email" autocomplete="email"
               placeholder="you@example.com" required />
      </div>
      <div class="field">
        <label for="authPassword">Password</label>
        <input id="authPassword" name="password" type="password" minlength="6"
               autocomplete="current-password" placeholder="At least 6 characters" required />
      </div>
      <p class="form-error" id="authError" role="alert"></p>
      <button class="btn btn--accent btn--block" type="submit" data-autofocus>
        Sign in
      </button>
    </form>

    <p class="modal__hint">
      ${
        repo.mode === 'demo'
          ? `Demo mode — credentials stay in this browser and never leave the tab.
             Any email + 6-character password works.`
          : 'Sessions are handled by Supabase Auth (email + password).'
      }
    </p>`;

  return openModal({
    title: 'Welcome to SpotiBai',
    body,
    onMount(root) {
      const form = root.querySelector('#authForm');
      const errorEl = root.querySelector('#authError');
      const submit = form.querySelector('button[type="submit"]');
      const usernameField = root.querySelector('[data-field="username"]');
      const tabs = root.querySelectorAll('[data-tab]');

      const setMode = (next) => {
        mode = next;
        tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === next));
        usernameField.hidden = next !== 'signup';
        submit.textContent = next === 'signup' ? 'Create account' : 'Sign in';
        form.querySelector('#authPassword').autocomplete =
          next === 'signup' ? 'new-password' : 'current-password';
        errorEl.textContent = '';
      };

      tabs.forEach((tab) =>
        tab.addEventListener('click', () => setMode(tab.dataset.tab)),
      );

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        submit.disabled = true;
        const original = submit.textContent;
        submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';

        const payload = {
          email: form.email.value.trim(),
          password: form.password.value,
          username: (form.username?.value || '').trim(),
        };

        try {
          const session =
            mode === 'signup'
              ? await repo.auth.signUp(payload)
              : await repo.auth.signIn(payload);

          if (session?.needsConfirmation) {
            errorEl.textContent =
              'Check your inbox — confirm your email to finish creating the account.';
            return;
          }
          closeModal();
          onSignedIn?.(session);
        } catch (err) {
          errorEl.textContent = err.message || 'Authentication failed.';
        } finally {
          submit.disabled = false;
          submit.textContent = original;
        }
      });
    },
  });
}

/* ===========================================================================
   Connection settings
   =========================================================================== */
export function openSourceModal({ repo }) {
  const configured = hasSupabaseCredentials();
  const body = `
    <div class="stack-2">
      <p class="modal__hint" style="font-size:var(--fs-sm);color:var(--text-secondary)">
        Currently running on
        <strong style="color:${repo.mode === 'supabase' ? 'var(--accent)' : 'var(--text-primary)'}">
          ${repo.mode === 'supabase' ? 'Supabase' : 'local demo data'}
        </strong>.
        ${
          repo.mode === 'demo'
            ? 'Add your project URL and anon key below (after running <code>sql/schema.sql</code> and <code>sql/seed.sql</code>) to switch to Postgres, Auth and Storage.'
            : 'Credentials are read from this browser only.'
        }
      </p>

      <div class="field">
        <label for="sbUrl">Project URL</label>
        <input id="sbUrl" name="url" type="url" spellcheck="false"
               placeholder="https://abcdefghijkl.supabase.co"
               value="${esc(CONFIG.SUPABASE_URL || '')}" />
      </div>
      <div class="field">
        <label for="sbKey">Anon / publishable key</label>
        <input id="sbKey" name="key" type="password" spellcheck="false"
               placeholder="eyJhbGciOiJIUzI1NiIs…" value="${esc(CONFIG.SUPABASE_ANON_KEY || '')}" />
      </div>

      <p class="form-error" id="srcError" role="alert"></p>
      <p class="modal__hint">
        Row Level Security keeps the anon key safe to expose: it can only read
        public catalog data and write rows owned by the signed-in user.
      </p>

      <div class="row-2" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <button class="btn btn--sm btn--ghost" type="button" id="resetDemo">
          ${icon('trash', 14)} Reset demo data
        </button>
        <span class="modal__hint">${configured ? 'Credentials stored locally.' : 'No credentials saved.'}</span>
      </div>
    </div>`;

  return openModal({
    title: 'Data source',
    body,
    footer: `
      <button class="btn btn--ghost" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--accent" type="button" id="saveSource">Save &amp; reload</button>`,
    onMount(root) {
      const errorEl = root.querySelector('#srcError');

      root.querySelector('#saveSource').addEventListener('click', () => {
        const url = root.querySelector('#sbUrl').value.trim();
        const key = root.querySelector('#sbKey').value.trim();

        if (!url && !key) {
          saveSupabaseCredentials('', '');
          location.reload();
          return;
        }
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) {
          errorEl.textContent = 'That does not look like a Supabase project URL.';
          return;
        }
        if (key.length < 60) {
          errorEl.textContent = 'The anon key looks too short — copy the full key from Settings → API.';
          return;
        }
        saveSupabaseCredentials(url, key);
        location.reload();
      });

      root.querySelector('#resetDemo').addEventListener('click', async () => {
        try {
          await repo.reset?.();
        } finally {
          location.reload();
        }
      });
    },
  });
}

/* ===========================================================================
   Create playlist
   =========================================================================== */
export function openCreatePlaylistModal({ onCreate }) {
  return openModal({
    title: 'Create playlist',
    body: `
      <form id="playlistForm" class="stack-2">
        <div class="field">
          <label for="plTitle">Name</label>
          <input id="plTitle" name="title" maxlength="80" placeholder="My Playlist" data-autofocus required />
        </div>
        <div class="field">
          <label for="plDesc">Description (optional)</label>
          <input id="plDesc" name="description" maxlength="160" placeholder="What is this playlist for?" />
        </div>
        <label class="row-2" style="gap:8px;font-size:var(--fs-sm);color:var(--text-secondary)">
          <input type="checkbox" name="isPublic" />
          Make public on my profile
        </label>
        <p class="form-error" id="plError" role="alert"></p>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--accent" type="button" id="createPlaylistBtn">Create</button>`,
    onMount(root) {
      const form = root.querySelector('#playlistForm');
      const errorEl = root.querySelector('#plError');

      const submit = async () => {
        const title = form.title.value.trim();
        if (!title) {
          errorEl.textContent = 'Give your playlist a name.';
          return;
        }
        try {
          await onCreate({
            title,
            description: form.description.value.trim(),
            isPublic: form.isPublic.checked,
          });
          closeModal();
        } catch (err) {
          errorEl.textContent = err.message || 'Could not create the playlist.';
        }
      };

      root.querySelector('#createPlaylistBtn').addEventListener('click', submit);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
      });
    },
  });
}

/* ===========================================================================
   Add-to-playlist picker
   =========================================================================== */
export function openAddToPlaylistModal({ track, playlists, onPick, onCreateNew }) {
  const rows = playlists.length
    ? playlists
        .map(
          (p) => `
          <button class="menu__item" type="button" data-playlist-id="${esc(p.id)}">
            ${icon('music', 16)}<span class="truncate">${esc(p.title)}</span>
            <span class="muted" style="margin-left:auto;font-size:var(--fs-2xs)">${p.track_count ?? ''}</span>
          </button>`,
        )
        .join('')
    : `<p class="modal__hint">No playlists yet — create one below.</p>`;

  return openModal({
    title: 'Add to playlist',
    body: `
      <p class="modal__hint">${esc(track.title)} — ${esc(track.artist_name || '')}</p>
      <div class="stack-2" style="max-height:280px;overflow:auto">${rows}</div>
      <button class="btn btn--ghost btn--sm" type="button" id="newPlaylistFromPicker">
        ${icon('plus', 14)} New playlist
      </button>`,
    onMount(root) {
      root.querySelectorAll('[data-playlist-id]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          await onPick(btn.dataset.playlistId);
          closeModal();
        }),
      );
      root.querySelector('#newPlaylistFromPicker').addEventListener('click', () => {
        closeModal();
        onCreateNew?.();
      });
    },
  });
}

/* ===========================================================================
   Queue inspector
   =========================================================================== */
export function openQueueModal({ playback, onJump }) {
  const rows = playback.queue.length
    ? playback.queue
        .map(
          (t, i) => `
        <button class="menu__item" type="button" data-queue-index="${i}"
                ${i === playback.index ? 'style="background:rgba(29,185,84,.12);color:var(--accent)"' : ''}>
          <img src="${esc(t.cover_url || '')}" alt="" style="width:32px;height:32px;border-radius:4px;object-fit:cover" />
          <span class="truncate" style="flex:1;text-align:left">
            ${esc(t.title)}
            <span class="muted" style="display:block;font-size:var(--fs-2xs)">${esc(t.artist_name || '')}</span>
          </span>
          ${
            t.is_tiktok_source
              ? `<span class="badge badge--tiktok" style="font-size:9px">TikTok</span>`
              : ''
          }
          <span class="muted" style="font-size:var(--fs-2xs)">${fmtTime(t.duration_seconds)}</span>
        </button>`,
        )
        .join('')
    : `<p class="modal__hint">The queue is empty. Pick a track to start listening.</p>`;

  return openModal({
    title: `Queue${playback.queue.length ? ` · ${playback.queue.length} tracks` : ''}`,
    body: `
      ${
        playback.queue[playback.index]
          ? `<p class="modal__hint">Now playing: <strong>${esc(playback.queue[playback.index].title)}</strong></p>`
          : ''
      }
      <div class="stack-2" style="max-height:52vh;overflow:auto" id="queueList">${rows}</div>`,
    onMount(root) {
      root.querySelectorAll('[data-queue-index]').forEach((btn) =>
        btn.addEventListener('click', () => {
          onJump(Number(btn.dataset.queueIndex));
          closeModal();
        }),
      );
    },
  });
}

/* ===========================================================================
   Confirm
   =========================================================================== */
export function openConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm }) {
  return openModal({
    title,
    body: `<p class="modal__hint" style="font-size:var(--fs-sm);color:var(--text-secondary)">${esc(message)}</p>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--accent" type="button" id="confirmBtn">${esc(confirmLabel)}</button>`,
    onMount(root) {
      root.querySelector('#confirmBtn').addEventListener('click', async () => {
        await onConfirm();
        closeModal();
      });
    },
  });
}

export const modalIsOpen = () => Boolean(activeModal);
export { fmtCount };
