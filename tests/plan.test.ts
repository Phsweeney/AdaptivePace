import { describe, expect, it } from 'vitest';
import { findSegmentAt, findSpanAt, speedAt } from '../src/core/plan.ts';
import type { SpeedPlan, SpeedSegment } from '../src/core/types.ts';
import { speechChunk, uniformChunks } from './support/transcripts.ts';

function segment(start: number, end: number, speed: number): SpeedSegment {
  return { start, end, speed, kind: 'speech', difficultyZ: null };
}

const segments: SpeedSegment[] = [
  segment(0, 10, 1.5),
  segment(10, 25, 1.2),
  segment(25, 40, 1.8),
  segment(40, 60, 1.0),
];

describe('findSpanAt over chunks', () => {
  it('finds the chunk covering a time', () => {
    // The popup asks this of the chunk list rather than the plan's segments, because
    // segments are consolidated and their difficulty is blended, while a rating belongs to
    // exactly one chunk.
    const chunks = uniformChunks(4, 30, 150);

    expect(findSpanAt(chunks, 0)?.id).toBe(0);
    expect(findSpanAt(chunks, 45)?.id).toBe(1);
    expect(findSpanAt(chunks, 119.9)?.id).toBe(3);
  });

  it('clamps onto the last chunk past the end', () => {
    const chunks = [speechChunk(0, 0, 30, 75), speechChunk(1, 30, 60, 75)];

    expect(findSpanAt(chunks, 90)?.id).toBe(1);
  });

  it('returns null for a time before anything starts', () => {
    expect(findSpanAt([speechChunk(0, 10, 40, 75)], 2)).toBeNull();
  });
});

describe('findSegmentAt', () => {
  it('finds the segment covering a time', () => {
    expect(findSegmentAt(segments, 5)?.speed).toBe(1.5);
    expect(findSegmentAt(segments, 17)?.speed).toBe(1.2);
    expect(findSegmentAt(segments, 39.9)?.speed).toBe(1.8);
  });

  it('treats a boundary as belonging to the segment starting there', () => {
    // Half-open [start, end). Without this the two segments either side of a boundary would
    // both claim the same instant and the player would flip between them.
    expect(findSegmentAt(segments, 10)?.speed).toBe(1.2);
    expect(findSegmentAt(segments, 25)?.speed).toBe(1.8);
  });

  it('finds the first and last segments at their extremes', () => {
    expect(findSegmentAt(segments, 0)?.speed).toBe(1.5);
    expect(findSegmentAt(segments, 59.999)?.speed).toBe(1.0);
  });

  it('clamps onto the last segment past the end of the plan', () => {
    // Caption timing and the player's own duration routinely disagree by a fraction of a
    // second. Returning null there would drop the speed to 1x just before the video ends.
    expect(findSegmentAt(segments, 60)?.speed).toBe(1.0);
    expect(findSegmentAt(segments, 120)?.speed).toBe(1.0);
  });

  it('returns null before the plan starts', () => {
    expect(findSegmentAt(segments, -1)).toBeNull();
  });

  it('returns null for an empty plan or a nonsense time', () => {
    expect(findSegmentAt([], 5)).toBeNull();
    expect(findSegmentAt(segments, Number.NaN)).toBeNull();
    expect(findSegmentAt(segments, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('agrees with a linear scan across the whole timeline', () => {
    // The binary search relies on segments being sorted and contiguous. This checks the
    // optimisation against the obvious implementation rather than trusting the invariant.
    for (let t = 0; t < 60; t += 0.25) {
      const linear = segments.find((s) => t >= s.start && t < s.end) ?? null;
      expect(findSegmentAt(segments, t)).toEqual(linear);
    }
  });
});

describe('speedAt', () => {
  it('reads the speed straight off a plan', () => {
    const plan: SpeedPlan = {
      videoId: 'x',
      policy: 'wpm',
      segments,
      meta: {
        originalDurationSec: 60,
        estimatedWatchTimeSec: 45,
        whiplash: 0.2,
        scoresImputed: 0,
      },
    };

    expect(speedAt(plan, 30)).toBe(1.8);
    expect(speedAt(plan, -5)).toBeNull();
  });
});
