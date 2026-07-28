/**
 * Running one difficulty analysis end to end: cache, request, repair, score, store.
 *
 * The ordering is the interesting part. A cache hit returns before anything else happens, so
 * a rewatched video costs nothing and issues no request at all. Everything after that point
 * is arranged so that the analysis can fail at any stage and the caller is left exactly where
 * it started, on the alpha = 0 plan, with a sentence explaining why.
 *
 * The worker keeps this in its own module so `service-worker.ts` stays a router. That
 * separation is what makes this testable: the whole pipeline can be driven in Node with a
 * stubbed fetch, without a service worker, a browser, or an extension around it.
 */

import {
  JSON_REMINDER,
  SYSTEM_PROMPT,
  batchInput,
  buildUserMessage,
  parseScoreResponse,
  planBatches,
  rescaleAnchoredBatch,
  scoreableChunks,
} from '../core/prompt.ts';
import { checkAnalysisQuality, computeZScores, repairRatings } from '../core/scoring.ts';
import { cacheKey, getAnalysis, putAnalysis } from '../storage/cache.ts';
import type { Chapter, Chunk, Settings } from '../core/types.ts';
import type { AnalysisFailureReason, AnalyzeResponse } from './messages.ts';
import { requestCompletion } from './provider.ts';
import type { ChatMessage } from './provider.ts';

interface BatchUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AnalyzeInput {
  videoId: string;
  chunks: readonly Chunk[];
  chapters: readonly Chapter[];
  settings: Settings;
  cacheOnly?: boolean;
}

/**
 * Asks for one batch's ratings, allowing a single retry for an unparseable reply.
 *
 * The retry feeds the model its own bad answer back followed by a reminder, rather than
 * simply asking again. Repeating an identical request to a temperature-0 endpoint is close
 * to pointless: it will produce the same reply. Showing it what went wrong is the only
 * version of a retry that has a reason to work.
 */
async function requestBatchRatings(
  settings: Settings,
  userMessage: string,
): Promise<
  | { ok: true; ratings: Map<number, number>; usage: BatchUsage }
  | { ok: false; reason: AnalysisFailureReason; message: string; usage: BatchUsage }
> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const usage: BatchUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestCompletion(settings, messages);
    usage.requests += 1;

    if (!response.ok) {
      return { ok: false, reason: response.reason, message: response.message, usage };
    }

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    const ratings = parseScoreResponse(response.content);
    if (ratings !== null) return { ok: true, ratings, usage };

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: JSON_REMINDER });
  }

  return {
    ok: false,
    reason: 'unparseable',
    message: 'The model did not return usable JSON, even after being asked again.',
    usage,
  };
}

export async function runAnalysis(input: AnalyzeInput): Promise<AnalyzeResponse> {
  const { videoId, chunks, chapters, settings, cacheOnly = false } = input;

  const startedAt = Date.now();
  const spent: BatchUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const meta = (fromCache: boolean, imputed: number) => ({
    fromCache,
    imputed,
    tokensUsed: spent.inputTokens + spent.outputTokens,
    inputTokens: spent.inputTokens,
    outputTokens: spent.outputTokens,
    elapsedMs: Date.now() - startedAt,
    requests: spent.requests,
  });

  const add = (usage: BatchUsage): void => {
    spent.inputTokens += usage.inputTokens;
    spent.outputTokens += usage.outputTokens;
    spent.requests += usage.requests;
  };

  // The cache is consulted before the chunks are even looked at, because a lookup needs only
  // the video id and the model. That is what lets a cache-only probe send no chunk text at
  // all, rather than shipping the whole transcript across a message port to ask a question
  // about a key.
  const key = cacheKey(videoId, settings.model);
  const cached = await getAnalysis(key);
  if (cached !== null) {
    const imputed = cached.scores.filter((score) => score.imputed).length;
    return { ok: true, scores: cached.scores, meta: meta(true, imputed) };
  }

  if (cacheOnly) {
    return {
      ok: false,
      reason: 'not-cached',
      message: 'This video has not been analyzed yet.',
    };
  }

  const scoreable = scoreableChunks(chunks);
  if (scoreable.length === 0) {
    return {
      ok: false,
      reason: 'no-content',
      message: 'This video has no speech to rate.',
    };
  }

  const batches = planBatches(scoreable);
  const combined = new Map<number, number>();

  for (const batch of batches) {
    const segments = batchInput(batch);
    const result = await requestBatchRatings(settings, buildUserMessage(segments, chapters));
    add(result.usage);

    if (!result.ok) {
      return { ok: false, reason: result.reason, message: result.message };
    }

    // Every batch after the first rated on its own scale. The anchors it shares with the
    // previous batch are the only common ground between the two, so they are what the
    // affine correction is fitted on. Without this the seam is a visible step in speed.
    const anchorIds = batch.anchors.map((chunk) => chunk.id);
    const aligned =
      anchorIds.length === 0
        ? result.ratings
        : rescaleAnchoredBatch(result.ratings, anchorIds, combined);

    // Anchors are dropped afterwards: the previous batch's reading of them is the one on
    // the reference scale, and re-rated copies would only pull it around.
    for (const chunk of batch.chunks) {
      const rating = aligned.get(chunk.id);
      if (rating !== undefined) combined.set(chunk.id, rating);
    }
  }

  const repaired = repairRatings(combined, scoreable);
  const quality = checkAnalysisQuality(repaired);
  if (!quality.ok) {
    return { ok: false, reason: quality.reason, message: quality.message };
  }

  const scores = computeZScores(repaired, scoreable);

  await putAnalysis({
    key,
    videoId,
    model: settings.model,
    chunkCount: scoreable.length,
    scores,
    tokensUsed: spent.inputTokens + spent.outputTokens,
  });

  return { ok: true, scores, meta: meta(false, repaired.imputed.size) };
}
