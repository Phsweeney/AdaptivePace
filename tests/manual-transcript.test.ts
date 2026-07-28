import { describe, expect, it } from 'vitest';
import { parseManualTranscript } from '../src/core/manual-transcript.ts';
import { countWords } from '../src/core/text.ts';

function expectTranscript(result: ReturnType<typeof parseManualTranscript>) {
  if (!result.ok) throw new Error(`expected success, got: ${result.message}`);
  return result.transcript;
}

describe('parseManualTranscript', () => {
  it('spreads a duration across prose in proportion to word count', () => {
    const text = 'One two three four. Five six seven eight nine ten eleven twelve.';
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 120 }));

    expect(transcript.source).toBe('manual');
    expect(transcript.wordTimingSource).toBe('interpolated');
    expect(transcript.cues[0]!.start).toBe(0);
    expect(transcript.cues.at(-1)!.end).toBeCloseTo(120);

    // The longer sentence gets the longer slice.
    const [first, second] = transcript.cues;
    expect(second!.end - second!.start).toBeGreaterThan(first!.end - first!.start);
  });

  it('keeps every word from the pasted text', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 60 }));

    const words = transcript.cues.flatMap((cue) => cue.words ?? []);
    expect(words).toHaveLength(countWords(text));
  });

  it('uses leading timestamps when the paste has them', () => {
    const text = ['0:00 opening remarks', '[1:30] the main argument', '(1:00:05) closing'].join('\n');
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 3700 }));

    expect(transcript.cues.map((cue) => cue.start)).toEqual([0, 90, 3605]);
    expect(transcript.cues[0]!.text).toBe('opening remarks');
    expect(transcript.cues.at(-1)!.end).toBeCloseTo(3700);
  });

  it('attaches untimestamped lines to the cue above them', () => {
    const text = ['0:00 first line', 'continued here', '0:30 second line'].join('\n');
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 60 }));

    expect(transcript.cues).toHaveLength(2);
    expect(transcript.cues[0]!.text).toBe('first line continued here');
  });

  it('breaks up a long unpunctuated run rather than making one huge cue', () => {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 300 }));

    expect(transcript.cues.length).toBeGreaterThan(3);
    expect(Math.max(...transcript.cues.map((cue) => countWords(cue.text)))).toBeLessThanOrEqual(24);
  });

  it('estimates a duration when none is supplied', () => {
    const text = Array.from({ length: 150 }, () => 'word').join(' ');
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1' }));

    // 150 words at the assumed 150 wpm is one minute.
    expect(transcript.durationSec).toBeCloseTo(60, 1);
  });

  it('produces contiguous non-overlapping cues', () => {
    const text = 'First sentence here. Second sentence here. Third sentence goes here too.';
    const transcript = expectTranscript(parseManualTranscript(text, { videoId: 'v1', durationSec: 90 }));

    for (let i = 1; i < transcript.cues.length; i += 1) {
      expect(transcript.cues[i]!.start).toBeGreaterThanOrEqual(transcript.cues[i - 1]!.end - 1e-9);
    }
  });

  it('fails with a typed result rather than throwing', () => {
    const empty = parseManualTranscript('   ', { videoId: 'v1', durationSec: 60 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('parse-failed');

    const noWords = parseManualTranscript('>>> ... ---', { videoId: 'v1', durationSec: 60 });
    expect(noWords.ok).toBe(false);
  });
});
