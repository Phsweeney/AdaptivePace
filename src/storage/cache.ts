/**
 * The IndexedDB cache of completed difficulty analyses.
 *
 * An analysis is the only expensive thing this extension does, and it is perfectly
 * reusable: the same video chunked the same way and asked the same question gets the same
 * answer. Rewatching a lecture, or coming back to one a week later, must cost nothing.
 *
 * This lives in the service worker and only there, for the same reason the provider request
 * does. It is also why the store is IndexedDB rather than chrome.storage.local: a few
 * hundred analyses of a hundred-odd chunks each is more than the storage area is meant for,
 * and IndexedDB is available in a worker while localStorage is not.
 */

import { CHUNKING_VERSION } from '../core/chunking.ts';
import { PROMPT_VERSION } from '../core/prompt.ts';
import type { DifficultyScore } from '../core/types.ts';

const DB_NAME = 'adaptive-playback';
const DB_VERSION = 1;
const STORE = 'analyses';
const LAST_USED_INDEX = 'lastUsed';

/** Cap from spec 7.5. Roughly a year of heavy use before anything is evicted. */
export const MAX_ENTRIES = 500;

export interface CachedAnalysis {
  key: string;
  videoId: string;
  model: string;
  chunkCount: number;
  scores: DifficultyScore[];
  /** Total tokens the provider reported, or 0 if it reported none. */
  tokensUsed: number;
  createdAt: number;
  lastUsed: number;
}

/**
 * What an analysis is a function of, and nothing else.
 *
 * Note what is deliberately absent: alpha, target wpm, and the speed limits. Those are
 * applied at plan time from the same scores, so moving those sliders must re-plan instantly
 * from cache rather than re-analyze. Only re-chunking the video or changing the question
 * asked can invalidate a stored answer, which is exactly the two version numbers plus the
 * model that answered.
 */
export function cacheKey(videoId: string, model: string): string {
  return `${videoId}:${model}:${CHUNKING_VERSION}:${PROMPT_VERSION}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex(LAST_USED_INDEX, 'lastUsed');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Every entry point swallows storage failures and reports the miss.
 *
 * A browser with IndexedDB unavailable, a quota refusal, or a corrupted database must cost
 * the user a repeated analysis, not a broken extension. The cache is an optimisation and is
 * treated as one.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fallback: T,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    const transaction = db.transaction(STORE, mode);
    const result = await run(transaction.objectStore(STORE));
    return result;
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

export async function getAnalysis(key: string): Promise<CachedAnalysis | null> {
  const found = await withStore<CachedAnalysis | null>('readonly', null, async (store) => {
    const record = await promisify(store.get(key));
    return (record as CachedAnalysis | undefined) ?? null;
  });

  if (found === null) return null;

  // Touching lastUsed is what makes the eviction order least-recently-used rather than
  // oldest-first. A failure here loses nothing worth reporting, so it is not awaited into
  // the caller's path.
  void withStore('readwrite', undefined, async (store) => {
    await promisify(store.put({ ...found, lastUsed: Date.now() }));
  });

  return found;
}

/**
 * Deletes the least recently used entries until the store is back under the cap.
 *
 * Walks the lastUsed index with a cursor rather than reading every record and sorting.
 * Each record holds a full score array, so `getAll` here would deserialize a few hundred
 * of them on every single write to decide that nothing needs deleting.
 */
async function evictOldest(store: IDBObjectStore, overBy: number): Promise<void> {
  if (overBy <= 0) return;

  await new Promise<void>((resolve, reject) => {
    let remaining = overBy;
    const request = store.index(LAST_USED_INDEX).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || remaining === 0) return resolve();
      cursor.delete();
      remaining -= 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function putAnalysis(
  entry: Omit<CachedAnalysis, 'createdAt' | 'lastUsed'>,
): Promise<void> {
  const now = Date.now();
  await withStore('readwrite', undefined, async (store) => {
    await promisify(store.put({ ...entry, createdAt: now, lastUsed: now }));
    await evictOldest(store, (await promisify(store.count())) - MAX_ENTRIES);
  });
}

/** Returns how many entries were removed, for the options page to report. */
export async function clearAnalyses(): Promise<number> {
  return withStore('readwrite', 0, async (store) => {
    const count = await promisify(store.count());
    await promisify(store.clear());
    return count;
  });
}
