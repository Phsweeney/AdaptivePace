/**
 * Content script entry point, isolated world.
 *
 * Phase 0 only wires up transcript extraction and the dev panel. Player control, the
 * overlay, and analysis arrive in later phases and hang off the same lifecycle.
 *
 * YouTube never reloads between videos, so teardown and setup are driven by
 * yt-navigate-finish rather than by page load. That event fires more than once per
 * navigation, so the handler is guarded by the video id it last set up.
 *
 * The manifest matches all of youtube.com rather than just watch pages, and this file
 * filters. Matching only watch pages would mean never being injected at all for anyone who
 * arrives from the homepage or a search result, since those navigations do not load a
 * document. Everything below no-ops off a watch page.
 */

import { mountDevPanel, unmountDevPanel } from './dev-panel.ts';
import { getVideoIdFromUrl } from './page-data.ts';

declare const DEV_TOOLS: boolean;

let activeVideoId: string | null = null;

function teardown(): void {
  if (DEV_TOOLS) unmountDevPanel();
  activeVideoId = null;
}

function setup(): void {
  const videoId = getVideoIdFromUrl();
  if (videoId === null || videoId === activeVideoId) return;

  teardown();
  activeVideoId = videoId;
  if (DEV_TOOLS) mountDevPanel();
}

document.addEventListener('yt-navigate-start', () => {
  // The next page's id is not known yet, so drop everything and wait for the finish event.
  teardown();
});

document.addEventListener('yt-navigate-finish', () => {
  setup();
});

setup();
