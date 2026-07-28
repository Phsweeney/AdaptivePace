/**
 * Building the difficulty request and reading the answer back.
 *
 * The model is asked one question: for each chunk of this transcript, how much sustained
 * attention does following it take, on a scale of 1 to 10. Everything about the prompt is
 * aimed at making that answer *relative to this video*, because the pacing engine z-scores
 * the ratings within the video anyway. An absolute scale would be wasted: a graduate lecture
 * rated a flat 9 and an introductory tutorial rated a flat 3 produce identical playback.
 *
 * Nothing here touches the network or the DOM. The request is built and the response is
 * parsed as strings, so both halves are testable in Node against captured model output.
 */

import { chapterIndexAt } from './chunking.ts';
import type { Chapter, Chunk } from './types.ts';

/**
 * Participates in the LLM cache key alongside CHUNKING_VERSION.
 *
 * Bump it whenever the system prompt or the shape of the user message changes, because
 * cached scores were produced by asking a different question and are not comparable with
 * what this version would get back.
 */
export const PROMPT_VERSION = 1;

/**
 * Verbatim from spec 7.2. The three paragraphs under "Critical instructions" are doing
 * specific work and none of them is filler:
 *
 * - Rate relative to this video, because the score is z-scored within the video.
 * - Use the full range, because a clustered distribution has a tiny standard deviation and
 *   z-scoring it amplifies noise into large speed swings. `checkAnalysisQuality` rejects
 *   responses that ignore this, so the instruction is the first line of that defence.
 * - Judge reasoning load rather than vocabulary, because jargon that is merely named is
 *   easy and this is the mistake a model makes if left to itself.
 * - Tolerate transcription noise, because auto-generated captions have no punctuation and
 *   the chunker cannot give them sentence boundaries, so chunks routinely start mid clause.
 */
export const SYSTEM_PROMPT = `You rate the conceptual difficulty of segments from an educational video transcript.

You will receive the full transcript split into numbered segments.

Rate each segment 1-10 for how much sustained attention a motivated learner needs to
follow it.

  1-3  Administrative, introductory, recap, tangent, or restating something already
       covered. Can be followed while distracted.
  4-7  Normal explanatory content. New information delivered at a manageable pace.
  8-10 Dense derivation, formal definition, multi-step reasoning, or notation-heavy
       explanation where losing one sentence means losing the thread.

Critical instructions:
- Rate RELATIVE TO THIS VIDEO. The hardest segments here should score 8-10 and the
  easiest 1-3, whether the video is an introductory tutorial or a graduate lecture.
- Use the full 1-10 range. A clustered distribution is a failed response.
- Judge the reasoning load, not the vocabulary. Jargon that is merely named is easy;
  a plainly-worded argument with four dependent steps is hard.
- Transcripts may be auto-generated, lacking punctuation and containing errors.
  Infer intent and do not let transcription noise affect the rating.

Output ONLY a JSON object of the form {"scores": [[id, rating], ...]} with one entry for
every segment id provided, in order. No prose, no markdown, no code fences.`;

/** Appended on the one retry allowed after an unparseable response (spec 7.4.1). */
export const JSON_REMINDER =
  'Your previous reply could not be parsed. Reply with only the raw JSON object ' +
  '{"scores": [[id, rating], ...]}. No prose, no markdown, no code fences.';

/**
 * Above this many chunks the request is split. A 60 minute video at 30 second chunks is
 * about 120 chunks and roughly 12k tokens, so the single-request path covers essentially
 * everything the 90 minute duration cap admits. Splitting is the exception, not the norm.
 */
export const MAX_CHUNKS_PER_BATCH = 150;

/**
 * Chunks carried from one batch into the next so the two can be put on a common scale.
 *
 * Each batch rates relative to what it can see, so batch two's "8" is not batch one's "8".
 * Re-rating a handful of chunks the previous batch already rated gives two measurements of
 * the same thing, and the difference between them is exactly the offset to correct for.
 * Without this the seam between batches is a visible step in the speed profile.
 */
export const ANCHOR_COUNT = 8;

export const MIN_RATING = 1;
export const MAX_RATING = 10;

export interface PromptBatch {
  /** Chunks whose ratings this batch is responsible for. */
  chunks: Chunk[];
  /** Chunks re-rated only to align this batch with the previous one. Empty for the first. */
  anchors: Chunk[];
}

/** Speech only. Silence carries no text, so there is nothing to rate and nothing to send. */
export function scoreableChunks(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.kind === 'speech' && chunk.text.trim().length > 0);
}

/**
 * The user message: one `[id] text` line per chunk, with chapter titles inserted where they
 * occur.
 *
 * Chapter titles are cheap context that tells the model what a stretch is about before it
 * reads the stretch. Which chunk a title belongs above is decided by `chapterIndexAt`, the
 * same function the chunker and the smoother use, so all three can never disagree about
 * which side of a boundary something falls on.
 */
export function buildUserMessage(
  chunks: readonly Chunk[],
  chapters: readonly Chapter[] = [],
): string {
  const lines: string[] = [];
  let lastChapter = Number.NaN;

  for (const chunk of chunks) {
    const chapter = chapterIndexAt(chunk.start, chapters);
    if (chapter !== lastChapter) {
      const title = chapters[chapter]?.title.trim();
      if (title) lines.push(`## Chapter: ${title}`);
      lastChapter = chapter;
    }
    lines.push(`[${chunk.id}] ${chunk.text.trim()}`);
  }

  return lines.join('\n');
}

/**
 * Input token estimate for the cost display in spec 7.6.
 *
 * Four characters per token is the usual rule of thumb for English and is close enough to
 * decide whether to press a button. The real number comes back from the provider afterwards
 * and is what gets reported.
 */
export function estimateInputTokens(...parts: string[]): number {
  const chars = parts.reduce((total, part) => total + part.length, 0);
  return Math.ceil(chars / 4);
}

/** Evenly spaced sample, always including the first and last element. */
function sampleEvenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 0) return [];
  if (count === 1) return [items[0]!];

  const result: T[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(items[Math.round((i * (items.length - 1)) / (count - 1))]!);
  }
  return result;
}

/**
 * Splits the chunks into requests, carrying anchors forward.
 *
 * Anchors are sampled from the chunks the *previous* batch rated, so every batch after the
 * first contains a few segments whose rating on the previous scale is already known.
 */
export function planBatches(
  chunks: readonly Chunk[],
  maxPerBatch: number = MAX_CHUNKS_PER_BATCH,
): PromptBatch[] {
  if (chunks.length === 0) return [];
  if (chunks.length <= maxPerBatch) return [{ chunks: [...chunks], anchors: [] }];

  const size = Math.max(maxPerBatch - ANCHOR_COUNT, 1);
  const batches: PromptBatch[] = [];

  for (let start = 0; start < chunks.length; start += size) {
    const slice = chunks.slice(start, start + size);
    const previous = batches[batches.length - 1]?.chunks ?? [];
    batches.push({ chunks: slice, anchors: sampleEvenly(previous, ANCHOR_COUNT) });
  }

  return batches;
}

/** Anchors are interleaved with the batch's own chunks so ids stay ascending. */
export function batchInput(batch: PromptBatch): Chunk[] {
  return [...batch.anchors, ...batch.chunks].sort((a, b) => a.id - b.id);
}

/**
 * Pulls the ratings out of a model reply.
 *
 * Returns null rather than throwing, which is the house rule on this path: a model that
 * emitted prose is an ordinary outcome with a defined response (retry once, then give up),
 * not an exception to unwind through the service worker.
 *
 * Two tolerances beyond the spec, both free and both observed in the wild. Markdown fences
 * are stripped even though the prompt forbids them, and an object form `{"1": 4}` is
 * accepted alongside the pair-array form, because a model asked for JSON often produces the
 * more idiomatic mapping.
 */
export function parseScoreResponse(content: string): Map<number, number> | null {
  const text = stripFences(content).trim();
  if (text.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const scores = (parsed as { scores?: unknown } | null)?.scores;
  if (scores === undefined || scores === null) return null;

  const result = new Map<number, number>();

  if (Array.isArray(scores)) {
    for (const entry of scores) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const id = Number(entry[0]);
      const rating = Number(entry[1]);
      if (Number.isInteger(id) && Number.isFinite(rating)) result.set(id, rating);
    }
  } else if (typeof scores === 'object') {
    for (const [key, value] of Object.entries(scores as Record<string, unknown>)) {
      const id = Number(key);
      const rating = Number(value);
      if (Number.isInteger(id) && Number.isFinite(rating)) result.set(id, rating);
    }
  } else {
    return null;
  }

  return result.size > 0 ? result : null;
}

/**
 * Removes a wrapping markdown code fence.
 *
 * Only a fence that opens on the first line is stripped, so a reply that happens to contain
 * a backtick inside a string is left alone.
 */
function stripFences(content: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content);
  return match?.[1] ?? content;
}

/** Mean and standard deviation of a list, population form. */
function moments(values: readonly number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

/**
 * Puts a later batch's ratings onto the first batch's scale.
 *
 * The anchors were rated twice, once by each batch. Matching their mean and standard
 * deviation across the two readings gives the affine map between the scales, which is then
 * applied to everything the later batch rated.
 *
 * If the anchors came back with no spread under either batch there is nothing to learn from
 * them beyond the offset, so only the mean is corrected. Dividing by a standard deviation
 * near zero would turn a rounding difference into a wild rescale.
 */
export function rescaleAnchoredBatch(
  ratings: ReadonlyMap<number, number>,
  anchorIds: readonly number[],
  reference: ReadonlyMap<number, number>,
): Map<number, number> {
  const pairs = anchorIds
    .map((id) => ({ here: ratings.get(id), there: reference.get(id) }))
    .filter((pair): pair is { here: number; there: number } =>
      pair.here !== undefined && pair.there !== undefined,
    );

  if (pairs.length < 2) return new Map(ratings);

  const here = moments(pairs.map((pair) => pair.here));
  const there = moments(pairs.map((pair) => pair.there));
  const scale = here.sd > 1e-6 && there.sd > 1e-6 ? there.sd / here.sd : 1;

  const result = new Map<number, number>();
  for (const [id, rating] of ratings) {
    result.set(id, there.mean + (rating - here.mean) * scale);
  }
  return result;
}
