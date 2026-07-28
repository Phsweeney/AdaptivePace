/**
 * Parser for YouTube's json3 timedtext format.
 *
 * json3 is the format worth asking for: each event carries segs[] with per-word text and
 * a tOffsetMs relative to the event start, which makes nativeWpm a measurement instead of
 * an estimate. Everything downstream is more accurate when this path succeeds.
 */

import { dropRollupDuplicates, distributeWords, normalizeCues, normalizeWhitespace, tokenizeWords } from './text.ts';
import type { TranscriptCue, TranscriptWord, WordTimingSource } from './types.ts';

export interface ParsedCues {
  cues: TranscriptCue[];
  wordTimingSource: WordTimingSource;
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  /** Marks a rollup continuation on auto-generated tracks. Carries a newline, not content. */
  aAppend?: number;
  segs?: Json3Seg[];
}

/** Fallback cue length when an event omits its duration and is the last one. */
const SECONDS_PER_WORD = 0.35;

/**
 * Below this share of single-token segments we stop calling the timings native. A caption
 * file that puts a whole sentence in one seg gives us a phrase timing that we then spread
 * across the words ourselves, which is interpolation by another name.
 */
const NATIVE_TIMING_THRESHOLD = 0.8;

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns null when the payload is not json3 at all, which the caller treats as a parse failure. */
export function parseJson3(raw: string): ParsedCues | null {
  let data: { events?: unknown };
  try {
    data = JSON.parse(raw) as { events?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(data.events)) return null;

  const events = (data.events as Json3Event[])
    .filter((event) => event.aAppend !== 1)
    .map((event) => ({
      start: toFiniteNumber(event.tStartMs),
      durationMs: toFiniteNumber(event.dDurationMs),
      segs: (event.segs ?? []).filter(
        (seg): seg is Json3Seg & { utf8: string } =>
          typeof seg.utf8 === 'string' && seg.utf8.trim().length > 0,
      ),
    }))
    .filter((event) => event.start !== null && event.segs.length > 0)
    .sort((a, b) => a.start! - b.start!);

  if (events.length === 0) return null;

  const cues: TranscriptCue[] = [];
  let singleTokenWords = 0;
  let totalWords = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const start = event.start! / 1000;
    const text = normalizeWhitespace(event.segs.map((seg) => seg.utf8).join(''));
    if (!text) continue;

    const tokenCount = tokenizeWords(text).length;
    const nextStart = events[i + 1] ? events[i + 1]!.start! / 1000 : null;
    let end = event.durationMs !== null ? start + event.durationMs / 1000 : Number.NaN;
    if (!Number.isFinite(end) || end <= start) {
      end = nextStart ?? start + Math.max(tokenCount, 1) * SECONDS_PER_WORD;
    }

    const segStarts = event.segs.map((seg) => start + (toFiniteNumber(seg.tOffsetMs) ?? 0) / 1000);
    const words: TranscriptWord[] = [];

    for (let s = 0; s < event.segs.length; s += 1) {
      const tokens = tokenizeWords(event.segs[s]!.utf8);
      if (tokens.length === 0) continue;

      const segStart = segStarts[s]!;
      const segEnd = s + 1 < segStarts.length ? Math.max(segStarts[s + 1]!, segStart) : Math.max(end, segStart);
      words.push(...distributeWords(tokens, segStart, segEnd));

      totalWords += tokens.length;
      if (tokens.length === 1) singleTokenWords += 1;
    }

    const cue: TranscriptCue = { text, start, end };
    if (words.length > 0) cue.words = words;
    cues.push(cue);
  }

  if (cues.length === 0) return null;

  const nativeShare = totalWords > 0 ? singleTokenWords / totalWords : 0;

  return {
    cues: normalizeCues(dropRollupDuplicates(cues)),
    wordTimingSource: nativeShare >= NATIVE_TIMING_THRESHOLD ? 'native' : 'interpolated',
  };
}
