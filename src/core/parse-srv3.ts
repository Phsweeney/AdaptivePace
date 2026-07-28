/**
 * Parsers for the two XML timedtext formats: srv3 and the legacy default.
 *
 * These are the fallbacks for when json3 is unavailable. Both are parsed with regular
 * expressions rather than DOMParser, because src/core/ has to run unchanged in Node for
 * the eval harness. The grammar is narrow and machine-generated, which is the one
 * situation where regex parsing of XML is defensible.
 */

import {
  distributeWords,
  decodeXmlEntities,
  dropRollupDuplicates,
  normalizeCues,
  normalizeWhitespace,
  tokenizeWords,
} from './text.ts';
import type { ParsedCues } from './parse-json3.ts';
import type { TranscriptCue, TranscriptWord } from './types.ts';

const PARAGRAPH_RE = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
const SEGMENT_RE = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
const LEGACY_TEXT_RE = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
const ATTRIBUTE_RE = /([\w:-]+)="([^"]*)"/g;
const TAG_RE = /<[^>]*>/g;

const NATIVE_TIMING_THRESHOLD = 0.8;

function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_RE)) {
    attributes[match[1]!] = match[2]!;
  }
  return attributes;
}

function readNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Legacy timedtext is sometimes escaped twice, so a literal apostrophe arrives as
 * `&amp;#39;`. A second pass resolves that without corrupting text that only needed one.
 */
function decodeText(raw: string): string {
  const once = decodeXmlEntities(raw.replace(TAG_RE, ' '));
  const twice = decodeXmlEntities(once);
  return normalizeWhitespace(twice);
}

/** srv3: `<p t d>` cues containing optional `<s t>` word segments. */
export function parseSrv3(raw: string): ParsedCues | null {
  const cues: TranscriptCue[] = [];
  let singleTokenWords = 0;
  let totalWords = 0;
  let sawParagraph = false;

  for (const paragraph of raw.matchAll(PARAGRAPH_RE)) {
    sawParagraph = true;
    const attributes = readAttributes(paragraph[1] ?? '');
    const startMs = readNumber(attributes['t']);
    if (startMs === null) continue;

    const inner = paragraph[2] ?? '';
    const text = decodeText(inner);
    if (!text) continue;

    const start = startMs / 1000;
    const durationMs = readNumber(attributes['d']);
    const tokenCount = tokenizeWords(text).length;
    const end = durationMs !== null && durationMs > 0
      ? start + durationMs / 1000
      : start + Math.max(tokenCount, 1) * 0.35;

    const segments = [...inner.matchAll(SEGMENT_RE)].map((match) => ({
      offsetMs: readNumber(readAttributes(match[1] ?? '')['t']) ?? 0,
      text: decodeText(match[2] ?? ''),
    }));

    const words: TranscriptWord[] = [];
    if (segments.length > 0) {
      for (let i = 0; i < segments.length; i += 1) {
        const tokens = tokenizeWords(segments[i]!.text);
        if (tokens.length === 0) continue;

        const segStart = start + segments[i]!.offsetMs / 1000;
        const next = segments[i + 1];
        const segEnd = next ? Math.max(start + next.offsetMs / 1000, segStart) : Math.max(end, segStart);
        words.push(...distributeWords(tokens, segStart, segEnd));

        totalWords += tokens.length;
        if (tokens.length === 1) singleTokenWords += 1;
      }
    } else {
      const tokens = tokenizeWords(text);
      words.push(...distributeWords(tokens, start, end));
      totalWords += tokens.length;
    }

    const cue: TranscriptCue = { text, start, end };
    if (words.length > 0) cue.words = words;
    cues.push(cue);
  }

  if (!sawParagraph || cues.length === 0) return null;

  const nativeShare = totalWords > 0 ? singleTokenWords / totalWords : 0;

  return {
    cues: normalizeCues(dropRollupDuplicates(cues)),
    wordTimingSource: nativeShare >= NATIVE_TIMING_THRESHOLD ? 'native' : 'interpolated',
  };
}

/**
 * The default timedtext response: `<text start dur>` with no word-level timing at all.
 * Cue duration is spread across the words, so nativeWpm becomes a per-cue average.
 */
export function parseLegacyTimedText(raw: string): ParsedCues | null {
  const cues: TranscriptCue[] = [];

  for (const match of raw.matchAll(LEGACY_TEXT_RE)) {
    const attributes = readAttributes(match[1] ?? '');
    const start = readNumber(attributes['start']);
    if (start === null) continue;

    const text = decodeText(match[2] ?? '');
    if (!text) continue;

    const duration = readNumber(attributes['dur']);
    const tokens = tokenizeWords(text);
    const end = duration !== null && duration > 0
      ? start + duration
      : start + Math.max(tokens.length, 1) * 0.35;

    const cue: TranscriptCue = { text, start, end };
    const words = distributeWords(tokens, start, end);
    if (words.length > 0) cue.words = words;
    cues.push(cue);
  }

  if (cues.length === 0) return null;

  return {
    cues: normalizeCues(dropRollupDuplicates(cues)),
    wordTimingSource: 'interpolated',
  };
}

/** Tries srv3 first, then the legacy shape, so the caller does not have to guess. */
export function parseTimedTextXml(raw: string): ParsedCues | null {
  return parseSrv3(raw) ?? parseLegacyTimedText(raw);
}
