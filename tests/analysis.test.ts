import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis } from '../src/background/analysis.ts';
import { CHUNKING_VERSION } from '../src/core/chunking.ts';
import { PROMPT_VERSION } from '../src/core/prompt.ts';
import { cacheKey } from '../src/storage/cache.ts';
import { DEFAULTS } from '../src/core/types.ts';
import type { Chunk, DifficultyScore, Settings } from '../src/core/types.ts';
import { silenceChunk, uniformChunks } from './support/transcripts.ts';

/**
 * The cache is IndexedDB, which does not exist in Node, and the point of these tests is the
 * pipeline around it rather than the storage. Both halves are stubbed so a hit and a miss can
 * be arranged deliberately.
 */
const cache = vi.hoisted(() => ({
  getAnalysis: vi.fn<(key: string) => Promise<unknown>>(),
  putAnalysis: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('../src/storage/cache.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/storage/cache.ts')>();
  return { ...original, getAnalysis: cache.getAnalysis, putAnalysis: cache.putAnalysis };
});

const fetchMock = vi.fn();

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULTS, apiKey: 'sk-test', ...overrides };
}

/** A successful chat completion carrying `content` as the model's reply. */
function completion(content: string, inputTokens = 100, outputTokens = 20): unknown {
  const body = {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone() {
      return this;
    },
  };
}

function httpError(status: number, body: string): unknown {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
    clone() {
      return this;
    },
  };
}

/** The reply the model is supposed to send, for every chunk it was given. */
function scoresFor(chunks: Chunk[], rate: (index: number) => number): string {
  const pairs = chunks.map((chunk, index) => [chunk.id, rate(index)]);
  return JSON.stringify({ scores: pairs });
}

/** What the model actually sends: the same thing, with some entries missing. */
function scoresMissing(chunks: Chunk[], rate: (index: number) => number, skip: number): string {
  const pairs = chunks
    .map((chunk, index) => [chunk.id, rate(index)] as const)
    .filter((_, index) => index % skip !== 0);
  return JSON.stringify({ scores: pairs });
}

function analyze(chunks: Chunk[], overrides: Partial<Settings> = {}, cacheOnly = false) {
  return runAnalysis({
    videoId: 'abc123',
    chunks,
    chapters: [],
    settings: settings(overrides),
    cacheOnly,
  });
}

beforeEach(() => {
  cache.getAnalysis.mockResolvedValue(null);
  cache.putAnalysis.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the cache', () => {
  it('answers from cache with no network call at all', async () => {
    // Rewatching a lecture must cost nothing. This is the assertion that says so.
    const scores: DifficultyScore[] = [{ chunkId: 0, raw: 7, z: 1.2, imputed: false }];
    cache.getAnalysis.mockResolvedValue({ scores });

    const result = await analyze(uniformChunks(20, 30, 150));

    expect(result.ok && result.meta.fromCache).toBe(true);
    expect(result.ok && result.scores).toEqual(scores);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a probe that carries no chunks at all', async () => {
    // The content script probes on every video load and sends no transcript with it, because
    // a lookup is keyed on the video and the model. If the no-content check ever moves back
    // above the lookup, every probe starts answering "no speech to rate" instead.
    const scores: DifficultyScore[] = [{ chunkId: 0, raw: 7, z: 1.2, imputed: false }];
    cache.getAnalysis.mockResolvedValue({ scores });

    const result = await analyze([], {}, true);

    expect(result.ok && result.meta.fromCache).toBe(true);
  });

  it('reports a miss without spending anything when asked for cache only', async () => {
    const result = await analyze(uniformChunks(20, 30, 150), {}, true);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores a completed analysis', async () => {
    const chunks = uniformChunks(20, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresFor(chunks, (i) => (i % 9) + 1)));

    await analyze(chunks);

    expect(cache.putAnalysis).toHaveBeenCalledOnce();
    expect(cache.putAnalysis.mock.calls[0]![0]).toMatchObject({
      videoId: 'abc123',
      model: DEFAULTS.model,
      chunkCount: 20,
    });
  });
});

describe('the cache key', () => {
  it('changes with the video and the model', () => {
    expect(cacheKey('abc', 'gpt-4o-mini')).not.toBe(cacheKey('xyz', 'gpt-4o-mini'));
    expect(cacheKey('abc', 'gpt-4o-mini')).not.toBe(cacheKey('abc', 'llama3'));
  });

  it('does not change with settings applied at plan time', () => {
    // This is the property the whole caching story rests on. Alpha, target wpm and the speed
    // limits are applied to stored scores when the plan is built, so moving those sliders
    // must re-plan instantly rather than re-analyze. Nothing but the video, the model and the
    // two version numbers may enter the key.
    expect(cacheKey('abc', 'gpt-4o-mini')).toBe(
      `abc:gpt-4o-mini:${CHUNKING_VERSION}:${PROMPT_VERSION}`,
    );
  });
});

describe('a complete run', () => {
  it('returns one z-score per chunk and the tokens it cost', async () => {
    const chunks = uniformChunks(20, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresFor(chunks, (i) => (i % 9) + 1), 900, 120));

    const result = await analyze(chunks);

    expect(result.ok).toBe(true);
    expect(result.ok && result.scores).toHaveLength(20);
    expect(result.ok && result.meta.tokensUsed).toBe(1020);
    expect(result.ok && result.meta.imputed).toBe(0);
  });

  it('rates speech and leaves silence out of it', async () => {
    const chunks: Chunk[] = [...uniformChunks(6, 30, 150), silenceChunk(6, 180, 186)];
    fetchMock.mockResolvedValue(completion(scoresFor(chunks.slice(0, 6), (i) => (i % 9) + 1)));

    const result = await analyze(chunks);

    expect(result.ok && result.scores.map((score) => score.chunkId)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('reports what the run cost and how many requests it took', async () => {
    // Without these an analysis that took five minutes gives no clue whether the model was
    // slow, a retry fired, or a batch split. Guessing between those is how a working design
    // gets rebuilt for nothing.
    const chunks = uniformChunks(20, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresFor(chunks, (i) => (i % 9) + 1), 900, 120));

    const result = await analyze(chunks);

    expect(result.ok && result.meta.requests).toBe(1);
    expect(result.ok && result.meta.inputTokens).toBe(900);
    expect(result.ok && result.meta.outputTokens).toBe(120);
    expect(result.ok && result.meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('counts the retry as a second request', async () => {
    const chunks = uniformChunks(20, 30, 150);
    fetchMock
      .mockResolvedValueOnce(completion('Certainly!', 900, 40))
      .mockResolvedValueOnce(completion(scoresFor(chunks, (i) => (i % 9) + 1), 950, 120));

    const result = await analyze(chunks);

    expect(result.ok && result.meta.requests).toBe(2);
    expect(result.ok && result.meta.outputTokens).toBe(160);
  });

  it('refuses a video with nothing to rate, before any request', async () => {
    const result = await analyze([silenceChunk(0, 0, 30)]);

    expect(result.ok === false && result.reason).toBe('no-content');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a damaged response', () => {
  it('repairs a response missing a tenth of its entries', async () => {
    const chunks = uniformChunks(40, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresMissing(chunks, (i) => (i % 9) + 1, 10)));

    const result = await analyze(chunks);

    expect(result.ok).toBe(true);
    expect(result.ok && result.scores).toHaveLength(40);
    expect(result.ok && result.meta.imputed).toBe(4);
  });

  it('falls back rather than invent a curve from a response missing 40 percent', async () => {
    const chunks = uniformChunks(40, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresMissing(chunks, (i) => (i % 9) + 1, 2)));

    const result = await analyze(chunks);

    expect(result.ok === false && result.reason).toBe('too-many-imputed');
    expect(cache.putAnalysis).not.toHaveBeenCalled();
  });

  it('falls back when the model rated everything the same', async () => {
    const chunks = uniformChunks(20, 30, 150);
    fetchMock.mockResolvedValue(completion(scoresFor(chunks, () => 6)));

    const result = await analyze(chunks);

    expect(result.ok === false && result.reason).toBe('no-discrimination');
    expect(cache.putAnalysis).not.toHaveBeenCalled();
  });
});

describe('a reply that is not JSON', () => {
  it('asks once more and succeeds', async () => {
    const chunks = uniformChunks(20, 30, 150);
    fetchMock
      .mockResolvedValueOnce(completion('Certainly! Here are my ratings.'))
      .mockResolvedValueOnce(completion(scoresFor(chunks, (i) => (i % 9) + 1)));

    const result = await analyze(chunks);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the model its own bad reply on the retry', async () => {
    // Repeating an identical request to a temperature-0 endpoint produces an identical
    // answer. The retry only has a reason to work because it says what went wrong.
    const chunks = uniformChunks(20, 30, 150);
    fetchMock
      .mockResolvedValueOnce(completion('Certainly!'))
      .mockResolvedValueOnce(completion(scoresFor(chunks, (i) => (i % 9) + 1)));

    await analyze(chunks);

    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[2]!.content).toBe('Certainly!');
    expect(body.messages[3]!.content).toMatch(/could not be parsed/);
  });

  it('gives up after exactly one retry', async () => {
    fetchMock.mockResolvedValue(completion('Still not JSON, sorry.'));

    const result = await analyze(uniformChunks(20, 30, 150));

    expect(result.ok === false && result.reason).toBe('unparseable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a provider that refuses', () => {
  it('passes the provider\'s own error text back', async () => {
    fetchMock.mockResolvedValue(
      httpError(401, JSON.stringify({ error: { message: 'Incorrect API key provided.' } })),
    );

    const result = await analyze(uniformChunks(20, 30, 150));

    expect(result.ok === false && result.reason).toBe('auth');
    expect(result.ok === false && result.message).toBe('Incorrect API key provided.');
  });

  it('reports a rate limit as its own thing', async () => {
    fetchMock.mockResolvedValue(httpError(429, '{"error":{"message":"Rate limit reached."}}'));

    const result = await analyze(uniformChunks(20, 30, 150));

    expect(result.ok === false && result.reason).toBe('rate-limit');
  });

  it('reports an unreachable endpoint without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await analyze(uniformChunks(20, 30, 150));

    expect(result.ok === false && result.reason).toBe('network');
  });

  it('refuses to send anything without a key', async () => {
    const result = await analyze(uniformChunks(20, 30, 150), { apiKey: '  ' });

    expect(result.ok === false && result.reason).toBe('no-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries without json mode when the endpoint rejects that parameter', async () => {
    // Local runtimes and older proxies frequently 400 on a parameter they do not implement.
    // The prompt demands raw JSON on its own, so the parameter is a help, not a requirement.
    const chunks = uniformChunks(20, 30, 150);
    fetchMock
      .mockResolvedValueOnce(httpError(400, '{"error":{"message":"response_format unsupported"}}'))
      .mockResolvedValueOnce(completion(scoresFor(chunks, (i) => (i % 9) + 1)));

    const result = await analyze(chunks);

    expect(result.ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).response_format).toBeDefined();
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).response_format).toBeUndefined();
  });
});

describe('a video long enough to need splitting', () => {
  it('sends one request per batch and rates every chunk once', async () => {
    const chunks = uniformChunks(400, 30, 150);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      // Answer whatever ids this batch was actually given, anchors included.
      const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const ids = [...body.messages[1]!.content.matchAll(/^\[(\d+)]/gm)].map((match) =>
        Number(match[1]),
      );
      return Promise.resolve(completion(JSON.stringify({ scores: ids.map((id) => [id, (id % 9) + 1]) })));
    });

    const result = await analyze(chunks);

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.ok && result.scores).toHaveLength(400);
    expect(result.ok && result.meta.imputed).toBe(0);
  });
});
