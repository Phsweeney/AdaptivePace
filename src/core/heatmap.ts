/**
 * Turning a rated video into the colours drawn along the progress bar.
 *
 * All of the arithmetic and string building for the overlay lives here rather than beside the
 * DOM code, for the usual reason: this is pure, so it runs in Node and can be tested without a
 * browser. `src/content/overlay.ts` is left with nothing but element handling.
 *
 * The one rule that matters in this file: **bands are built from chunks, never from the plan's
 * segments.** Consolidation merges adjacent segments and duration-blends their difficulty, so a
 * segment can report a z-score no model ever produced. That is correct for driving playback and
 * wrong for drawing a picture of what the model said. Chunks are what the model saw; segments
 * are what the player plays.
 */

import { findSegmentAt } from './plan.ts';
import { MAX_RATING } from './prompt.ts';
import type { Chunk, ChunkKind, DifficultyScore, PacingSettings, SpeedPlan } from './types.ts';

/**
 * How far out on the z-axis the ramp is spread before it saturates.
 *
 * Scores are z-scored within a single video, so the spread is whatever that video happened to
 * produce. Fixing the ends at +/- 2 rather than at the video's own min and max means the colour
 * of a band means the same thing on every video, and a video the model found uniformly easy
 * looks uniformly easy instead of being stretched to fill the whole ramp.
 */
export const Z_RANGE = 2;

/**
 * Neutral grey for silence, which is not on the ramp at all.
 *
 * A pause carries no words, so it has no difficulty to show and no speed worth comparing: it
 * plays at the fixed silence speed, which is deliberately above `maxSpeed` and would peg the
 * end of the ramp on every video. Painting it off-ramp also makes the pauses legible as pauses,
 * which is useful in itself.
 */
export const SILENCE_COLOR = '#4a4a4a';

/**
 * Colourblind-safe ramp, sampled from matplotlib's viridis at eight intervals.
 *
 * Spec 8.1 rules out red-green explicitly. Viridis is monotonic in perceived lightness as well
 * as in hue, so the ribbon still reads correctly in greyscale and to a colourblind viewer, and
 * "brighter" unambiguously means "harder" without relying on hue at all.
 */
const VIRIDIS: ReadonlyArray<readonly [number, number, number]> = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 73, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [110, 206, 88],
  [253, 231, 37],
];

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function hex(channel: number): string {
  return clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0');
}

/** The ramp colour at `t`, which is clamped into 0..1. Dark blue at 0, yellow at 1. */
export function viridis(t: number): string {
  const position = clamp(Number.isFinite(t) ? t : 0, 0, 1) * (VIRIDIS.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, VIRIDIS.length - 1);
  const fraction = position - low;

  const a = VIRIDIS[low]!;
  const b = VIRIDIS[high]!;

  return `#${hex(a[0] + (b[0] - a[0]) * fraction)}${hex(a[1] + (b[1] - a[1]) * fraction)}${hex(
    a[2] + (b[2] - a[2]) * fraction,
  )}`;
}

/** One chunk's worth of ribbon, plus everything the hover chip needs to describe it. */
export interface HeatBand {
  start: number;
  end: number;
  kind: ChunkKind;
  /** Position on the ramp, 0 to 1. Null for silence, which is drawn off-ramp. */
  value: number | null;
  /** The speed the plan holds here. */
  speed: number;
  /** The model's 1-10 rating, or null when there is no analysis. */
  raw: number | null;
  z: number | null;
  imputed: boolean;
  nativeWpm: number;
}

/**
 * What the colour means.
 *
 * 'difficulty' whenever there is an analysis to draw, 'speed' otherwise. Spec 8.1 asks for the
 * fallback because alpha = 0 is a complete product rather than a degraded one, and a viewer
 * running without a key should still get a picture of what the extension is doing to their
 * video.
 *
 * The condition is deliberately identical to `useScores` in `computeSpeedPlan`. If the two ever
 * disagreed the ribbon would claim to show difficulty on a plan that ignored it.
 */
export type HeatMode = 'difficulty' | 'speed';

export function heatMode(
  scores: DifficultyScore[] | null,
  settings: PacingSettings,
): HeatMode {
  return scores !== null && settings.alpha !== 0 ? 'difficulty' : 'speed';
}

/** Normalizes a speed onto 0..1, inverted, in log space. Slower is a higher value. */
function speedValue(speed: number, settings: PacingSettings): number {
  const { minSpeed, maxSpeed } = settings;
  if (!(speed > 0) || !(minSpeed > 0) || !(maxSpeed > minSpeed)) return 0.5;

  const span = Math.log(maxSpeed) - Math.log(minSpeed);
  const position = (Math.log(speed) - Math.log(minSpeed)) / span;
  return 1 - clamp(position, 0, 1);
}

/**
 * One band per chunk, in order, contiguous because chunks are.
 *
 * Both modes point the ramp the same way: bright means "this needs your attention". In
 * difficulty mode that is a high z-score. In speed mode it is a low speed, which is why the
 * normalization is inverted. Keeping the two consistent matters because the ribbon switches
 * from one to the other partway through a video, the moment the analysis returns.
 */
export function buildHeatBands(
  chunks: readonly Chunk[],
  scores: DifficultyScore[] | null,
  plan: SpeedPlan | null,
  settings: PacingSettings,
): HeatBand[] {
  const mode = heatMode(scores, settings);

  const byChunkId = new Map<number, DifficultyScore>();
  for (const score of scores ?? []) byChunkId.set(score.chunkId, score);

  return chunks.map((chunk) => {
    // The chunk's start rather than its midpoint: segment boundaries fall on chunk boundaries,
    // so the start is inside this chunk's own segment by construction.
    const speed = plan === null ? 1 : findSegmentAt(plan.segments, chunk.start)?.speed ?? 1;
    const score =
      mode === 'difficulty' && chunk.kind === 'speech'
        ? byChunkId.get(chunk.id) ?? null
        : null;

    let value: number | null;
    if (chunk.kind === 'silence') value = null;
    else if (mode === 'difficulty') {
      // A speech chunk with no score in difficulty mode sits at the middle of the ramp, which
      // is where z = 0 lands anyway. Imputed scores arrive with a real z and are not this case.
      value = (clamp(score?.z ?? 0, -Z_RANGE, Z_RANGE) + Z_RANGE) / (2 * Z_RANGE);
    } else value = speedValue(speed, settings);

    return {
      start: chunk.start,
      end: chunk.end,
      kind: chunk.kind,
      value,
      speed,
      raw: score?.raw ?? null,
      z: score?.z ?? null,
      imputed: score?.imputed ?? false,
      nativeWpm: chunk.nativeWpm,
    };
  });
}

export function bandColor(band: HeatBand): string {
  return band.value === null ? SILENCE_COLOR : viridis(band.value);
}

/**
 * The ribbon as a CSS background.
 *
 * Every colour is emitted at both its start and its end percentage. That is what makes the
 * bands read as discrete blocks: without the repeat, CSS interpolates between neighbouring
 * stops and the whole thing blurs into a smear that shows nothing.
 *
 * Being percentage based also means the ribbon is resolution independent, so a resize, a
 * theater-mode toggle or a jump to fullscreen needs no redraw at all.
 *
 * The last band is stretched to 100%. It is not decoration: `findSpanAt` clamps a time past the
 * final span onto it, so the player really does hold that speed through to the end of the
 * video, and the ribbon should show what actually happens.
 */
export function gradientCss(bands: readonly HeatBand[], durationSec: number): string {
  if (bands.length === 0 || !(durationSec > 0)) return 'none';

  const pct = (time: number): string =>
    `${clamp((time / durationSec) * 100, 0, 100).toFixed(3)}%`;

  const stops: string[] = [];
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i]!;
    const color = bandColor(band);
    stops.push(`${color} ${pct(band.start)}`);
    stops.push(`${color} ${i === bands.length - 1 ? '100.000%' : pct(band.end)}`);
  }

  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Coarse word for a rating, so the chip says something before you read the number. */
function ratingLabel(raw: number): string {
  if (raw <= 3) return 'easy';
  if (raw <= 6) return 'moderate';
  if (raw <= 8) return 'hard';
  return 'very hard';
}

/** What the hover chip says about one band. */
export function describeBand(band: HeatBand): string {
  const speed = `${band.speed.toFixed(2)}x`;

  if (band.kind === 'silence') return `pause - ${speed}`;

  if (band.raw === null) return `${Math.round(band.nativeWpm)} wpm - ${speed}`;

  const rating = `${ratingLabel(band.raw)} (${band.raw}/${MAX_RATING}) - ${speed}`;
  return band.imputed ? `${rating} (estimated)` : rating;
}
