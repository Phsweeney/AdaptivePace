/**
 * Getting ytInitialPlayerResponse and ytInitialData from the isolated world.
 *
 * Three layers, first one that yields data for the right video wins:
 *
 *   1. Ask the MAIN world bridge. Cheapest and always current.
 *   2. Scan the inline page scripts. Works when the bridge did not load, but the blob is
 *      whatever shipped with the initial document, so it is stale after SPA navigation.
 *   3. Refetch the watch page HTML and scan that. Costs a request, but it is correct for
 *      the current video no matter how the user got there.
 */

import { parseJsonAfter } from '../core/json-extract.ts';
import { BRIDGE_REQUEST, isBridgeResponse } from './protocol.ts';
import type { BridgeRequest } from './protocol.ts';

export interface PageData {
  playerResponse: unknown | null;
  ytInitialData: unknown | null;
  /** Which layer produced the player response. Surfaced in the dev panel for debugging. */
  via: 'bridge' | 'inline' | 'refetch' | 'none';
}

const BRIDGE_TIMEOUT_MS = 2000;

function parseOrNull(json: string | null): unknown | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function playerResponseVideoId(playerResponse: unknown): string | null {
  const id = (playerResponse as { videoDetails?: { videoId?: unknown } } | null)?.videoDetails
    ?.videoId;
  return typeof id === 'string' && id ? id : null;
}

/** Accepts a blob only when it describes the video we are actually on. */
function matchesVideo(playerResponse: unknown, videoId: string | null): boolean {
  if (playerResponse === null) return false;
  if (videoId === null) return true;
  const found = playerResponseVideoId(playerResponse);
  return found === null || found === videoId;
}

function askBridge(): Promise<{ playerResponse: unknown | null; ytInitialData: unknown | null }> {
  return new Promise((resolve) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (value: { playerResponse: unknown | null; ytInitialData: unknown | null }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (!isBridgeResponse(event.data) || event.data.id !== id) return;
      finish({
        playerResponse: parseOrNull(event.data.playerResponse),
        ytInitialData: parseOrNull(event.data.ytInitialData),
      });
    };

    const timer = setTimeout(() => finish({ playerResponse: null, ytInitialData: null }), BRIDGE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);

    const request: BridgeRequest = { tag: BRIDGE_REQUEST, id };
    window.postMessage(request, window.location.origin);
  });
}

/**
 * The same global is assigned as `var name = {...}` on desktop and `window["name"] = {...}`
 * in some deliveries, so both spellings are tried.
 */
function findBlob(text: string, name: string): unknown | null {
  for (const marker of [`${name}"] =`, `${name}' ] =`, `${name} =`, name]) {
    const found = parseJsonAfter(text, marker);
    if (found !== null) return found;
  }
  return null;
}

function scanInlineScripts(): { playerResponse: unknown | null; ytInitialData: unknown | null } {
  let playerResponse: unknown | null = null;
  let ytInitialData: unknown | null = null;

  for (const script of Array.from(document.scripts)) {
    const text = script.textContent;
    if (!text) continue;

    if (playerResponse === null && text.includes('ytInitialPlayerResponse')) {
      playerResponse = findBlob(text, 'ytInitialPlayerResponse');
    }
    if (ytInitialData === null && text.includes('ytInitialData')) {
      ytInitialData = findBlob(text, 'ytInitialData');
    }
    if (playerResponse !== null && ytInitialData !== null) break;
  }

  return { playerResponse, ytInitialData };
}

async function refetchWatchPage(videoId: string): Promise<{
  playerResponse: unknown | null;
  ytInitialData: unknown | null;
}> {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: 'include',
    });
    if (!response.ok) return { playerResponse: null, ytInitialData: null };

    const html = await response.text();
    return {
      playerResponse: findBlob(html, 'ytInitialPlayerResponse'),
      ytInitialData: findBlob(html, 'ytInitialData'),
    };
  } catch {
    return { playerResponse: null, ytInitialData: null };
  }
}

export function getVideoIdFromUrl(href: string = window.location.href): string | null {
  try {
    const url = new URL(href);
    if (!url.pathname.startsWith('/watch')) return null;
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

export async function getPageData(videoId: string | null): Promise<PageData> {
  const bridge = await askBridge();
  if (matchesVideo(bridge.playerResponse, videoId)) {
    return { ...bridge, via: 'bridge' };
  }

  const inline = scanInlineScripts();
  if (matchesVideo(inline.playerResponse, videoId)) {
    return {
      playerResponse: inline.playerResponse,
      ytInitialData: inline.ytInitialData ?? bridge.ytInitialData,
      via: 'inline',
    };
  }

  if (videoId !== null) {
    const refetched = await refetchWatchPage(videoId);
    if (matchesVideo(refetched.playerResponse, videoId)) {
      return {
        playerResponse: refetched.playerResponse,
        ytInitialData: refetched.ytInitialData ?? bridge.ytInitialData ?? inline.ytInitialData,
        via: 'refetch',
      };
    }
  }

  return {
    playerResponse: null,
    ytInitialData: bridge.ytInitialData ?? inline.ytInitialData,
    via: 'none',
  };
}
