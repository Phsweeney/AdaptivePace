/**
 * Turning chunks into the playback speed for each moment of a video.
 *
 * The whole engine is one idea: play every passage at the speed that delivers words to the
 * viewer at their chosen rate, then slow down further wherever the content is harder than
 * this video's own average.
 *
 *     ln(s_i) = ln(R) - ln(r_i) - alpha * z_i
 *
 * The arithmetic happens in log space so that speeding up and slowing down are symmetric.
 * 1.5x and 0.667x are the same size of change to a listener, but 0.5 apart and 0.333 apart
 * as plain numbers, so averaging or smoothing raw multipliers would quietly bias everything
 * toward speeding up.
 *
 * alpha is the only trust knob. At alpha = 0 this is pure speech-rate normalization, needs
 * no API key, and is a complete working product. That is also the baseline the LLM layer has
 * to beat in the eval, so it must stand on its own.
 */

import { chapterIndexAt } from './chunking.ts';
import type {
  Chunk,
  DifficultyScore,
  Policy,
  Settings,
  SpeedPlan,
  SpeedSegment,
  Transcript,
} from './types.ts';

/**
 * Bounds on the measured speech rate before it is used as a divisor.
 *
 * Without this a chunk of four words over nine seconds reads as 27 wpm and demands eight
 * times speed. The clamp is on the input rather than only on the output because the final
 * speed clamp cannot tell a genuinely fast passage from a divide-by-almost-nothing.
 */
const MIN_NATIVE_WPM = 90;
const MAX_NATIVE_WPM = 260;

/** Speed differences below this are imperceptible and not worth a transition. */
const MERGE_LOG_THRESHOLD = Math.log(1.05);

/**
 * Hard ceiling for silence, which `maxSpeed` deliberately does not govern.
 *
 * `maxSpeed` exists because speech stops being intelligible above roughly 2.5x. That reason
 * does not apply to a pause: there is nothing to fail to understand. Clamping silence to
 * `maxSpeed` would make the default configuration incapable of the 3x pause the whole
 * silence mechanism exists to deliver, since the default `silenceSpeed` is 3 and the default
 * `maxSpeed` is 2.5. This ceiling is a sanity bound on a user-supplied setting rather than a
 * perceptual limit; past about 4x a pause is already gone.
 */
const MAX_SILENCE_SPEED = 4;

const EPSILON = 1e-9;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Puts a speed on the settings grid.
 *
 * The rounding to six places is not cosmetic. `Math.round(2.1 / 0.05) * 0.05` is
 * 2.1000000000000005, which fails an equality check against the grid and shows up as
 * 2.1000000000000005x in any UI that formats the raw number.
 */
function quantize(speed: number, settings: Settings, ceiling = settings.maxSpeed): number {
  const { minSpeed, speedStep } = settings;
  const bounded = clamp(speed, minSpeed, ceiling);
  if (!(speedStep > 0)) return bounded;

  const snapped = Math.round(bounded / speedStep) * speedStep;
  // Snapping can land just outside the range, so the clamp is applied again afterwards.
  return clamp(Number(snapped.toFixed(6)), minSpeed, ceiling);
}

/** Silence is quantized against its own ceiling rather than the speech one. */
function quantizeSilence(settings: Settings): number {
  return quantize(settings.silenceSpeed, settings, MAX_SILENCE_SPEED);
}

/** Duration-weighted mean of two speeds, taken in log space for the reason above. */
function blendSpeeds(a: SpeedSegment, b: SpeedSegment): number {
  const dA = Math.max(a.end - a.start, 0);
  const dB = Math.max(b.end - b.start, 0);
  const total = dA + dB;
  if (total <= 0) return a.speed;
  return Math.exp((Math.log(a.speed) * dA + Math.log(b.speed) * dB) / total);
}

function blendZ(a: SpeedSegment, b: SpeedSegment): number | null {
  if (a.difficultyZ === null) return b.difficultyZ;
  if (b.difficultyZ === null) return a.difficultyZ;
  const dA = Math.max(a.end - a.start, 0);
  const dB = Math.max(b.end - b.start, 0);
  const total = dA + dB;
  if (total <= 0) return a.difficultyZ;
  return (a.difficultyZ * dA + b.difficultyZ * dB) / total;
}

/**
 * Step 1: the raw speed for each chunk before any shaping.
 *
 * Silence sits outside the speech-rate math entirely. A pause carries no words, so there is
 * nothing to normalize; it simply plays at the configured silence speed.
 */
function rawLogSpeeds(
  chunks: readonly Chunk[],
  zByChunkId: Map<number, number>,
  settings: Settings,
  useScores: boolean,
): number[] {
  const logTarget = Math.log(settings.targetWpm);
  const logSilence = Math.log(settings.silenceSpeed);

  return chunks.map((chunk) => {
    if (chunk.kind === 'silence') return logSilence;

    const rate = clamp(chunk.nativeWpm, MIN_NATIVE_WPM, MAX_NATIVE_WPM);
    const z = useScores ? zByChunkId.get(chunk.id) ?? 0 : 0;
    return logTarget - Math.log(rate) - settings.alpha * z;
  });
}

/**
 * Step 2: Gaussian smoothing across speech chunks.
 *
 * Without this the speed changes at every chunk boundary and the result is unwatchable. The
 * average is duration-weighted so a long chunk is not outvoted by the short ones around it.
 *
 * Silence is excluded from both sides of the sum. Its speed is fixed and much higher than
 * any speech speed, so letting it into the average would drag the speech around it upward
 * for no reason. It is reinserted untouched afterwards.
 *
 * Chapter boundaries zero the weight. A chapter change is a change of subject, and carrying
 * the pace of the previous topic across it is exactly the thing chapters tell us not to do.
 */
function smooth(
  chunks: readonly Chunk[],
  logSpeeds: readonly number[],
  chapterOf: readonly number[],
  settings: Settings,
): number[] {
  const sigma = settings.smoothingWindowSec / 2;
  if (!(sigma > 0)) return [...logSpeeds];

  const twoSigmaSquared = 2 * sigma * sigma;
  const speech: number[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i]!.kind === 'speech') speech.push(i);
  }

  const midpoint = chunks.map((chunk) => (chunk.start + chunk.end) / 2);
  const duration = chunks.map((chunk) => Math.max(chunk.end - chunk.start, 0));
  const result = [...logSpeeds];

  for (const i of speech) {
    let weighted = 0;
    let total = 0;

    for (const j of speech) {
      if (chapterOf[i] !== chapterOf[j]) continue;
      const delta = midpoint[i]! - midpoint[j]!;
      const weight = Math.exp(-(delta * delta) / twoSigmaSquared) * duration[j]!;
      weighted += weight * logSpeeds[j]!;
      total += weight;
    }

    if (total > EPSILON) result[i] = weighted / total;
  }

  return result;
}

/**
 * Step 4: collapse the plan into as few segments as the shaping rules allow.
 *
 * Two rules, applied until nothing more changes. Adjacent speech whose speeds are within
 * five percent becomes one segment, because the viewer cannot hear the difference and the
 * transition is pure cost. Any speech segment shorter than the dwell time is absorbed by the
 * neighbour it is closest to in speed, because a correct speed held for two seconds is worse
 * than a slightly wrong one held long enough to settle.
 *
 * Silence is exempt from the dwell rule and never merges with speech. A three second pause
 * at triple speed is the single most valuable thing this engine does, and the dwell rule
 * would otherwise dissolve every one of them.
 */
function consolidate(segments: SpeedSegment[], settings: Settings): SpeedSegment[] {
  const result = [...segments];

  const mergeAt = (index: number, other: number): void => {
    const low = Math.min(index, other);
    const a = result[low]!;
    const b = result[low + 1]!;
    result.splice(low, 2, {
      start: a.start,
      end: b.end,
      speed: quantize(blendSpeeds(a, b), settings),
      kind: 'speech',
      difficultyZ: blendZ(a, b),
    });
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < result.length - 1; i += 1) {
      const a = result[i]!;
      const b = result[i + 1]!;
      if (a.kind !== 'speech' || b.kind !== 'speech') continue;
      if (Math.abs(Math.log(a.speed) - Math.log(b.speed)) >= MERGE_LOG_THRESHOLD) continue;
      mergeAt(i, i + 1);
      changed = true;
      break;
    }
    if (changed) continue;

    for (let i = 0; i < result.length; i += 1) {
      const segment = result[i]!;
      if (segment.kind !== 'speech') continue;
      if (segment.end - segment.start >= settings.minDwellSec) continue;

      const previous = result[i - 1];
      const next = result[i + 1];
      const previousGap =
        previous?.kind === 'speech'
          ? Math.abs(Math.log(previous.speed) - Math.log(segment.speed))
          : Infinity;
      const nextGap =
        next?.kind === 'speech'
          ? Math.abs(Math.log(next.speed) - Math.log(segment.speed))
          : Infinity;

      // Both neighbours silence means there is nothing to merge into. The segment stays
      // short, which is correct: it is a genuine island of speech between two pauses.
      if (previousGap === Infinity && nextGap === Infinity) continue;

      mergeAt(i, previousGap <= nextGap ? i - 1 : i + 1);
      changed = true;
      break;
    }
  }

  return result;
}

/**
 * Builds the speed plan for a chunked transcript.
 *
 * The transcript is passed alongside the chunks because the plan needs three things a
 * `Chunk[]` cannot supply on its own: the video id, the original duration, and the chapter
 * boundaries that smoothing must not cross. The alternative would be widening `Chunk` with
 * a chapter field, which would put a field in the LLM cache key that has nothing to do with
 * chunk identity.
 *
 * `scores` are expected to be z-scored already; producing them is the difficulty layer's
 * job. Passing null, or setting alpha to 0, yields the pure speech-rate plan.
 */
export function computeSpeedPlan(
  transcript: Transcript,
  chunks: readonly Chunk[],
  scores: DifficultyScore[] | null,
  settings: Settings,
): SpeedPlan {
  const useScores = scores !== null && settings.alpha !== 0;
  const policy: Policy = useScores ? 'wpm+llm' : 'wpm';
  const originalDurationSec = transcript.durationSec;

  if (chunks.length === 0) {
    return {
      videoId: transcript.videoId,
      policy,
      segments: [],
      meta: {
        originalDurationSec,
        estimatedWatchTimeSec: 0,
        whiplash: 0,
        scoresImputed: 0,
      },
    };
  }

  const zByChunkId = new Map<number, number>();
  for (const score of scores ?? []) zByChunkId.set(score.chunkId, score.z);

  const chapters = transcript.chapters ?? [];
  const chapterOf = chunks.map((chunk) => chapterIndexAt(chunk.start, chapters));

  const raw = rawLogSpeeds(chunks, zByChunkId, settings, useScores);
  const smoothed = smooth(chunks, raw, chapterOf, settings);

  const initial: SpeedSegment[] = chunks.map((chunk, i) => ({
    start: chunk.start,
    end: chunk.end,
    speed:
      chunk.kind === 'silence'
        ? quantizeSilence(settings)
        : quantize(Math.exp(smoothed[i]!), settings),
    kind: chunk.kind,
    difficultyZ:
      useScores && chunk.kind === 'speech' ? zByChunkId.get(chunk.id) ?? null : null,
  }));

  const segments = consolidate(initial, settings);

  let estimatedWatchTimeSec = 0;
  for (const segment of segments) {
    estimatedWatchTimeSec += (segment.end - segment.start) / segment.speed;
  }

  let totalChange = 0;
  for (let i = 0; i < segments.length - 1; i += 1) {
    totalChange += Math.abs(Math.log(segments[i + 1]!.speed) - Math.log(segments[i]!.speed));
  }
  const minutes = originalDurationSec / 60;
  const whiplash = minutes > 0 ? totalChange / minutes : 0;

  return {
    videoId: transcript.videoId,
    policy,
    segments,
    meta: {
      originalDurationSec,
      estimatedWatchTimeSec,
      whiplash,
      scoresImputed: (scores ?? []).filter((score) => score.imputed).length,
    },
  };
}
