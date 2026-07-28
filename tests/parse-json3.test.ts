import { describe, expect, it } from 'vitest';
import { parseJson3 } from '../src/core/parse-json3.ts';

function json3(events: unknown[]): string {
  return JSON.stringify({ wireMagic: 'pb3', events });
}

describe('parseJson3', () => {
  it('reads per-word timings from segment offsets', () => {
    const raw = json3([
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [
          { utf8: 'the', tOffsetMs: 0 },
          { utf8: ' quick', tOffsetMs: 500 },
          { utf8: ' fox', tOffsetMs: 1200 },
        ],
      },
    ]);

    const parsed = parseJson3(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.wordTimingSource).toBe('native');
    expect(parsed!.cues).toHaveLength(1);
    expect(parsed!.cues[0]!.text).toBe('the quick fox');
    expect(parsed!.cues[0]!.words).toEqual([
      { text: 'the', start: 1, end: 1.5 },
      { text: 'quick', start: 1.5, end: 2.2 },
      { text: 'fox', start: 2.2, end: 3 },
    ]);
  });

  it('drops the aAppend rollup events auto-captions emit', () => {
    const raw = json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'first' }] },
      { tStartMs: 900, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'second' }] },
    ]);

    const parsed = parseJson3(raw);

    expect(parsed!.cues.map((cue) => cue.text)).toEqual(['first', 'second']);
  });

  it('drops a repeated cue that overlaps the one before it', () => {
    const raw = json3([
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'rolling line' }] },
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'rolling line' }] },
    ]);

    expect(parseJson3(raw)!.cues).toHaveLength(1);
  });

  it('keeps a repeated phrase that does not overlap', () => {
    const raw = json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'again' }] },
      { tStartMs: 60000, dDurationMs: 1000, segs: [{ utf8: 'again' }] },
    ]);

    expect(parseJson3(raw)!.cues).toHaveLength(2);
  });

  it('calls timings interpolated when a segment holds a whole phrase', () => {
    const raw = json3([
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'one whole sentence per segment here' }] },
    ]);

    const parsed = parseJson3(raw);

    expect(parsed!.wordTimingSource).toBe('interpolated');
    expect(parsed!.cues[0]!.words).toHaveLength(6);
    expect(parsed!.cues[0]!.words!.at(-1)!.end).toBeCloseTo(4);
  });

  it('derives a missing duration from the next event start', () => {
    const raw = json3([
      { tStartMs: 0, segs: [{ utf8: 'no duration' }] },
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'next' }] },
    ]);

    expect(parseJson3(raw)!.cues[0]!.end).toBeCloseTo(5);
  });

  it('ignores events with no usable segments', () => {
    const raw = json3([
      { tStartMs: 0, dDurationMs: 1000 },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'real' }] },
    ]);

    expect(parseJson3(raw)!.cues.map((cue) => cue.text)).toEqual(['real']);
  });

  it('sorts events that arrive out of order', () => {
    const raw = json3([
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'second' }] },
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'first' }] },
    ]);

    expect(parseJson3(raw)!.cues.map((cue) => cue.text)).toEqual(['first', 'second']);
  });

  it('returns null for a payload that is not json3', () => {
    expect(parseJson3('<?xml version="1.0"?><timedtext/>')).toBeNull();
    expect(parseJson3('{"notEvents":[]}')).toBeNull();
    expect(parseJson3('{"events":[]}')).toBeNull();
  });
});
