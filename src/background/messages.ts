/**
 * The chrome.runtime message contract with the service worker.
 *
 * A separate module from the worker itself so the content script, popup and options page can
 * import these types without pulling the worker's module graph, and therefore its provider
 * code, into their bundles. `src/content/messages.ts` does the same job for the popup-to-
 * content-script contract.
 *
 * Every request here is answered asynchronously, so the worker's listener must return true
 * and call sendResponse later.
 */

import type { RejectionReason } from '../core/scoring.ts';
import type { Chapter, Chunk, DifficultyScore } from '../core/types.ts';
import type { ProviderFailureReason } from './provider.ts';

export interface AnalyzeRequest {
  type: 'ANALYZE';
  videoId: string;
  chunks: Chunk[];
  chapters: Chapter[];
  /**
   * Answer from the cache or not at all. This is how a caller asks "has this video already
   * been paid for" with no possibility of spending anything.
   */
  cacheOnly?: boolean;
}

export interface TestConnectionRequest {
  type: 'TEST_CONNECTION';
}

export interface ClearCacheRequest {
  type: 'CLEAR_CACHE';
}

export type BackgroundRequest = AnalyzeRequest | TestConnectionRequest | ClearCacheRequest;

export type AnalysisFailureReason =
  | ProviderFailureReason
  | RejectionReason
  /** The request could not be sent because the provider's origin is not permitted yet. */
  | 'needs-permission'
  /** Nothing worth rating: no speech chunks, or every one of them is empty. */
  | 'no-content'
  /** Asked for cache only and there was no cache entry. Not an error. */
  | 'not-cached'
  /** Two replies in a row that were not JSON. */
  | 'unparseable';

/**
 * What an analysis cost, in every sense worth knowing.
 *
 * The timing and request count are here because an analysis that takes minutes rather than
 * seconds gives no clue on its own about where the time went. Guessing between a slow model,
 * a retry, and a stall is exactly the kind of thing that gets rebuilt on a hunch, so the
 * numbers are reported instead.
 */
export interface AnalysisMeta {
  fromCache: boolean;
  /** How many scores were interpolated rather than returned by the model. */
  imputed: number;
  /** Total tokens the provider reported. 0 from cache, and 0 if it reported none. */
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall time for the whole analysis, cache lookup included. */
  elapsedMs: number;
  /**
   * Completions actually sent. More than one batch, or a retry after an unparseable reply,
   * both show up here, which is the first thing to check when a run was slow.
   */
  requests: number;
}

export type AnalyzeResponse =
  | { ok: true; scores: DifficultyScore[]; meta: AnalysisMeta }
  | { ok: false; reason: AnalysisFailureReason; message: string };

export type TestConnectionResponse = { ok: true } | { ok: false; message: string };

export type ClearCacheResponse = { cleared: number };

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'ANALYZE' || type === 'TEST_CONNECTION' || type === 'CLEAR_CACHE';
}
