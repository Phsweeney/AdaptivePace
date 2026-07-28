import { describe, expect, it } from 'vitest';
import {
  ANCHOR_COUNT,
  batchInput,
  buildUserMessage,
  estimateInputTokens,
  parseScoreResponse,
  planBatches,
  rescaleAnchoredBatch,
  scoreableChunks,
} from '../src/core/prompt.ts';
import type { Chunk } from '../src/core/types.ts';
import { silenceChunk, speechChunk, uniformChunks } from './support/transcripts.ts';

function withText(chunk: Chunk, text: string): Chunk {
  return { ...chunk, text };
}

describe('choosing what to send', () => {
  it('sends speech only', () => {
    const chunks = [
      speechChunk(0, 0, 30, 60),
      silenceChunk(1, 30, 34),
      speechChunk(2, 34, 60, 50),
    ];

    expect(scoreableChunks(chunks).map((chunk) => chunk.id)).toEqual([0, 2]);
  });

  it('drops a speech chunk with no words in it', () => {
    // Reachable on a transcript whose cues are whitespace. Sending it would ask the model to
    // rate an empty line, and whatever came back would be noise attached to a real chunk id.
    const chunks = [withText(speechChunk(0, 0, 30, 60), '   '), speechChunk(1, 30, 60, 60)];

    expect(scoreableChunks(chunks).map((chunk) => chunk.id)).toEqual([1]);
  });
});

describe('the user message', () => {
  it('numbers every line with the chunk id, not its position', () => {
    // Ids are dense across silence too, so the speech chunks sent are not 0, 1, 2. Getting
    // this wrong misattributes every rating in the video by a shifting offset.
    const chunks = [speechChunk(0, 0, 30, 60), speechChunk(2, 34, 60, 50)];
    const message = buildUserMessage(chunks);

    expect(message.split('\n')).toEqual([
      `[0] ${chunks[0]!.text}`,
      `[2] ${chunks[1]!.text}`,
    ]);
  });

  it('puts a chapter title above the first chunk of that chapter', () => {
    const chunks = [
      speechChunk(0, 0, 30, 60),
      speechChunk(1, 30, 60, 60),
      speechChunk(2, 60, 90, 60),
    ];
    const chapters = [
      { title: 'Introduction', start: 0 },
      { title: 'The hard part', start: 60 },
    ];

    const lines = buildUserMessage(chunks, chapters).split('\n');

    expect(lines[0]).toBe('## Chapter: Introduction');
    expect(lines[1]).toBe(`[0] ${chunks[0]!.text}`);
    expect(lines[2]).toBe(`[1] ${chunks[1]!.text}`);
    expect(lines[3]).toBe('## Chapter: The hard part');
    expect(lines[4]).toBe(`[2] ${chunks[2]!.text}`);
  });

  it('emits no title for content before the first chapter starts', () => {
    const chunks = [speechChunk(0, 0, 30, 60), speechChunk(1, 30, 60, 60)];
    const chapters = [{ title: 'Later', start: 30 }];

    const lines = buildUserMessage(chunks, chapters).split('\n');

    expect(lines[0]).toBe(`[0] ${chunks[0]!.text}`);
    expect(lines[1]).toBe('## Chapter: Later');
  });

  it('estimates tokens at four characters each', () => {
    expect(estimateInputTokens('a'.repeat(400))).toBe(100);
    expect(estimateInputTokens('a'.repeat(200), 'b'.repeat(200))).toBe(100);
  });
});

describe('batching', () => {
  it('sends one request for an ordinary video', () => {
    // The default path, and the one that has to stay cheap: a 60 minute video at 30 second
    // chunks is about 120 chunks.
    const batches = planBatches(uniformChunks(120, 30, 150));

    expect(batches).toHaveLength(1);
    expect(batches[0]!.anchors).toEqual([]);
  });

  it('splits above the limit and carries anchors into every later batch', () => {
    const batches = planBatches(uniformChunks(400, 30, 150));

    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]!.anchors).toEqual([]);
    for (const batch of batches.slice(1)) {
      expect(batch.anchors).toHaveLength(ANCHOR_COUNT);
    }
  });

  it('rates every chunk exactly once across the batches', () => {
    const chunks = uniformChunks(400, 30, 150);
    const owned = planBatches(chunks).flatMap((batch) => batch.chunks.map((chunk) => chunk.id));

    expect(owned).toEqual(chunks.map((chunk) => chunk.id));
  });

  it('interleaves anchors with the batch so ids stay ascending', () => {
    // A model given ids out of order starts renumbering them. The anchors belong to earlier
    // chunks, so appending them would put lower ids after higher ones.
    const batches = planBatches(uniformChunks(400, 30, 150));
    const ids = batchInput(batches[1]!).map((chunk) => chunk.id);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('reading the reply', () => {
  it('reads the documented pair-array form', () => {
    const ratings = parseScoreResponse('{"scores": [[0, 3], [1, 8]]}');

    expect(ratings?.get(0)).toBe(3);
    expect(ratings?.get(1)).toBe(8);
  });

  it('strips a markdown fence the prompt told it not to use', () => {
    const ratings = parseScoreResponse('```json\n{"scores": [[0, 5]]}\n```');

    expect(ratings?.get(0)).toBe(5);
  });

  it('accepts the object form a model reaches for on its own', () => {
    const ratings = parseScoreResponse('{"scores": {"0": 4, "1": 9}}');

    expect(ratings?.get(0)).toBe(4);
    expect(ratings?.get(1)).toBe(9);
  });

  it('returns null rather than throwing on prose', () => {
    expect(parseScoreResponse('Sure! Here are the ratings you asked for.')).toBeNull();
  });

  it('returns null on JSON that is not a score object', () => {
    expect(parseScoreResponse('{"ratings": [[0, 3]]}')).toBeNull();
    expect(parseScoreResponse('{"scores": 7}')).toBeNull();
    expect(parseScoreResponse('[]')).toBeNull();
  });

  it('skips malformed entries without losing the rest', () => {
    const ratings = parseScoreResponse('{"scores": [[0, 3], ["x"], [2, "hard"], [3, 6]]}');

    expect([...ratings!.keys()]).toEqual([0, 3]);
  });
});

describe('aligning a later batch', () => {
  it('maps a shifted and compressed scale back onto the first batch', () => {
    // Batch two rated the same anchors 2 points lower and half as spread out. Putting it back
    // on the reference scale must undo exactly that.
    const anchorIds = [0, 1, 2, 3];
    const reference = new Map([
      [0, 2],
      [1, 4],
      [2, 6],
      [3, 8],
    ]);
    const later = new Map([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [9, 5],
    ]);

    const aligned = rescaleAnchoredBatch(later, anchorIds, reference);

    for (const id of anchorIds) {
      expect(aligned.get(id)).toBeCloseTo(reference.get(id)!, 6);
    }
    // 5 continues the batch's own run, so it maps one step past the last anchor.
    expect(aligned.get(9)).toBeCloseTo(10, 6);
  });

  it('leaves ratings alone when there are too few anchors to fit anything', () => {
    const later = new Map([
      [0, 3],
      [1, 7],
    ]);

    const aligned = rescaleAnchoredBatch(later, [0], new Map([[0, 9]]));

    expect(aligned).toEqual(later);
  });

  it('corrects only the offset when the anchors came back flat', () => {
    // Dividing by a spread of zero would turn a rounding difference into a wild rescale.
    const anchorIds = [0, 1, 2];
    const reference = new Map([
      [0, 5],
      [1, 5],
      [2, 5],
    ]);
    const later = new Map([
      [0, 3],
      [1, 3],
      [2, 3],
      [7, 6],
    ]);

    const aligned = rescaleAnchoredBatch(later, anchorIds, reference);

    expect(aligned.get(0)).toBeCloseTo(5, 6);
    expect(aligned.get(7)).toBeCloseTo(8, 6);
  });
});
