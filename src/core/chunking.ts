/**
 * Cutting a Transcript into the units everything downstream reasons about.
 *
 * A chunk is the granularity at which speed is decided, difficulty is scored, and the
 * heatmap is drawn. Too fine and the speed changes constantly and the LLM cost explodes;
 * too coarse and a hard paragraph gets averaged away by the easy one next to it. The 20 to
 * 45 second target is the compromise.
 *
 * Boundaries are chosen by priority, best first:
 *
 *   1. Chapter boundaries, which are hard and never merged across.
 *   2. Silence gaps, which become their own chunks so they can be played fast.
 *   3. Sentence ends, so a chunk is a coherent piece of language.
 *   4. Cue boundaries, once a stretch has run past the maximum.
 *
 * Rule 3 only ever fires on manually written captions. Auto-generated tracks have no
 * punctuation, and measurement across the fixtures found they have no usable pause signal
 * either: YouTube's speech recognition emits captions that tile the timeline with no holes,
 * so a pause is absorbed into the duration of the surrounding word rather than appearing as
 * a gap. On the fastest fixture there is not one inter-cue gap of 0.6s in twelve minutes.
 * Auto content therefore falls through to rule 4 and is time sliced. That is expected, and
 * the tests pin it down so it is not mistaken for a regression later.
 */

import { SILENCE_GAP_SEC } from './stats.ts';
import { countWords } from './text.ts';
import type { Chapter, Chunk, Settings, Transcript, TranscriptCue } from './types.ts';

/**
 * Participates in the LLM cache key. Bump it whenever a change here would produce different
 * chunk boundaries, because cached difficulty scores are keyed to chunk ids and silently
 * become wrong when the ids stop meaning the same thing.
 */
export const CHUNKING_VERSION = 1;

const TARGET_MIN_SEC = 20;
const TARGET_MAX_SEC = 45;
const MIN_CHUNK_SEC = 8;

/** Below this a chunk is mostly pause, and its trailing gap is worth splitting out. */
const LOW_WPM = 60;

/**
 * Trailing gaps shorter than this are left inside their speech chunk. Without a floor the
 * low-rate rule would emit slivers of silence a fraction of a second long, which are not
 * worth a playback rate change.
 */
const MIN_SILENCE_SPLIT_SEC = 1.0;

const EPSILON = 1e-6;

/** Terminal punctuation, allowing for a closing quote or bracket after it. */
const SENTENCE_END = /[.!?]["'’”)\]]*$/;

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

/**
 * Index of the chapter covering a moment, or -1 before the first one starts.
 *
 * The -1 matters: content before the first chapter marker is its own region, so a chunk
 * cannot straddle the point where chapter 0 begins.
 *
 * Exported because pacing needs the identical answer when it refuses to smooth across a
 * chapter boundary. Two implementations of this would eventually disagree at an edge and
 * produce a plan whose smoothing does not line up with its chunks.
 */
export function chapterIndexAt(time: number, chapters: readonly Chapter[]): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i]!.start <= time + EPSILON) index = i;
    else break;
  }
  return index;
}

/** A chunk under construction, before ids and final spans are settled. */
interface Draft {
  kind: Chunk['kind'];
  start: number;
  end: number;
  cues: TranscriptCue[];
  chapter: number;
}

function speechDraft(cues: TranscriptCue[], chapter: number): Draft {
  return {
    kind: 'speech',
    start: cues[0]!.start,
    end: cues[cues.length - 1]!.end,
    cues,
    chapter,
  };
}

function silenceDraft(start: number, end: number, chapter: number): Draft {
  return { kind: 'silence', start, end, cues: [], chapter };
}

/**
 * Splits the cue list into silence chunks and the runs of speech between them.
 *
 * Only gaps of at least SILENCE_GAP_SEC qualify. Shorter ones stay inside the surrounding
 * speech chunk, because a breath between sentences is not something to accelerate through.
 */
function splitOnSilence(
  cues: readonly TranscriptCue[],
  durationSec: number,
  chapters: readonly Chapter[],
): Draft[] {
  const drafts: Draft[] = [];
  let run: TranscriptCue[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    drafts.push(speechDraft(run, chapterIndexAt(run[0]!.start, chapters)));
    run = [];
  };

  const first = cues[0]!;
  if (first.start >= SILENCE_GAP_SEC) {
    drafts.push(silenceDraft(0, first.start, chapterIndexAt(0, chapters)));
  }

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    run.push(cue);

    const next = cues[i + 1];
    if (next === undefined) continue;
    if (next.start - cue.end >= SILENCE_GAP_SEC) {
      flushRun();
      drafts.push(silenceDraft(cue.end, next.start, chapterIndexAt(cue.end, chapters)));
    }
  }
  flushRun();

  const lastEnd = cues[cues.length - 1]!.end;
  if (durationSec - lastEnd >= SILENCE_GAP_SEC) {
    drafts.push(silenceDraft(lastEnd, durationSec, chapterIndexAt(lastEnd, chapters)));
  }

  return drafts;
}

/** Breaks a speech run wherever a chapter starts. Chapters are never merged across. */
function splitOnChapters(draft: Draft, chapters: readonly Chapter[]): Draft[] {
  if (chapters.length === 0) return [draft];

  const parts: Draft[] = [];
  let current: TranscriptCue[] = [];
  let currentChapter = chapterIndexAt(draft.cues[0]!.start, chapters);

  for (const cue of draft.cues) {
    // Keyed on the cue start so a chapter beginning mid-cue does not split the cue.
    const chapter = chapterIndexAt(cue.start, chapters);
    if (current.length > 0 && chapter !== currentChapter) {
      parts.push(speechDraft(current, currentChapter));
      current = [];
      currentChapter = chapter;
    }
    current.push(cue);
  }
  if (current.length > 0) parts.push(speechDraft(current, currentChapter));

  return parts;
}

/**
 * Packs a run of cues into chunks inside the target window.
 *
 * Past the minimum, the first sentence end closes the chunk. Failing that, the chunk closes
 * at the last cue boundary that still fits under the maximum. A single cue longer than the
 * maximum becomes its own oversized chunk, because splitting mid-cue would cut a sentence
 * in half and leave word timings straddling the boundary.
 */
function packRun(draft: Draft): Draft[] {
  const chunks: Draft[] = [];
  let current: TranscriptCue[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(speechDraft(current, draft.chapter));
    current = [];
  };

  for (const cue of draft.cues) {
    if (current.length > 0 && cue.end - current[0]!.start > TARGET_MAX_SEC) {
      flush();
    }
    current.push(cue);

    const elapsed = cue.end - current[0]!.start;
    if (elapsed >= TARGET_MIN_SEC && endsSentence(cue.text)) {
      flush();
    }
  }
  flush();

  return chunks;
}

/**
 * Absorbs speech chunks under the minimum length into an adjacent speech chunk.
 *
 * Silence chunks are deliberately exempt. A two second pause is under the minimum by
 * definition, and merging it into its neighbour would destroy the very thing it was split
 * out to represent, since silence is what gets played at triple speed.
 *
 * Only chunks that actually touch are candidates. A speech chunk with silence on both sides
 * shares no boundary with another speech chunk and is left alone.
 *
 * Adjacency in the list is the test, not equal coordinates. Two speech chunks sitting next
 * to each other are separated by less than SILENCE_GAP_SEC by construction, since a longer
 * gap would have put a silence chunk between them. Comparing end to start would reject them
 * over that fraction of a second, which is exactly the gap the merge is meant to swallow.
 */
function mergeShortSpeech(drafts: Draft[]): Draft[] {
  const result = [...drafts];

  let merged = true;
  while (merged) {
    merged = false;

    for (let i = 0; i < result.length; i += 1) {
      const chunk = result[i]!;
      if (chunk.kind !== 'speech') continue;
      if (chunk.end - chunk.start >= MIN_CHUNK_SEC) continue;

      const previous = result[i - 1];
      const next = result[i + 1];
      const canTakePrevious = previous?.kind === 'speech' && previous.chapter === chunk.chapter;
      const canTakeNext = next?.kind === 'speech' && next.chapter === chunk.chapter;

      if (!canTakePrevious && !canTakeNext) continue;

      // Prefer the shorter neighbour so merging pulls chunks toward the target window
      // rather than piling everything onto one already-long chunk.
      const previousLength = canTakePrevious ? previous!.end - previous!.start : Infinity;
      const nextLength = canTakeNext ? next!.end - next!.start : Infinity;
      const intoPrevious = previousLength <= nextLength;

      if (intoPrevious) {
        result.splice(i - 1, 2, speechDraft([...previous!.cues, ...chunk.cues], chunk.chapter));
      } else {
        result.splice(i, 2, speechDraft([...chunk.cues, ...next!.cues], chunk.chapter));
      }
      merged = true;
      break;
    }
  }

  return result;
}

/**
 * Reclassifies chunks that turned out to be mostly or entirely pause.
 *
 * A chunk of four words over nine seconds is not slow speech, it is a few words followed by
 * a gap, and treating it as slow speech would demand an absurd speed-up. Its trailing pause
 * is split off so the clamp in pacing does not have to absorb it.
 *
 * A chunk with no countable words at all becomes silence outright. These are real: a cue
 * holding nothing but a bracketed annotation like [Music] tokenizes to zero words. Leaving
 * it as speech would send an empty chunk to the model for difficulty scoring and put a
 * meaningless entry in the heatmap.
 */
function reclassifyLowRate(drafts: Draft[], chapters: readonly Chapter[]): Draft[] {
  const result: Draft[] = [];

  for (const draft of drafts) {
    if (draft.kind !== 'speech') {
      result.push(draft);
      continue;
    }

    const span = draft.end - draft.start;
    const words = draft.cues.reduce((total, cue) => total + countWords(cue.text), 0);

    if (words === 0) {
      result.push(silenceDraft(draft.start, draft.end, draft.chapter));
      continue;
    }

    const wpm = span > 0 ? words / (span / 60) : 0;
    const lastCueEnd = draft.cues[draft.cues.length - 1]!.end;
    const tail = draft.end - lastCueEnd;

    if (wpm >= LOW_WPM || tail < MIN_SILENCE_SPLIT_SEC) {
      result.push(draft);
      continue;
    }

    result.push({ ...draft, end: lastCueEnd });
    result.push(silenceDraft(lastCueEnd, draft.end, chapterIndexAt(lastCueEnd, chapters)));
  }

  return result;
}

/**
 * Turns drafts into Chunks with contiguous spans and dense ids.
 *
 * Spans are stretched so each chunk runs to the start of the next and the last runs to the
 * end of the video. This closes the sub-threshold gaps left between cues, which is what
 * makes the plan cover the timeline with no holes for the player to fall into. It also means
 * nativeWpm is computed over the span the chunk actually occupies rather than over speech
 * alone, which is the rate the pacing math wants.
 *
 * When a chapter starts inside one of those gaps the boundary is placed at the chapter start
 * rather than at the next chunk's first cue. Stretching straight through would hand the
 * opening seconds of a new chapter to the chunk belonging to the previous one, quietly
 * undoing the split that rule 1 just made.
 */
function boundariesBetween(
  drafts: readonly Draft[],
  chapters: readonly Chapter[],
): number[] {
  const starts: number[] = [0];

  for (let i = 1; i < drafts.length; i += 1) {
    const previousEnd = drafts[i - 1]!.end;
    const nextStart = drafts[i]!.start;
    const chapterInGap = chapters.find(
      (chapter) => chapter.start > previousEnd + EPSILON && chapter.start <= nextStart + EPSILON,
    );
    starts.push(chapterInGap?.start ?? nextStart);
  }

  return starts;
}

function finalize(
  drafts: readonly Draft[],
  durationSec: number,
  chapters: readonly Chapter[],
): Chunk[] {
  const starts = boundariesBetween(drafts, chapters);

  return drafts.map((draft, index) => {
    const start = starts[index]!;
    const end = index === drafts.length - 1 ? durationSec : starts[index + 1]!;
    const span = Math.max(end - start, 0);

    if (draft.kind === 'silence') {
      return { id: index, kind: 'silence', start, end, text: '', wordCount: 0, nativeWpm: 0 };
    }

    const text = draft.cues.map((cue) => cue.text).join(' ');
    const wordCount = draft.cues.reduce((total, cue) => total + countWords(cue.text), 0);

    return {
      id: index,
      kind: 'speech',
      start,
      end,
      text,
      wordCount,
      nativeWpm: span > 0 ? wordCount / (span / 60) : 0,
    };
  });
}

/**
 * Chunks a transcript.
 *
 * `settings` is accepted for signature stability with the rest of the engine; the chunk
 * geometry is deliberately independent of user settings, because chunk ids are baked into
 * the LLM cache key and must not shift when somebody moves a slider.
 */
export function buildChunks(transcript: Transcript, _settings: Settings): Chunk[] {
  const { cues, durationSec } = transcript;
  if (cues.length === 0 || durationSec <= 0) return [];

  const chapters = transcript.chapters ?? [];

  const drafts = splitOnSilence(cues, durationSec, chapters)
    .flatMap((draft) => (draft.kind === 'speech' ? splitOnChapters(draft, chapters) : [draft]))
    .flatMap((draft) => (draft.kind === 'speech' ? packRun(draft) : [draft]));

  const settled = reclassifyLowRate(mergeShortSpeech(drafts), chapters);

  return finalize(settled, durationSec, chapters);
}
