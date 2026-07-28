/**
 * Turning a model's raw 1-to-10 ratings into the z-scores the pacing engine consumes.
 *
 * Two jobs, and the first one is the reason this file is longer than the arithmetic
 * justifies. Models drop entries. A request for 120 ratings comes back with 113, and the
 * seven missing ones are not an error the provider reports, they are simply absent from the
 * array. So every response is repaired before it is trusted, and a response too damaged to
 * repair is rejected outright.
 *
 * The rejection path matters more than it looks. Falling back to alpha = 0 costs the viewer
 * nothing: that is a complete, shipped, working product. A difficulty curve that is mostly
 * invented, or that came from a model refusing to discriminate, actively makes playback
 * worse than not having asked. When in doubt, throw the analysis away.
 */

import type { Chunk, DifficultyScore } from './types.ts';
import { MAX_RATING, MIN_RATING } from './prompt.ts';

/**
 * Above this fraction of invented ratings the analysis is discarded (spec 7.4.5).
 *
 * Interpolation between two real neighbours is a reasonable guess for one chunk in a run.
 * At a fifth of the video it has stopped being a repair and become a fabrication with a
 * few real data points sprinkled through it.
 */
export const MAX_IMPUTED_FRACTION = 0.2;

/**
 * Below this spread the model declined to discriminate and the analysis is discarded
 * (spec 7.4.6).
 *
 * This is not fussiness. Z-scoring divides by the standard deviation, so a response of
 * "6, 6, 6, 7, 6, 6" has its one point of variation amplified into a full standard
 * deviation of difficulty, and the viewer gets a large speed swing at a moment the model
 * had no real opinion about. Near-constant input must produce no effect, not a magnified
 * one.
 */
export const MIN_RATING_SD = 0.5;

export type RejectionReason = 'too-many-imputed' | 'no-discrimination' | 'no-ratings';

export interface RepairedRatings {
  /** One entry per scoreable chunk, in the order given. */
  ratings: Map<number, number>;
  /** Ids whose rating was interpolated rather than returned by the model. */
  imputed: Set<number>;
}

/**
 * Steps 2 to 4 of spec 7.4: discard, clamp, and fill in.
 *
 * Ids the model invented are dropped rather than trusted, because a rating for a chunk that
 * was never sent tells us the model was not tracking ids and its other answers may be
 * shifted. Missing ids are linearly interpolated from the nearest present neighbour on each
 * side, and held flat past the ends where there is only one side to work from.
 */
export function repairRatings(
  raw: ReadonlyMap<number, number>,
  chunks: readonly Chunk[],
): RepairedRatings {
  const present: Array<{ index: number; id: number; rating: number }> = [];

  chunks.forEach((chunk, index) => {
    const rating = raw.get(chunk.id);
    if (rating === undefined || !Number.isFinite(rating)) return;
    const clamped = Math.min(Math.max(Math.round(rating), MIN_RATING), MAX_RATING);
    present.push({ index, id: chunk.id, rating: clamped });
  });

  const ratings = new Map<number, number>();
  const imputed = new Set<number>();
  if (present.length === 0) return { ratings, imputed };

  let next = 0;
  chunks.forEach((chunk, index) => {
    while (next < present.length && present[next]!.index < index) next += 1;

    const after = present[next];
    if (after !== undefined && after.index === index) {
      ratings.set(chunk.id, after.rating);
      return;
    }

    const before = present[next - 1];
    imputed.add(chunk.id);

    if (before === undefined) {
      // Before the first real rating, so hold the first one flat backwards.
      ratings.set(chunk.id, after!.rating);
    } else if (after === undefined) {
      ratings.set(chunk.id, before.rating);
    } else {
      const span = after.index - before.index;
      const position = (index - before.index) / span;
      ratings.set(chunk.id, before.rating + (after.rating - before.rating) * position);
    }
  });

  return { ratings, imputed };
}

export interface QualityRejection {
  ok: false;
  reason: RejectionReason;
  /** Written for the popup to show as-is. */
  message: string;
}

export type QualityCheck = { ok: true } | QualityRejection;

/** Population standard deviation. */
function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Steps 5 and 6 of spec 7.4, deciding whether an analysis is worth using at all.
 *
 * The spread is measured plainly here rather than duration-weighted, unlike the z-scoring
 * below. That is deliberate: this gate is asking whether the model discriminated between the
 * segments it was shown, which is a property of its answer. How long each segment happens to
 * last is a property of the video and has no bearing on that question.
 */
export function checkAnalysisQuality(repaired: RepairedRatings): QualityCheck {
  const { ratings, imputed } = repaired;

  if (ratings.size === 0) {
    return {
      ok: false,
      reason: 'no-ratings',
      message: 'The model returned no usable ratings, so speed is set by speaking rate alone.',
    };
  }

  const fraction = imputed.size / ratings.size;
  if (fraction > MAX_IMPUTED_FRACTION) {
    const percent = Math.round(fraction * 100);
    return {
      ok: false,
      reason: 'too-many-imputed',
      message: `The model skipped ${percent} percent of the video, too many to fill in reliably. Speed is set by speaking rate alone.`,
    };
  }

  if (standardDeviation([...ratings.values()]) < MIN_RATING_SD) {
    return {
      ok: false,
      reason: 'no-discrimination',
      message:
        'The model rated the whole video about the same, so it has nothing to say about which parts are harder. Speed is set by speaking rate alone.',
    };
  }

  return { ok: true };
}

/**
 * The z-scores the control law consumes, one per scoreable chunk.
 *
 * Duration-weighted, because the question the z-score answers is "how hard is this passage
 * compared with the rest of this video", and a forty second stretch is twice as much of the
 * video as a twenty second one. An unweighted mean would let a run of short chunks define
 * what "average difficulty" means for a video mostly made of long ones.
 *
 * A spread of zero yields all-zero z-scores rather than a division by zero. That should not
 * be reachable, since `checkAnalysisQuality` rejects flat responses first, but the failure
 * mode if it were reachable is every chunk getting an infinite z, so it is guarded here too.
 */
export function computeZScores(
  repaired: RepairedRatings,
  chunks: readonly Chunk[],
): DifficultyScore[] {
  const rated = chunks.filter((chunk) => repaired.ratings.has(chunk.id));
  if (rated.length === 0) return [];

  const weights = rated.map((chunk) => Math.max(chunk.end - chunk.start, 0));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  // Zero-length chunks should not exist, but an equal-weight fallback is better than NaN.
  const weightAt = (index: number) => (totalWeight > 0 ? weights[index]! : 1);
  const weightSum = totalWeight > 0 ? totalWeight : rated.length;

  let mean = 0;
  rated.forEach((chunk, index) => {
    mean += repaired.ratings.get(chunk.id)! * weightAt(index);
  });
  mean /= weightSum;

  let variance = 0;
  rated.forEach((chunk, index) => {
    variance += (repaired.ratings.get(chunk.id)! - mean) ** 2 * weightAt(index);
  });
  const sd = Math.sqrt(variance / weightSum);

  return rated.map((chunk) => {
    const raw = repaired.ratings.get(chunk.id)!;
    return {
      chunkId: chunk.id,
      raw,
      z: sd > 1e-9 ? (raw - mean) / sd : 0,
      imputed: repaired.imputed.has(chunk.id),
    };
  });
}
