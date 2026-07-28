/**
 * Looking things up inside a finished SpeedPlan.
 *
 * Pure, and in core rather than in the player, because the heatmap overlay and the offline
 * eval harness both need to answer the same question and must answer it identically.
 */

import type { SpeedPlan, SpeedSegment } from './types.ts';

/**
 * The segment covering a moment, or null if the time falls outside the plan.
 *
 * Binary search rather than a scan. This runs on every timeupdate, about four times a
 * second, against a plan that can hold a couple of hundred segments for a long lecture.
 *
 * Segments are sorted, contiguous and non-overlapping, which the chunker guarantees and
 * Phase 1's tests assert, so the search can rely on it. A time landing exactly on a boundary
 * belongs to the segment starting there, matching the half-open convention [start, end).
 */
export function findSegmentAt(
  segments: readonly SpeedSegment[],
  time: number,
): SpeedSegment | null {
  if (segments.length === 0 || !Number.isFinite(time)) return null;

  let low = 0;
  let high = segments.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle]!;

    if (time < segment.start) high = middle - 1;
    else if (time >= segment.end) low = middle + 1;
    else return segment;
  }

  // Past the end of the last segment, clamp onto it. Caption timing and the player's own
  // duration disagree by a fraction of a second often enough that treating the final
  // moments as unplanned would drop the speed back to 1x just before the video ends.
  const last = segments[segments.length - 1]!;
  if (time >= last.end) return last;

  return null;
}

/** Convenience wrapper for callers holding a whole plan. */
export function speedAt(plan: SpeedPlan, time: number): number | null {
  return findSegmentAt(plan.segments, time)?.speed ?? null;
}
