import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildChunks, chapterIndexAt } from '../src/core/chunking.ts';
import { DEFAULTS } from '../src/core/types.ts';
import type { Chunk, Transcript } from '../src/core/types.ts';
import { makeTranscript } from './support/transcripts.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'fixtures');

function loadFixtures(): Array<{ name: string; transcript: Transcript }> {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      transcript: JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as Transcript,
    }));
}

const fixtures = loadFixtures();

function totalSpan(chunk: Chunk): number {
  return chunk.end - chunk.start;
}

describe('buildChunks over the captured fixtures', () => {
  // These are the guarantees the player and the overlay depend on. A hole in the timeline
  // means playback falls through to whatever speed was set last, which is the one bug class
  // that would be invisible in a unit test and obvious to a user.
  it.each(fixtures)('produces a gapless, densely numbered timeline for $name', ({ transcript }) => {
    const chunks = buildChunks(transcript, DEFAULTS);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBeCloseTo(transcript.durationSec, 6);

    chunks.forEach((chunk, i) => {
      expect(chunk.id).toBe(i);
      expect(chunk.end).toBeGreaterThan(chunk.start);
      if (i > 0) expect(chunk.start).toBeCloseTo(chunks[i - 1]!.end, 6);
    });
  });

  it.each(fixtures)('never emits a speech chunk with no words in $name', ({ transcript }) => {
    // A cue holding only "[Music]" tokenizes to zero words. Left as speech it would be sent
    // to the model for difficulty scoring and divide by zero on the way to a speech rate.
    const chunks = buildChunks(transcript, DEFAULTS);
    const empty = chunks.filter((chunk) => chunk.kind === 'speech' && chunk.wordCount === 0);
    expect(empty).toEqual([]);
  });

  it.each(fixtures)('keeps every cue inside a single chunk in $name', ({ transcript }) => {
    const chunks = buildChunks(transcript, DEFAULTS);

    for (const cue of transcript.cues) {
      const covering = chunks.filter(
        (chunk) => cue.start >= chunk.start - 1e-6 && cue.start < chunk.end + 1e-6,
      );
      expect(covering.length).toBeGreaterThan(0);
    }
  });

  it.each(fixtures)('leaves short speech chunks only where merging is barred in $name', ({
    transcript,
  }) => {
    // A chunk under the minimum is allowed to survive only when it has no speech neighbour
    // to merge into: silence on both sides, or a chapter boundary in the way.
    const chunks = buildChunks(transcript, DEFAULTS);
    const chapters = transcript.chapters ?? [];

    const unexplained = chunks.filter((chunk, i) => {
      if (chunk.kind !== 'speech' || totalSpan(chunk) >= 8) return false;
      const chapter = chapterIndexAt(chunk.start, chapters);
      const neighbours = [chunks[i - 1], chunks[i + 1]];
      return neighbours.some(
        (other) =>
          other !== undefined &&
          other.kind === 'speech' &&
          chapterIndexAt(other.start, chapters) === chapter,
      );
    });

    expect(unexplained).toEqual([]);
  });
});

describe('silence handling', () => {
  it('turns a gap of at least two seconds into its own chunk', () => {
    const transcript = makeTranscript({ cues: 6, cueSec: 4, gapSec: 3, wordsPerCue: 12 });
    const chunks = buildChunks(transcript, DEFAULTS);

    expect(chunks.some((chunk) => chunk.kind === 'silence')).toBe(true);
    for (const chunk of chunks.filter((c) => c.kind === 'silence')) {
      expect(chunk.text).toBe('');
      expect(chunk.wordCount).toBe(0);
      expect(chunk.nativeWpm).toBe(0);
    }
  });

  it('leaves a sub-threshold gap inside the surrounding speech chunk', () => {
    // A breath between sentences is not something to accelerate through.
    const transcript = makeTranscript({ cues: 6, cueSec: 4, gapSec: 1, wordsPerCue: 12 });
    const chunks = buildChunks(transcript, DEFAULTS);

    expect(chunks.every((chunk) => chunk.kind === 'speech')).toBe(true);
  });

  it('covers the lead-in and run-out with silence chunks', () => {
    const transcript = makeTranscript({ cues: 4, cueSec: 5, wordsPerCue: 15 });
    // Shift every cue later, and leave room at the end.
    transcript.cues = transcript.cues.map((cue) => ({
      ...cue,
      start: cue.start + 6,
      end: cue.end + 6,
    }));
    transcript.durationSec = 40;

    const chunks = buildChunks(transcript, DEFAULTS);

    expect(chunks[0]!.kind).toBe('silence');
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.kind).toBe('silence');
    expect(chunks[chunks.length - 1]!.end).toBe(40);
  });
});

describe('chunk sizing', () => {
  it('merges a short trailing chunk back into its neighbour', () => {
    const transcript = makeTranscript({ cues: 7, cueSec: 5, wordsPerCue: 12 });
    const chunks = buildChunks(transcript, DEFAULTS);

    for (const chunk of chunks.filter((c) => c.kind === 'speech')) {
      expect(totalSpan(chunk)).toBeGreaterThanOrEqual(8);
    }
  });

  it('never splits in the middle of a cue, even one longer than the maximum', () => {
    const transcript: Transcript = {
      videoId: 'long-cue',
      language: 'en',
      isAutoGenerated: false,
      durationSec: 60,
      cues: [{ text: 'a very long uninterrupted stretch of speech.', start: 0, end: 60 }],
      wordTimingSource: 'interpolated',
      source: 'captions',
    };

    const chunks = buildChunks(transcript, DEFAULTS);

    expect(chunks).toHaveLength(1);
    expect(totalSpan(chunks[0]!)).toBeCloseTo(60, 6);
  });
});

describe('chapter boundaries', () => {
  it('never lets a speech chunk straddle a chapter start', () => {
    const transcript = makeTranscript({
      cues: 40,
      cueSec: 3,
      wordsPerCue: 9,
      chapters: [
        { title: 'One', start: 0 },
        { title: 'Two', start: 30 },
        { title: 'Three', start: 72 },
      ],
    });

    const chunks = buildChunks(transcript, DEFAULTS);

    for (const boundary of [30, 72]) {
      const straddling = chunks.filter(
        (chunk) =>
          chunk.kind === 'speech' && chunk.start < boundary - 1e-6 && chunk.end > boundary + 1e-6,
      );
      expect(straddling).toEqual([]);
    }
  });

  it('starts a new chunk exactly at each chapter', () => {
    const transcript = makeTranscript({
      cues: 40,
      cueSec: 3,
      wordsPerCue: 9,
      chapters: [
        { title: 'One', start: 0 },
        { title: 'Two', start: 30 },
      ],
    });

    const chunks = buildChunks(transcript, DEFAULTS);
    expect(chunks.some((chunk) => Math.abs(chunk.start - 30) < 1e-6)).toBe(true);
  });
});

describe('sentence boundaries', () => {
  it('closes a chunk on terminal punctuation once past the minimum', () => {
    const transcript = makeTranscript({ cues: 30, cueSec: 4, wordsPerCue: 14, punctuate: true });
    const chunks = buildChunks(transcript, DEFAULTS);

    for (const chunk of chunks.filter((c) => c.kind === 'speech')) {
      expect(chunk.text.trim().endsWith('.')).toBe(true);
      expect(totalSpan(chunk)).toBeLessThanOrEqual(45 + 1e-6);
    }
  });

  it('time slices auto-generated captions, which carry no boundary signal', () => {
    // Auto captions have neither punctuation nor usable pauses, so chunks run to the maximum
    // and start mid sentence. This is the documented consequence, asserted here so a future
    // change to the fallback path cannot alter it unnoticed.
    const transcript = makeTranscript({
      cues: 60,
      cueSec: 2,
      wordsPerCue: 6,
      punctuate: false,
      isAutoGenerated: true,
    });

    const chunks = buildChunks(transcript, DEFAULTS);
    const speech = chunks.filter((chunk) => chunk.kind === 'speech');

    expect(speech.length).toBeGreaterThan(1);
    // Every chunk but the last is packed right up against the 45s ceiling.
    for (const chunk of speech.slice(0, -1)) {
      expect(totalSpan(chunk)).toBeGreaterThan(40);
      expect(totalSpan(chunk)).toBeLessThanOrEqual(45 + 1e-6);
    }
  });
});

describe('degenerate input', () => {
  it('returns nothing for a transcript with no cues', () => {
    const transcript = makeTranscript({ cues: 0, durationSec: 30 });
    expect(buildChunks(transcript, DEFAULTS)).toEqual([]);
  });

  it('returns nothing when the duration is zero', () => {
    const transcript = makeTranscript({ cues: 4, cueSec: 3, durationSec: 0 });
    expect(buildChunks(transcript, DEFAULTS)).toEqual([]);
  });
});
