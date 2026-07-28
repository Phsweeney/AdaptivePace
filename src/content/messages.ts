/**
 * The chrome.runtime message contract between the popup and the content script.
 *
 * Separate from protocol.ts, which is the window.postMessage contract with the MAIN world.
 * Different transport, different trust model: postMessage is shouted into a page that anything
 * can listen to, whereas runtime messages only travel between parts of this extension.
 */

import type { ChunkKind } from '../core/types.ts';

export type PopupRequest =
  | { type: 'GET_STATE' }
  | { type: 'SET_ENABLED'; enabled: boolean };

/**
 * Why the extension is or is not pacing the current video, in a form the popup can render.
 *
 * `ready` is the state everything starts in and the one that defines the product: the
 * transcript is read and the plan is built, and playback has not been touched and will not be
 * until somebody presses the button.
 */
export type VideoStatus =
  | 'loading'
  | 'ready'
  | 'pacing'
  | 'suspended-by-viewer'
  | 'disabled'
  | 'no-captions'
  | 'too-long'
  | 'not-a-watch-page';

/**
 * What the difficulty layer is doing, for the one line of popup text above the button.
 *
 * `unavailable` covers both halves of "cannot rate difficulty": no API key configured, or
 * alpha turned down to zero. Neither is an error and neither stops the button working, since
 * speech-rate pacing is a complete product on its own.
 */
export type AnalysisState =
  | 'unavailable'
  | 'idle'
  | 'cached'
  | 'running'
  | 'ready'
  | 'failed';

export interface AnalysisView {
  state: AnalysisState;
  /** Shown verbatim. Empty when there is nothing to explain. */
  message: string;
  /** Rough input token count, shown before the click so the cost is known in advance. */
  estimatedTokens: number;
  /** Scores interpolated over gaps the model left. */
  imputed: number;
  /** Tokens the provider actually reported, once it has. */
  tokensUsed: number;
  /**
   * Split out from the total because they diagnose different things. Input size follows from
   * the transcript, while output size is what the model spends its time generating and is
   * therefore what a slow analysis is usually made of.
   */
  inputTokens: number;
  outputTokens: number;
  /** Wall time the analysis took, and how many completions it needed to get there. */
  elapsedMs: number;
  requests: number;
}

/**
 * What is happening at the moment the viewer is actually watching.
 *
 * Recomputed on every popup poll rather than pushed, because the popup is the only thing that
 * ever looks at it and it is stale a second later either way.
 */
export interface CurrentChunkView {
  kind: ChunkKind;
  /** 1-10 as the model rated it. Null when the video has no scores. */
  raw: number | null;
  /** Standard deviations from this video's own mean difficulty. Null without scores. */
  z: number | null;
  /** True when this chunk's rating was interpolated over a gap in the model's reply. */
  imputed: boolean;
  /** How fast the speaker is actually going here. */
  nativeWpm: number;
  /** What the plan asks for at this moment. */
  speed: number;
}

export interface VideoState {
  status: VideoStatus;
  /** Shown verbatim in the popup. Empty when there is nothing to explain. */
  message: string;
  videoId: string | null;
  /** True once the viewer has switched this video on. Resets on every navigation. */
  enabled: boolean;
  currentSpeed: number;
  originalDurationSec: number;
  estimatedWatchTimeSec: number;
  analysis: AnalysisView;
  /** Null before a plan exists, or when the playhead is outside it. */
  current: CurrentChunkView | null;
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'GET_STATE' || type === 'SET_ENABLED';
}

export const IDLE_ANALYSIS: AnalysisView = {
  state: 'unavailable',
  message: '',
  estimatedTokens: 0,
  imputed: 0,
  tokensUsed: 0,
  inputTokens: 0,
  outputTokens: 0,
  elapsedMs: 0,
  requests: 0,
};

export const UNAVAILABLE_STATE: VideoState = {
  status: 'not-a-watch-page',
  message: 'Open a YouTube video to use adaptive playback.',
  videoId: null,
  enabled: false,
  currentSpeed: 1,
  originalDurationSec: 0,
  estimatedWatchTimeSec: 0,
  analysis: IDLE_ANALYSIS,
  current: null,
};
