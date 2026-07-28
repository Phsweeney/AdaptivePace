/**
 * Looking things up inside a finished SpeedPlan.
 *
 * Pure, and in core rather than in the player, because the heatmap overlay and the offline
 * eval harness both need to answer the same question and must answer it identically.
 */

import type { SpeedPlan, SpeedSegment } from './types.ts';

/** Anything laid out along the video's timeline: a chunk, or a planned speed segment. */
export interface TimeSpan {
  start: number;
  end: number;
}

/**
 * The span covering a moment, or null if the time falls outside them all.
 *
 * Binary search rather than a scan. This runs on every timeupdate, about four times a
 * second, against a list that can hold a couple of hundred entries for a long lecture.
 *
 * Spans are sorted, contiguous and non-overlapping, which the chunker guarantees and Phase
 * 1's tests assert, so the search can rely on it. A time landing exactly on a boundary
 * belongs to the span starting there, matching the half-open convention [start, end).
 */
export function findSpanAt<T extends TimeSpan>(spans: readonly T[], time: number): T | null {
  if (spans.length === 0 || !Number.isFinite(time)) return null;

  let low = 0;
  let high = spans.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle]!;

    if (time < span.start) high = middle - 1;
    else if (time >= span.end) low = middle + 1;
    else return span;
  }

  // Past the end of the last span, clamp onto it. Caption timing and the player's own
  // duration disagree by a fraction of a second often enough that treating the final
  // moments as unplanned would drop the speed back to 1x just before the video ends.
  const last = spans[spans.length - 1]!;
  if (time >= last.end) return last;

  return null;
}

export function findSegmentAt(
  segments: readonly SpeedSegment[],
  time: number,
): SpeedSegment | null {
  return findSpanAt(segments, time);
}

/** Convenience wrapper for callers holding a whole plan. */
export function speedAt(plan: SpeedPlan, time: number): number | null {
  return findSegmentAt(plan.segments, time)?.speed ?? null;
}
