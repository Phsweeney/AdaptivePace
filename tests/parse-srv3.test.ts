import { describe, expect, it } from 'vitest';
import { parseLegacyTimedText, parseSrv3, parseTimedTextXml } from '../src/core/parse-srv3.ts';

describe('parseSrv3', () => {
  it('reads word offsets from nested segments', () => {
    const raw = `<?xml version="1.0" encoding="utf-8"?>
<timedtext format="3"><body>
<p t="2000" d="1500"><s ac="200">alpha</s><s t="500" ac="200"> beta</s></p>
</body></timedtext>`;

    const parsed = parseSrv3(raw);

    expect(parsed!.wordTimingSource).toBe('native');
    expect(parsed!.cues[0]!.start).toBeCloseTo(2);
    expect(parsed!.cues[0]!.end).toBeCloseTo(3.5);
    expect(parsed!.cues[0]!.words).toEqual([
      { text: 'alpha', start: 2, end: 2.5 },
      { text: 'beta', start: 2.5, end: 3.5 },
    ]);
  });

  it('interpolates when a paragraph has no segment children', () => {
    const raw = '<body><p t="0" d="4000">four plain words here</p></body>';
    const parsed = parseSrv3(raw);

    expect(parsed!.wordTimingSource).toBe('interpolated');
    expect(parsed!.cues[0]!.words).toHaveLength(4);
    expect(parsed!.cues[0]!.words!.at(-1)!.end).toBeCloseTo(4);
  });

  it('decodes entities', () => {
    const raw = '<body><p t="0" d="1000"><s>Rock &amp; roll&#39;s</s></p></body>';
    expect(parseSrv3(raw)!.cues[0]!.text).toBe("Rock & roll's");
  });

  it('skips paragraphs with no start time or no text', () => {
    const raw = '<body><p d="1000">orphan</p><p t="0" d="1000"></p><p t="1000" d="500">kept</p></body>';
    expect(parseSrv3(raw)!.cues.map((cue) => cue.text)).toEqual(['kept']);
  });

  it('returns null when there are no paragraphs at all', () => {
    expect(parseSrv3('<transcript><text start="0" dur="1">hi</text></transcript>')).toBeNull();
  });
});

describe('parseLegacyTimedText', () => {
  it('parses start and dur attributes in seconds', () => {
    const raw = '<transcript><text start="1.5" dur="2.5">hello there world</text></transcript>';
    const parsed = parseLegacyTimedText(raw);

    expect(parsed!.wordTimingSource).toBe('interpolated');
    expect(parsed!.cues[0]!.start).toBeCloseTo(1.5);
    expect(parsed!.cues[0]!.end).toBeCloseTo(4);
    expect(parsed!.cues[0]!.words).toHaveLength(3);
  });

  it('resolves double-escaped entities', () => {
    const raw = `<transcript><text start="0" dur="1">it&amp;#39;s fine</text></transcript>`;
    expect(parseLegacyTimedText(raw)!.cues[0]!.text).toBe("it's fine");
  });

  it('returns null for an empty transcript', () => {
    expect(parseLegacyTimedText('<transcript></transcript>')).toBeNull();
  });
});

describe('parseTimedTextXml', () => {
  it('prefers srv3 and falls back to the legacy shape', () => {
    expect(parseTimedTextXml('<body><p t="0" d="1000">srv3</p></body>')!.cues[0]!.text).toBe('srv3');
    expect(
      parseTimedTextXml('<transcript><text start="0" dur="1">legacy</text></transcript>')!.cues[0]!
        .text,
    ).toBe('legacy');
    expect(parseTimedTextXml('not xml at all')).toBeNull();
  });
});
