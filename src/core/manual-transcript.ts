/**
 * The manual paste fallback.
 *
 * If YouTube ever closes off in-page caption fetching, this is the path that keeps the
 * product usable: the user copies a transcript from anywhere, pastes it in, and gets a
 * Transcript with evenly distributed timings. Speech rate becomes a per-segment average
 * rather than a measurement, which degrades the pacing signal without destroying it.
 */

import { countWords, distributeWords, normalizeCues, normalizeWhitespace, tokenizeWords } from './text.ts';
import { transcriptFailure } from './types.ts';
import type { Transcript, TranscriptCue, TranscriptResult } from './types.ts';

export interface ManualTranscriptOptions {
  videoId: string;
  /** Player duration when known. Estimated from word count when not. */
  durationSec?: number;
  language?: string;
}

/** Matches `12:34`, `1:02:03`, `[00:15]`, and `(1:02:03.500)` at the start of a line. */
const TIMESTAMP_RE = /^\s*[[(]?(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?[\])]?\s*/;

/** Used only when no duration is supplied. A middling conversational pace. */
const ASSUMED_WPM = 150;

const MAX_WORDS_PER_SEGMENT = 24;
const MIN_WORDS_PER_SEGMENT = 4;

function parseTimestamp(line: string): { seconds: number; rest: string } | null {
  const match = TIMESTAMP_RE.exec(line);
  if (!match) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  if (seconds >= 60) return null;

  return {
    seconds: hours * 3600 + minutes * 60 + seconds + fraction,
    rest: line.slice(match[0].length),
  };
}

/** Splits prose into cue-sized pieces: lines, then sentences, then word runs. */
function splitIntoSegments(text: string): string[] {
  const pieces: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = normalizeWhitespace(line);
    if (!trimmed) continue;

    // Terminal punctuation is the natural boundary, but auto-generated transcripts have
    // none, so long runs fall through to a fixed word count.
    for (const sentence of trimmed.split(/(?<=[.!?…])\s+/)) {
      const tokens = sentence.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      if (tokens.length <= MAX_WORDS_PER_SEGMENT) {
        pieces.push(tokens.join(' '));
        continue;
      }
      for (let i = 0; i < tokens.length; i += MAX_WORDS_PER_SEGMENT) {
        pieces.push(tokens.slice(i, i + MAX_WORDS_PER_SEGMENT).join(' '));
      }
    }
  }

  // Fold stragglers into the previous piece so no cue is a single stray word.
  const merged: string[] = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && countWords(piece) < MIN_WORDS_PER_SEGMENT) {
      merged[merged.length - 1] = `${previous} ${piece}`;
    } else {
      merged.push(piece);
    }
  }

  return merged;
}

/** Cues laid out from explicit timestamps in the pasted text. */
function cuesFromTimestamps(
  entries: Array<{ seconds: number; text: string }>,
  durationSec: number,
): TranscriptCue[] {
  return entries.map((entry, i) => {
    const next = entries[i + 1];
    const fallbackEnd = entry.seconds + Math.max(countWords(entry.text), 1) * (60 / ASSUMED_WPM);
    const end = next ? next.seconds : Math.max(durationSec, fallbackEnd);
    return { text: entry.text, start: entry.seconds, end };
  });
}

/** Cues laid out by spreading the duration across segments in proportion to word count. */
function cuesFromWordCounts(segments: string[], durationSec: number): TranscriptCue[] {
  const weights = segments.map((segment) => Math.max(countWords(segment), 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = 0;
  return segments.map((text, i) => {
    const span = (weights[i]! / totalWeight) * durationSec;
    const start = cursor;
    cursor = i === segments.length - 1 ? durationSec : cursor + span;
    return { text, start, end: cursor };
  });
}

export function parseManualTranscript(
  input: string,
  options: ManualTranscriptOptions,
): TranscriptResult {
  const text = input.trim();
  if (!text) {
    return transcriptFailure('parse-failed', 'Paste some transcript text first.');
  }

  // Timestamped lines start a new cue; anything after one belongs to it.
  const entries: Array<{ seconds: number; text: string }> = [];
  let stamped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseTimestamp(line);
    if (parsed) {
      stamped += 1;
      entries.push({ seconds: parsed.seconds, text: normalizeWhitespace(parsed.rest) });
    } else if (entries.length > 0) {
      const last = entries[entries.length - 1]!;
      last.text = normalizeWhitespace(`${last.text} ${line}`);
    }
  }

  const useTimestamps = stamped >= 2 && entries.every((entry, i) => i === 0 || entry.seconds >= entries[i - 1]!.seconds);
  const totalWords = countWords(text);
  if (totalWords === 0) {
    return transcriptFailure('parse-failed', 'That text has no readable words in it.');
  }

  const estimatedDuration = (totalWords / ASSUMED_WPM) * 60;
  const durationSec =
    options.durationSec !== undefined && Number.isFinite(options.durationSec) && options.durationSec > 0
      ? options.durationSec
      : estimatedDuration;

  const cues = useTimestamps
    ? cuesFromTimestamps(entries.filter((entry) => entry.text.length > 0), durationSec)
    : cuesFromWordCounts(splitIntoSegments(text), durationSec);

  const withWords = cues.map((cue) => {
    const tokens = tokenizeWords(cue.text);
    const words = distributeWords(tokens, cue.start, cue.end);
    return words.length > 0 ? { ...cue, words } : cue;
  });

  const normalized = normalizeCues(withWords);
  if (normalized.length === 0) {
    return transcriptFailure('parse-failed', 'Could not turn that text into timed cues.');
  }

  const transcript: Transcript = {
    videoId: options.videoId,
    language: options.language ?? 'unknown',
    isAutoGenerated: false,
    durationSec: Math.max(durationSec, normalized[normalized.length - 1]!.end),
    cues: normalized,
    wordTimingSource: 'interpolated',
    source: 'manual',
  };

  return { ok: true, transcript };
}
