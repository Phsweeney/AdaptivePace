/**
 * Runs in the page's own JavaScript world at document_start.
 *
 * Two jobs, both of which require page scope:
 *
 *   1. Hand ytInitialPlayerResponse and ytInitialData across the world boundary on request.
 *   2. Obtain the proof-of-origin token that /api/timedtext now demands (see pot.ts for
 *      why). Only the player can produce one, so this file watches for the player's own
 *      caption request and, failing that, provokes one.
 *
 * It has no chrome.* access and holds no state beyond the last player response it saw and
 * the last token it observed.
 */

import { BRIDGE_RESPONSE, POT_RESPONSE, isBridgeRequest, isPotRequest } from './protocol.ts';
import type { BridgeResponse, PotResponse } from './protocol.ts';

interface YouTubeWindow extends Window {
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
}

/** The subset of the YouTube player element's API we drive. All of it is undocumented. */
interface PlayerElement extends HTMLElement {
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  loadModule?: (module: string) => void;
}

const page = window as YouTubeWindow;

let lastPlayerResponse: string | null = null;
let lastPlayerResponseVideoId: string | null = null;

function serialize(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function currentVideoId(): string | null {
  return new URLSearchParams(window.location.search).get('v');
}

/**
 * Returns the live player response, or the cached one when the live global belongs to a
 * different video. YouTube repopulates the global during navigation, and for a moment it
 * still describes the previous video.
 */
function readPlayerResponse(): string | null {
  const videoId = currentVideoId();
  const live = serialize(page.ytInitialPlayerResponse);

  if (live !== null) {
    const liveVideoId = (page.ytInitialPlayerResponse as { videoDetails?: { videoId?: string } })
      ?.videoDetails?.videoId ?? null;

    if (videoId === null || liveVideoId === null || liveVideoId === videoId) {
      lastPlayerResponse = live;
      lastPlayerResponseVideoId = liveVideoId;
      return live;
    }
  }

  return lastPlayerResponseVideoId === videoId ? lastPlayerResponse : live;
}

const TIMEDTEXT_PATH = '/api/timedtext';

/**
 * How long to wait for the player to issue a caption request after we ask it to.
 *
 * The generous window is for the player rather than the network. Selecting a track before
 * the video has started loading is quietly dropped, so the request may not go out until
 * playback begins, which on a cold page can be several seconds after the content script
 * runs. The selection is reapplied at the retry interval for the same reason.
 */
const MINT_TIMEOUT_MS = 12000;
const MINT_POLL_MS = 100;
const MINT_RETRY_MS = 750;

/**
 * Tokens seen this page load, keyed by the video they belong to.
 *
 * A token is bound to one video: the one minted while a pre-roll ad was playing does not
 * work for the video the user actually opened, and vice versa. So this cannot be a single
 * slot. Ads are the reason. The player requests captions for the ad first, and a single
 * slot would then be overwritten by the ad's token and lose a good one already captured.
 *
 * Bounded because a long session on YouTube would otherwise accumulate one entry per video
 * watched, and only the current video's token is ever read.
 */
const tokensByVideo = new Map<string, string>();
const MAX_TOKENS = 8;

function potForCurrentVideo(): string | null {
  const videoId = currentVideoId();
  return videoId === null ? null : tokensByVideo.get(videoId) ?? null;
}

/**
 * Records the pot from a caption request URL. The request carries the video it belongs to,
 * so the pairing is read straight off the URL rather than assumed from page state, which is
 * what keeps an ad's token from being mistaken for the current video's.
 */
function notePot(rawUrl: unknown): void {
  if (typeof rawUrl !== 'string' || !rawUrl.includes(TIMEDTEXT_PATH)) return;
  try {
    const params = new URL(rawUrl, window.location.origin).searchParams;
    const pot = params.get('pot');
    const videoId = params.get('v');
    if (!pot || !videoId) return;

    // Re-insert so iteration order stays newest last, making the first key the oldest.
    tokensByVideo.delete(videoId);
    tokensByVideo.set(videoId, pot);
    while (tokensByVideo.size > MAX_TOKENS) {
      const oldest = tokensByVideo.keys().next().value;
      if (oldest === undefined) break;
      tokensByVideo.delete(oldest);
    }
  } catch {
    // Not a URL we can read. Nothing to capture, and nothing worth failing over.
  }
}

/**
 * Watches for the player's caption requests.
 *
 * Both transports are wrapped because the player has used each at different times. The
 * wrappers read the request URL and nothing else: they do not touch arguments, responses,
 * or errors, so the page behaves identically whether or not we are here.
 */
function observeCaptionRequests(): void {
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    try {
      notePot(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      // Never let observation break a page request.
    }
    return originalFetch.call(window, input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      notePot(typeof url === 'string' ? url : url.href);
    } catch {
      // As above.
    }
    (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;
}

/**
 * Waits for a token to show up, reapplying the caption selection as it goes.
 *
 * `reapply` is called on the retry interval rather than once up front because the player
 * ignores a track selection made before it has started loading the video, and gives no
 * signal that it did so.
 */
function waitForPot(reapply: () => void): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + MINT_TIMEOUT_MS;
    let nextRetry = Date.now() + MINT_RETRY_MS;

    const poll = () => {
      const pot = potForCurrentVideo();
      if (pot !== null) return resolve(pot);
      if (Date.now() >= deadline) return resolve(null);

      if (Date.now() >= nextRetry) {
        nextRetry = Date.now() + MINT_RETRY_MS;
        reapply();
      }
      setTimeout(poll, MINT_POLL_MS);
    };
    poll();
  });
}

/** A track option of {} means captions are off. Anything with a language is a real track. */
function isRealTrack(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { languageCode?: unknown }).languageCode === 'string'
  );
}

/**
 * Provokes a caption request from the player so its token can be observed.
 *
 * Selecting a track is the only lever the player exposes that mints one. The previous
 * caption setting is restored immediately afterwards, so a viewer with subtitles off sees
 * at most a flicker, and one with subtitles on sees nothing at all.
 */
async function mintPot(languageCode: string | null): Promise<string | null> {
  const player = document.querySelector<PlayerElement>('#movie_player');
  if (!player || typeof player.setOption !== 'function') return null;
  // Bound once: the narrowing above does not survive into the closures below.
  const setTrack = (value: unknown) => player.setOption?.('captions', 'track', value);

  let previous: unknown;
  try {
    previous = player.getOption?.('captions', 'track');
    player.loadModule?.('captions');
  } catch {
    // An unloaded captions module is not fatal; setOption below loads it in practice.
  }

  /**
   * The player's own track objects carry fields beyond languageCode, so prefer a real one
   * from its list and fall back to the bare shape only if the list is unavailable. Read
   * each time, because the list is empty until the player has loaded the video.
   */
  const chooseTrack = (): unknown => {
    try {
      const tracklist = player.getOption?.('captions', 'tracklist');
      if (Array.isArray(tracklist) && tracklist.length > 0) {
        return (
          tracklist.find(
            (candidate) => (candidate as { languageCode?: unknown }).languageCode === languageCode,
          ) ?? tracklist[0]
        );
      }
    } catch {
      // Fall through to the bare shape.
    }
    return languageCode === null ? null : { languageCode };
  };

  const select = () => {
    const track = chooseTrack();
    if (track === null) return;
    try {
      setTrack(track);
    } catch {
      // The player rejects a selection until it is ready. The next retry tries again.
    }
  };

  select();
  const pot = await waitForPot(select);

  try {
    setTrack(isRealTrack(previous) ? previous : {});
  } catch {
    // Captions left visible is a cosmetic problem, not a reason to discard the token.
  }

  return pot;
}

/** One mint at a time: concurrent requests would fight over the player's caption setting. */
let pendingMint: Promise<string | null> | null = null;

async function resolvePot(languageCode: string | null): Promise<PotResponse> {
  const reply = (pot: string | null, via: PotResponse['via']): PotResponse => ({
    tag: POT_RESPONSE,
    id: '',
    pot,
    via,
  });

  const alreadyHave = potForCurrentVideo();
  if (alreadyHave !== null) return reply(alreadyHave, 'observed');

  pendingMint ??= mintPot(languageCode).finally(() => {
    pendingMint = null;
  });
  const minted = await pendingMint;

  return minted === null ? reply(null, 'unavailable') : reply(minted, 'minted');
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;

  if (isBridgeRequest(event.data)) {
    const response: BridgeResponse = {
      tag: BRIDGE_RESPONSE,
      id: event.data.id,
      playerResponse: readPlayerResponse(),
      ytInitialData: serialize(page.ytInitialData),
      href: window.location.href,
    };
    window.postMessage(response, window.location.origin);
    return;
  }

  if (isPotRequest(event.data)) {
    const { id, languageCode } = event.data;
    void resolvePot(languageCode).then((response) => {
      window.postMessage({ ...response, id }, window.location.origin);
    });
  }
});

observeCaptionRequests();
