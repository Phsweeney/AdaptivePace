import { describe, expect, it } from 'vitest';
import { checkAnalysisQuality, computeZScores, repairRatings } from '../src/core/scoring.ts';
import type { Chunk } from '../src/core/types.ts';
import { speechChunk, uniformChunks } from './support/transcripts.ts';

/** A full set of ratings, one per chunk, from a callback over the index. */
function ratingsFor(chunks: Chunk[], rate: (index: number) => number): Map<number, number> {
  return new Map(chunks.map((chunk, index) => [chunk.id, rate(index)]));
}

/** Removes a fraction of the entries, evenly spaced, the way a model drops them. */
function drop(ratings: Map<number, number>, fraction: number): Map<number, number> {
  const ids = [...ratings.keys()];
  const result = new Map(ratings);
  const step = Math.round(1 / fraction);
  ids.forEach((id, index) => {
    if (index % step === 0) result.delete(id);
  });
  return result;
}

describe('repairing a response', () => {
  it('keeps a complete response untouched and imputes nothing', () => {
    const chunks = uniformChunks(10, 30, 150);
    const repaired = repairRatings(ratingsFor(chunks, (i) => (i % 8) + 1), chunks);

    expect(repaired.imputed.size).toBe(0);
    expect(repaired.ratings.size).toBe(10);
  });

  it('discards ids that were never sent', () => {
    // A rating for a chunk that does not exist means the model was not tracking ids, so its
    // other answers may be shifted. The invented one is dropped rather than trusted.
    const chunks = uniformChunks(3, 30, 150);
    const raw = new Map([
      [0, 3],
      [1, 5],
      [2, 7],
      [99, 10],
    ]);

    const repaired = repairRatings(raw, chunks);

    expect([...repaired.ratings.keys()]).toEqual([0, 1, 2]);
  });

  it('clamps out-of-range ratings and rounds fractional ones', () => {
    const chunks = uniformChunks(4, 30, 150);
    const raw = new Map([
      [0, 0],
      [1, 42],
      [2, 6.4],
      [3, 6.6],
    ]);

    const repaired = repairRatings(raw, chunks);

    expect(repaired.ratings.get(0)).toBe(1);
    expect(repaired.ratings.get(1)).toBe(10);
    expect(repaired.ratings.get(2)).toBe(6);
    expect(repaired.ratings.get(3)).toBe(7);
  });

  it('interpolates linearly between the neighbours of a gap', () => {
    const chunks = uniformChunks(5, 30, 150);
    const raw = new Map([
      [0, 2],
      [4, 10],
    ]);

    const repaired = repairRatings(raw, chunks);

    expect(repaired.ratings.get(1)).toBeCloseTo(4, 6);
    expect(repaired.ratings.get(2)).toBeCloseTo(6, 6);
    expect(repaired.ratings.get(3)).toBeCloseTo(8, 6);
    expect([...repaired.imputed]).toEqual([1, 2, 3]);
  });

  it('holds the nearest value flat past either end', () => {
    // There is only one side to interpolate from at the ends, so the alternative to holding
    // flat is inventing a trend from a single data point.
    const chunks = uniformChunks(5, 30, 150);
    const raw = new Map([
      [1, 3],
      [3, 9],
    ]);

    const repaired = repairRatings(raw, chunks);

    expect(repaired.ratings.get(0)).toBe(3);
    expect(repaired.ratings.get(4)).toBe(9);
  });

  it('produces nothing at all from a response with no usable entries', () => {
    const chunks = uniformChunks(5, 30, 150);

    expect(repairRatings(new Map([[77, 5]]), chunks).ratings.size).toBe(0);
  });
});

describe('deciding whether to use an analysis', () => {
  it('accepts a response missing 10 percent and repairs it', () => {
    const chunks = uniformChunks(40, 30, 150);
    const raw = drop(ratingsFor(chunks, (i) => (i % 9) + 1), 0.1);

    const repaired = repairRatings(raw, chunks);

    expect(repaired.imputed.size).toBe(4);
    expect(checkAnalysisQuality(repaired).ok).toBe(true);
  });

  it('rejects a response missing 40 percent', () => {
    // A curve this invented is worse than no curve. Falling back to alpha = 0 costs nothing,
    // since speech-rate pacing is a complete product on its own.
    const chunks = uniformChunks(40, 30, 150);
    const raw = drop(ratingsFor(chunks, (i) => (i % 9) + 1), 0.4);

    const check = checkAnalysisQuality(repairRatings(raw, chunks));

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('too-many-imputed');
  });

  it('rejects a response where every rating is the same', () => {
    // Z-scoring near-constant values divides by almost nothing, turning the model's lack of
    // an opinion into large speed swings.
    const chunks = uniformChunks(20, 30, 150);
    const check = checkAnalysisQuality(repairRatings(ratingsFor(chunks, () => 6), chunks));

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('no-discrimination');
  });

  it('rejects a response that varies by one point across two chunks', () => {
    const chunks = uniformChunks(20, 30, 150);
    const raw = ratingsFor(chunks, (i) => (i < 2 ? 7 : 6));

    const check = checkAnalysisQuality(repairRatings(raw, chunks));

    expect(check.ok === false && check.reason).toBe('no-discrimination');
  });

  it('rejects an empty response', () => {
    const chunks = uniformChunks(5, 30, 150);
    const check = checkAnalysisQuality(repairRatings(new Map(), chunks));

    expect(check.ok === false && check.reason).toBe('no-ratings');
  });

  it('explains itself in a sentence fit to show a viewer', () => {
    const chunks = uniformChunks(20, 30, 150);
    const check = checkAnalysisQuality(repairRatings(ratingsFor(chunks, () => 6), chunks));

    expect(check.ok === false && check.message).toMatch(/speaking rate/);
  });
});

describe('z-scoring', () => {
  it('centres on the mean and scales by the spread', () => {
    const chunks = uniformChunks(4, 30, 150);
    const raw = new Map([
      [0, 2],
      [1, 4],
      [2, 6],
      [3, 8],
    ]);

    const scores = computeZScores(repairRatings(raw, chunks), chunks);
    const total = scores.reduce((sum, score) => sum + score.z, 0);

    expect(total).toBeCloseTo(0, 6);
    expect(scores[0]!.z).toBeLessThan(0);
    expect(scores[3]!.z).toBeGreaterThan(0);
    expect(scores.map((score) => score.raw)).toEqual([2, 4, 6, 8]);
  });

  it('weights by duration, so a long chunk counts for more than a short one', () => {
    // Three minutes of easy content and thirty seconds of hard content. The average
    // difficulty of this video is close to the easy value, not halfway between the two.
    const chunks = [
      speechChunk(0, 0, 180, 450),
      speechChunk(1, 180, 210, 75),
    ];
    const raw = new Map([
      [0, 3],
      [1, 9],
    ]);

    const scores = computeZScores(repairRatings(raw, chunks), chunks);

    expect(Math.abs(scores[0]!.z)).toBeLessThan(Math.abs(scores[1]!.z));
  });

  it('carries the imputed flag through to the scores', () => {
    const chunks = uniformChunks(5, 30, 150);
    const raw = new Map([
      [0, 2],
      [2, 6],
      [4, 10],
    ]);

    const scores = computeZScores(repairRatings(raw, chunks), chunks);

    expect(scores.filter((score) => score.imputed).map((score) => score.chunkId)).toEqual([1, 3]);
  });

  it('yields zero rather than infinity if a flat response reaches it', () => {
    // Unreachable through the quality gate, but the failure mode without the guard is every
    // chunk getting an infinite z and the plan collapsing to the speed limits.
    const chunks = uniformChunks(4, 30, 150);
    const scores = computeZScores(repairRatings(ratingsFor(chunks, () => 5), chunks), chunks);

    expect(scores.every((score) => score.z === 0)).toBe(true);
  });
});
