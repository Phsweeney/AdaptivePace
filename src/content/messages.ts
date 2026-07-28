/**
 * The chrome.runtime message contract between the popup and the content script.
 *
 * Separate from protocol.ts, which is the window.postMessage contract with the MAIN world.
 * Different transport, different trust model: postMessage is shouted into a page that anything
 * can listen to, whereas runtime messages only travel between parts of this extension.
 */

export type PopupRequest =
  | { type: 'GET_STATE' }
  | { type: 'SET_PAUSED'; paused: boolean };

/** Why the extension is or is not pacing the current video, in a form the popup can render. */
export type VideoStatus =
  | 'loading'
  | 'pacing'
  | 'paused-for-video'
  | 'suspended-by-viewer'
  | 'disabled'
  | 'no-captions'
  | 'too-long'
  | 'not-a-watch-page';

export interface VideoState {
  status: VideoStatus;
  /** Shown verbatim in the popup. Empty when there is nothing to explain. */
  message: string;
  videoId: string | null;
  currentSpeed: number;
  originalDurationSec: number;
  estimatedWatchTimeSec: number;
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'GET_STATE' || type === 'SET_PAUSED';
}

export const UNAVAILABLE_STATE: VideoState = {
  status: 'not-a-watch-page',
  message: 'Open a YouTube video to use adaptive playback.',
  videoId: null,
  currentSpeed: 1,
  originalDurationSec: 0,
  estimatedWatchTimeSec: 0,
};
