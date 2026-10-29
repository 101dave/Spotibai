/**
 * toast.js — transient, non-blocking feedback (Spotify-style pill at the bottom).
 * Toasts are queued through a single container so rapid actions never overlap.
 */

import { $, esc, icon } from '../utils.js';

let stack = null;

function container() {
  if (!stack) stack = $('#toastStack');
  return stack;
}

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 * @param {number} [duration]
 */
export function toast(message, type = 'info', duration = 2600) {
  const host = container();
  if (!host || !message) return;

  // Collapse duplicates instead of stacking identical pills.
  const existing = Array.from(host.children).find((n) => n.dataset.msg === message);
  if (existing) existing.remove();

  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' toast--error' : type === 'success' ? ' toast--success' : ''}`;
  node.dataset.msg = message;
  node.innerHTML = `${icon(type === 'error' ? 'info' : 'check', 16)}<span>${esc(message)}</span>`;
  host.appendChild(node);

  const remove = () => {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });

  // Keep at most 3 visible.
  while (host.children.length > 3) host.firstElementChild.remove();
}
