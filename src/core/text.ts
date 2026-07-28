/**
 * Text and cue normalization shared by every transcript source.
 *
 * The parsers hand back cues that are only as clean as the caption file was, and caption
 * files are not clean: auto-generated tracks emit rolling duplicates and overlapping
 * timings, manual tracks contain sound annotations and speaker markers. Downstream
 * chunking assumes cues are sorted, non-overlapping, and non-empty, so that guarantee is
 * established once, here.
 */

import type { TranscriptCue, TranscriptWord } from './types.ts';

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the named and numeric entities that appear in timedtext XML. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return XML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Splits into countable words.
 *
 * Bracketed annotations go first. [Music] and [APPLAUSE] are events, not speech, and a
 * cue that is nothing but an annotation would otherwise report a handful of words spread
 * over a long span and drag nativeWpm down with it. Parentheses are left alone because
 * spoken mathematics uses them for real.
 *
 * What remains must contain a letter or a digit to count, which drops the chevron speaker
 * markers and stray punctuation that some tracks use heavily.
 */
export function tokenizeWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && /[\p{L}\p{N}]/u.test(token));
}

export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

/**
 * Spreads a time span evenly across tokens. Used when a caption format gives timing for a
 * phrase rather than for each word, and for the manual paste path where there is no
 * timing information at all.
 */
export function distributeWords(tokens: string[], start: number, end: number): TranscriptWord[] {
  if (tokens.length === 0) return [];
  const span = Math.max(end - start, 0);
  const step = span / tokens.length;

  return tokens.map((text, i) => ({
    text,
    start: start + step * i,
    end: i === tokens.length - 1 ? start + span : start + step * (i + 1),
  }));
}

function clampWords(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
  let cursor = start;
  return words.map((word) => {
    const wordStart = Math.min(Math.max(word.start, cursor), end);
    const wordEnd = Math.min(Math.max(word.end, wordStart), end);
    cursor = wordEnd;
    return { text: word.text, start: wordStart, end: wordEnd };
  });
}

/**
 * Removes rollup repeats from auto-generated tracks.
 *
 * Auto-captions scroll: a line is emitted, then re-emitted with the next line appended, so
 * naive parsing counts the same words several times and inflates nativeWpm. The trigger is
 * deliberately narrow. A cue is dropped only when its text is identical to the previous
 * cue's and its span overlaps that cue, which a genuine repeated phrase later in the video
 * never satisfies.
 */
export function dropRollupDuplicates(cues: TranscriptCue[]): TranscriptCue[] {
  const result: TranscriptCue[] = [];

  for (const cue of cues) {
    const previous = result[result.length - 1];
    const isRollup =
      previous !== undefined &&
      normalizeWhitespace(previous.text) === normalizeWhitespace(cue.text) &&
      cue.start < previous.end;
    if (!isRollup) result.push(cue);
  }

  return result;
}

/**
 * Sorts cues, drops the empty ones, and removes overlap by truncating a cue at the start
 * of the one that follows it.
 *
 * Truncating rather than dropping matters for auto-generated tracks, where consecutive
 * cues legitimately overlap by design as lines roll up the screen. The words are already
 * deduplicated by the parser; only the displayed spans overlap.
 */
export function normalizeCues(cues: TranscriptCue[]): TranscriptCue[] {
  const sorted = cues
    .map((cue) => ({ ...cue, text: normalizeWhitespace(cue.text) }))
    .filter((cue) => cue.text.length > 0 && Number.isFinite(cue.start) && cue.start >= 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const result: TranscriptCue[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const cue = sorted[i]!;
    const next = sorted[i + 1];
    let end = Number.isFinite(cue.end) ? cue.end : cue.start;
    if (next && end > next.start) end = next.start;
    if (end <= cue.start) end = cue.start + 0.01;

    const normalized: TranscriptCue = { text: cue.text, start: cue.start, end };
    if (cue.words && cue.words.length > 0) {
      normalized.words = clampWords(cue.words, cue.start, end);
    }
    result.push(normalized);
  }

  return result;
}
