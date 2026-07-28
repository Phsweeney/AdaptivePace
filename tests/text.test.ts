import { describe, expect, it } from 'vitest';
import {
  countWords,
  decodeXmlEntities,
  distributeWords,
  dropRollupDuplicates,
  normalizeCues,
  normalizeWhitespace,
  tokenizeWords,
} from '../src/core/text.ts';

describe('decodeXmlEntities', () => {
  it('decodes named, decimal, and hex entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeXmlEntities('&#39;&#65;')).toBe("'A");
    expect(decodeXmlEntities('&#x27;&#X42;')).toBe("'B");
  });

  it('leaves unknown or malformed entities alone', () => {
    expect(decodeXmlEntities('&notarealentity; &#99999999999;')).toBe(
      '&notarealentity; &#99999999999;',
    );
  });
});

describe('tokenizeWords', () => {
  it('counts only tokens containing a letter or digit', () => {
    expect(tokenizeWords('>> hello - world 42')).toEqual(['hello', 'world', '42']);
  });

  it('drops bracketed annotations, including multi-word ones', () => {
    expect(tokenizeWords('[Music] real words [MUSIC PLAYING] here')).toEqual([
      'real',
      'words',
      'here',
    ]);
  });

  it('keeps parentheses, which spoken mathematics uses', () => {
    expect(countWords('open paren x plus y close paren (x + y)')).toBe(9);
  });

  it('handles non-Latin scripts', () => {
    expect(countWords('これは テスト です')).toBe(3);
  });

  it('returns nothing for punctuation only', () => {
    expect(countWords('>> -- ...')).toBe(0);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWhitespace('  a\n\t b  ')).toBe('a b');
  });
});

describe('distributeWords', () => {
  it('spreads a span evenly and lands exactly on the end', () => {
    expect(distributeWords(['a', 'b', 'c'], 0, 3)).toEqual([
      { text: 'a', start: 0, end: 1 },
      { text: 'b', start: 1, end: 2 },
      { text: 'c', start: 2, end: 3 },
    ]);
  });

  it('tolerates a zero-length span', () => {
    expect(distributeWords(['a'], 5, 5)).toEqual([{ text: 'a', start: 5, end: 5 }]);
    expect(distributeWords([], 0, 1)).toEqual([]);
  });
});

describe('dropRollupDuplicates', () => {
  it('drops an identical cue that overlaps its predecessor', () => {
    const cues = [
      { text: 'same line', start: 0, end: 3 },
      { text: 'same line', start: 1, end: 4 },
    ];
    expect(dropRollupDuplicates(cues)).toHaveLength(1);
  });

  it('keeps an identical cue that starts after the previous one ends', () => {
    const cues = [
      { text: 'same line', start: 0, end: 3 },
      { text: 'same line', start: 3, end: 6 },
    ];
    expect(dropRollupDuplicates(cues)).toHaveLength(2);
  });

  it('keeps different text that overlaps', () => {
    const cues = [
      { text: 'first', start: 0, end: 3 },
      { text: 'second', start: 1, end: 4 },
    ];
    expect(dropRollupDuplicates(cues)).toHaveLength(2);
  });
});

describe('normalizeCues', () => {
  it('sorts, drops empties, and truncates overlap at the next start', () => {
    const cues = normalizeCues([
      { text: 'second', start: 5, end: 9 },
      { text: '   ', start: 2, end: 3 },
      { text: 'first', start: 0, end: 6 },
    ]);

    expect(cues).toEqual([
      { text: 'first', start: 0, end: 5 },
      { text: 'second', start: 5, end: 9 },
    ]);
  });

  it('gives a zero-length cue a minimum span', () => {
    const cues = normalizeCues([{ text: 'blip', start: 4, end: 4 }]);
    expect(cues[0]!.end).toBeGreaterThan(cues[0]!.start);
  });

  it('clamps words into the corrected cue bounds', () => {
    const cues = normalizeCues([
      {
        text: 'a b',
        start: 0,
        end: 10,
        words: [
          { text: 'a', start: 0, end: 4 },
          { text: 'b', start: 4, end: 10 },
        ],
      },
      { text: 'next', start: 3, end: 6 },
    ]);

    expect(cues[0]!.end).toBe(3);
    expect(cues[0]!.words!.every((word) => word.end <= 3)).toBe(true);
  });

  it('drops cues with a negative or non-finite start', () => {
    const cues = normalizeCues([
      { text: 'bad', start: Number.NaN, end: 1 },
      { text: 'also bad', start: -5, end: 1 },
      { text: 'good', start: 0, end: 1 },
    ]);

    expect(cues.map((cue) => cue.text)).toEqual(['good']);
  });
});
