/**
 * A real chunked lecture, reduced to the two numbers the pacing engine actually reads.
 *
 * The options page needs to answer "what does this setting do to a video I might watch",
 * and it has to answer honestly. Rather than a formula that approximates the engine, this
 * feeds the **real** `computeSpeedPlan` a real chunk profile and reports what comes back.
 *
 * The source is `eval/fixtures/manual-lecture-J7DzL2_Na80.json`, MIT 18.06 lecture 1, run
 * through `buildChunks` at the defaults: 127 chunks, 101 speech and 26 silence, totalling
 * 39.8 minutes. Each entry is `[durationSec, nativeWpm]`, and a rate of 0 marks silence.
 * That is everything the engine looks at, so a plan built from this is the plan that video
 * would really get. About a kilobyte, which is why the whole fixture is not bundled.
 */

import type { Chunk } from '../core/types.ts';

const PROFILE: ReadonlyArray<readonly [number, number]> = [
  [8.7, 0], [38.6, 93], [2.6, 0], [7.4, 98], [1.9, 218], [3.5, 0], [21.1, 131], [22.5, 128],
  [27.4, 151], [11.3, 117], [20.2, 59], [31.3, 115], [24.4, 113], [20.1, 143], [25.6, 136],
  [3.5, 0], [22.9, 107], [23.4, 128], [23.7, 134], [28.4, 129], [21.3, 155], [22.6, 149],
  [27.2, 132], [26.7, 182], [24, 127], [24.9, 123], [21.3, 149], [25.2, 143], [4.5, 0],
  [21, 140], [11.4, 132], [2.9, 0], [29.2, 134], [21.8, 132], [21.2, 119], [23, 96], [2.6, 0],
  [1.4, 305], [2.9, 0], [22.4, 145], [3.1, 0], [21.2, 156], [21.7, 199], [22.2, 162], [3, 0],
  [3.3, 145], [2.7, 0], [20.3, 145], [26.8, 139], [12.6, 128], [2.5, 0], [7.2, 158], [2.6, 0],
  [24.2, 139], [27.2, 112], [43.3, 118], [22.3, 91], [36.3, 139], [20.2, 119], [29.3, 123],
  [25.8, 158], [23.1, 135], [21, 86], [22.5, 133], [20.4, 115], [23.7, 127], [20.8, 150],
  [22.9, 95], [21, 117], [26.8, 130], [21, 134], [20.4, 156], [21.5, 112], [3.9, 0], [23, 146],
  [12.8, 159], [3.7, 0], [20.4, 117], [16.7, 104], [2.6, 0], [33, 109], [15, 160], [2.8, 0],
  [9.2, 150], [3.6, 0], [41.2, 106], [27.4, 131], [22, 145], [24.9, 128], [31.1, 135], [2.9, 0],
  [13.7, 114], [3.1, 0], [22.3, 92], [38.7, 98], [2.7, 0], [29.2, 101], [22.8, 108], [21.8, 63],
  [24.3, 123], [22.5, 125], [30, 124], [23.7, 147], [23, 149], [2.7, 0], [12.9, 107], [2.5, 0],
  [25.8, 130], [22.9, 152], [43.2, 123], [23.1, 120], [17, 152], [2.7, 0], [23, 96], [22.4, 134],
  [20.7, 116], [29.6, 128], [2.7, 0], [20.6, 152], [22.6, 128], [21.9, 131], [21.5, 159],
  [21.8, 154], [21.7, 83], [28, 116], [29.4, 96], [7.4, 0],
];

/** Rebuilds the profile as chunks the engine will accept. */
export function referenceChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = 0;

  PROFILE.forEach(([duration, wpm], id) => {
    const start = cursor;
    cursor += duration;
    const wordCount = Math.round(wpm * (duration / 60));

    chunks.push({
      id,
      kind: wpm > 0 ? 'speech' : 'silence',
      start,
      end: cursor,
      text: wpm > 0 ? 'reference' : '',
      wordCount: wpm > 0 ? wordCount : 0,
      nativeWpm: wpm,
    });
  });

  return chunks;
}

export const REFERENCE_DURATION_SEC = PROFILE.reduce((total, [duration]) => total + duration, 0);
