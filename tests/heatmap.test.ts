import { describe, expect, it } from 'vitest';
import {
  bandColor,
  buildHeatBands,
  describeBand,
  gradientCss,
  heatMode,
  SILENCE_COLOR,
  viridis,
} from '../src/core/heatmap.ts';
import { DEFAULTS } from '../src/core/types.ts';
import type {
  Chunk,
  DifficultyScore,
  PacingSettings,
  SpeedPlan,
  SpeedSegment,
} from '../src/core/types.ts';
import { silenceChunk, speechChunk } from './support/transcripts.ts';

const settings: PacingSettings = DEFAULTS;

function score(chunkId: number, raw: number, z: number, imputed = false): DifficultyScore {
  return { chunkId, raw, z, imputed };
}

function planOf(...segments: SpeedSegment[]): SpeedPlan {
  return {
    videoId: 'synthetic',
    policy: 'wpm+llm',
    segments,
    meta: {
      originalDurationSec: segments.at(-1)?.end ?? 0,
      estimatedWatchTimeSec: 0,
      whiplash: 0,
      scoresImputed: 0,
    },
  };
}

function segment(start: number, end: number, speed: number): SpeedSegment {
  return { start, end, speed, kind: 'speech', difficultyZ: null };
}

/** Rough perceived brightness, enough to assert the ramp only ever gets lighter. */
function luminance(color: string): number {
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('viridis', () => {
  it('runs from dark blue to yellow', () => {
    expect(viridis(0)).toBe('#440154');
    expect(viridis(1)).toBe('#fde725');
  });

  it('clamps outside 0 to 1', () => {
    expect(viridis(-3)).toBe(viridis(0));
    expect(viridis(4)).toBe(viridis(1));
    // A z-score arriving as NaN should colour something rather than throw.
    expect(viridis(Number.NaN)).toBe(viridis(0));
  });

  it('always produces a six digit hex colour', () => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      expect(viridis(t)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('gets monotonically lighter', () => {
    // This is the property that makes the ribbon readable in greyscale and to a colourblind
    // viewer: "brighter means harder" holds without the hue carrying any of the meaning.
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = luminance(viridis(t));
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe('heatMode', () => {
  it('shows difficulty only when there are scores and alpha is not zero', () => {
    expect(heatMode([score(0, 5, 0)], settings)).toBe('difficulty');
  });

  it('falls back to speed without scores', () => {
    expect(heatMode(null, settings)).toBe('speed');
  });

  it('falls back to speed at alpha zero, because the plan ignored the scores too', () => {
    expect(heatMode([score(0, 5, 0)], { ...settings, alpha: 0 })).toBe('speed');
  });
});

describe('buildHeatBands', () => {
  const chunks: Chunk[] = [
    speechChunk(0, 0, 30, 100),
    silenceChunk(1, 30, 35),
    speechChunk(2, 35, 65, 100),
  ];

  const plan = planOf(segment(0, 30, 1.2), segment(30, 35, 3), segment(35, 65, 1.6));

  it('emits one contiguous band per chunk', () => {
    const bands = buildHeatBands(chunks, null, plan, settings);

    expect(bands).toHaveLength(3);
    expect(bands.map((band) => [band.start, band.end])).toEqual([
      [0, 30],
      [30, 35],
      [35, 65],
    ]);
  });

  it('takes the speed from the segment covering the chunk', () => {
    const bands = buildHeatBands(chunks, null, plan, settings);
    expect(bands.map((band) => band.speed)).toEqual([1.2, 3, 1.6]);
  });

  it('falls back to 1x with no plan', () => {
    const bands = buildHeatBands(chunks, null, null, settings);
    expect(bands.every((band) => band.speed === 1)).toBe(true);
  });

  it('draws silence off the ramp', () => {
    const bands = buildHeatBands(chunks, [score(0, 5, 0), score(2, 9, 1.5)], plan, settings);

    expect(bands[1]!.value).toBeNull();
    expect(bandColor(bands[1]!)).toBe(SILENCE_COLOR);
  });

  describe('difficulty mode', () => {
    it('centres a z of zero and saturates at plus or minus two', () => {
      const scores = [score(0, 5, 0), score(2, 10, 9)];
      const bands = buildHeatBands(chunks, scores, plan, settings);

      expect(bands[0]!.value).toBeCloseTo(0.5);
      // Clamped rather than stretched, so a colour means the same thing on every video.
      expect(bands[2]!.value).toBe(1);

      const low = buildHeatBands(chunks, [score(0, 1, -9)], plan, settings);
      expect(low[0]!.value).toBe(0);
    });

    it('carries the rating the model actually gave for that chunk', () => {
      const bands = buildHeatBands(chunks, [score(0, 7, 1, true)], plan, settings);

      expect(bands[0]!.raw).toBe(7);
      expect(bands[0]!.z).toBe(1);
      expect(bands[0]!.imputed).toBe(true);
    });

    it('centres a speech chunk the model returned nothing for', () => {
      const bands = buildHeatBands(chunks, [score(0, 5, 1)], plan, settings);

      expect(bands[2]!.raw).toBeNull();
      expect(bands[2]!.value).toBeCloseTo(0.5);
    });
  });

  describe('speed mode', () => {
    const bare = { ...settings, alpha: 0 };

    it('puts the slow end of the range at the bright end of the ramp', () => {
      const one = [speechChunk(0, 0, 30, 100)];

      const slowest = buildHeatBands(one, null, planOf(segment(0, 30, bare.minSpeed)), bare);
      const fastest = buildHeatBands(one, null, planOf(segment(0, 30, bare.maxSpeed)), bare);

      expect(slowest[0]!.value).toBe(1);
      expect(fastest[0]!.value).toBe(0);
    });

    it('reports no rating even when scores exist', () => {
      // alpha is zero, so the plan ignored these. Showing them would claim the colours came
      // from the model when the ribbon is drawn from speed.
      const bands = buildHeatBands(chunks, [score(0, 9, 2)], plan, bare);

      expect(bands[0]!.raw).toBeNull();
      expect(bands[0]!.z).toBeNull();
      expect(bands[0]!.imputed).toBe(false);
    });

    it('is brighter where the video is slower', () => {
      const bands = buildHeatBands(chunks, null, plan, bare);
      expect(bands[0]!.value!).toBeGreaterThan(bands[2]!.value!);
    });
  });
});

describe('gradientCss', () => {
  const chunks: Chunk[] = [
    speechChunk(0, 0, 30, 100),
    speechChunk(1, 30, 60, 100),
    speechChunk(2, 60, 100, 100),
  ];
  const scores = [score(0, 1, -1.5), score(1, 5, 0), score(2, 10, 1.5)];
  const bands = buildHeatBands(chunks, scores, null, settings);

  it('repeats every colour so the bands stay hard edged', () => {
    const css = gradientCss(bands, 100);

    for (const band of bands) {
      const color = bandColor(band);
      expect(css.split(color).length - 1).toBe(2);
    }
  });

  it('lays the stops out in order inside 0 to 100 percent', () => {
    const css = gradientCss(bands, 100);
    const percents = [...css.matchAll(/([\d.]+)%/g)].map((match) => Number(match[1]));

    expect(percents.length).toBe(bands.length * 2);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
    }
    expect(percents[0]).toBe(0);
    expect(percents.every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('stretches the last band to the end of the bar', () => {
    // The player holds the final segment's speed past the end of the captions, because
    // findSpanAt clamps onto the last span. The ribbon shows what actually happens.
    expect(gradientCss(bands, 140)).toContain('100.000%');
  });

  it('draws nothing without bands or a duration', () => {
    expect(gradientCss([], 100)).toBe('none');
    expect(gradientCss(bands, 0)).toBe('none');
    expect(gradientCss(bands, Number.NaN)).toBe('none');
  });
});

describe('describeBand', () => {
  const chunks: Chunk[] = [speechChunk(0, 0, 30, 100), silenceChunk(1, 30, 35)];
  const plan = planOf(segment(0, 30, 1.15), segment(30, 35, 3));

  const bandsFor = (scores: DifficultyScore[] | null, pacing: PacingSettings = settings) =>
    buildHeatBands(chunks, scores, plan, pacing);

  it('names the rating and the speed', () => {
    expect(describeBand(bandsFor([score(0, 8, 1.2)])[0]!)).toBe('hard (8/10) - 1.15x');
    expect(describeBand(bandsFor([score(0, 2, -1.2)])[0]!)).toBe('easy (2/10) - 1.15x');
    expect(describeBand(bandsFor([score(0, 10, 2)])[0]!)).toBe('very hard (10/10) - 1.15x');
  });

  it('admits when a rating was filled in rather than returned', () => {
    expect(describeBand(bandsFor([score(0, 6, 0, true)])[0]!)).toBe(
      'moderate (6/10) - 1.15x (estimated)',
    );
  });

  it('falls back to the speech rate when there is no analysis', () => {
    expect(describeBand(bandsFor(null)[0]!)).toBe('200 wpm - 1.15x');
  });

  it('calls a pause a pause', () => {
    expect(describeBand(bandsFor([score(0, 8, 1.2)])[1]!)).toBe('pause - 3.00x');
  });
});
