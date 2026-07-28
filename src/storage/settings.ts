/**
 * Reading and writing user settings.
 *
 * Everything lives in chrome.storage.local and nothing goes in chrome.storage.sync. That is
 * not a preference. Sync replicates through Google's servers to every device signed into the
 * profile, and the provider API key is one of these fields. Local storage protects against
 * casual inspection, not against a compromised browser profile, and the options page says so
 * in as many words.
 *
 * Stored values are always layered over DEFAULTS rather than used directly, so a setting
 * added in a later version reads as its default for someone whose stored blob predates it,
 * instead of arriving as undefined halfway down the pacing math.
 *
 * **The API key is stored under its own storage entry, apart from everything else.** That is
 * what lets `loadPublicSettings` be honestly key-free: it reads the settings entry and never
 * asks for the key entry at all, so no code path in the content script ever holds the
 * credential, not even for the moment it would take to strip it out of a larger object.
 */

import { DEFAULTS } from '../core/types.ts';
import type { Settings } from '../core/types.ts';

const STORAGE_KEY = 'settings';
const API_KEY_STORAGE_KEY = 'apiKey';

/** Keeps a stored blob from contributing junk types to the merged result. */
function pickValid(stored: Record<string, unknown>): Partial<Settings> {
  const result: Record<string, unknown> = {};

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (key === 'apiKey') continue;
    const value = stored[key];
    if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) {
      result[key] = value;
    }
  }

  return result as Partial<Settings>;
}

async function readArea(keys: string[]): Promise<Record<string, unknown>> {
  try {
    return await chrome.storage.local.get(keys);
  } catch {
    // A storage failure must not stop the extension working; defaults are a valid product.
    return {};
  }
}

/**
 * Everything except the credential, plus whether there is one.
 *
 * This is what the content script loads, and the difference is not cosmetic. Spec 6.3
 * requires that the API key is never present in content-script scope, because a content
 * script shares a page with YouTube's own JavaScript. The content script still needs to know
 * whether difficulty scoring is possible at all, so it is told that as a boolean and never
 * given the thing itself.
 *
 * `baseUrl` goes too, since it is no use without the key. `model` stays: it is not a secret,
 * and it names which analysis is cached, so a caller holding scores needs it to notice they
 * were produced by a model that is no longer selected.
 */
export type PublicSettings = Omit<Settings, 'baseUrl' | 'apiKey'> & {
  hasApiKey: boolean;
};

/**
 * Written into the settings entry so that whether a key exists can be read without reading
 * the key. Derived state, and therefore only ever written by `saveSettings`, which is the one
 * function that can change the key.
 */
const HAS_KEY_FIELD = 'hasApiKey';

export async function loadSettings(): Promise<Settings> {
  const stored = await readArea([STORAGE_KEY, API_KEY_STORAGE_KEY]);
  const raw = stored[STORAGE_KEY];
  const apiKey = stored[API_KEY_STORAGE_KEY];

  return {
    ...DEFAULTS,
    ...(raw !== null && typeof raw === 'object'
      ? pickValid(raw as Record<string, unknown>)
      : {}),
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
  };
}

export async function loadPublicSettings(): Promise<PublicSettings> {
  const stored = await readArea([STORAGE_KEY]);
  const raw = (
    stored[STORAGE_KEY] !== null && typeof stored[STORAGE_KEY] === 'object'
      ? stored[STORAGE_KEY]
      : {}
  ) as Record<string, unknown>;

  const { baseUrl: _baseUrl, apiKey: _apiKey, ...defaults } = DEFAULTS;
  const { baseUrl: _storedBaseUrl, ...merged } = { ...defaults, ...pickValid(raw) };

  return { ...merged, hasApiKey: raw[HAS_KEY_FIELD] === true };
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  const { apiKey, ...rest } = partial;
  const current = await loadSettings();
  const { apiKey: _currentKey, ...currentRest } = current;

  const nextKey = apiKey ?? current.apiKey;
  const settings: Record<string, unknown> = {
    ...currentRest,
    ...rest,
    [HAS_KEY_FIELD]: nextKey.trim().length > 0,
  };

  const write: Record<string, unknown> = { [STORAGE_KEY]: settings };
  if (apiKey !== undefined) write[API_KEY_STORAGE_KEY] = apiKey;

  try {
    await chrome.storage.local.set(write);
  } catch {
    // Nothing useful to do. The options page keeps showing what the user typed, and the
    // extension carries on with whatever it already loaded.
  }
}

/**
 * Calls back whenever settings change, in any context.
 *
 * Used by the content script to re-plan while a slider is moving. Returns an unsubscribe
 * function, because a content script that fails to detach this leaks a listener per SPA
 * navigation.
 */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEY in changes) && !(API_KEY_STORAGE_KEY in changes)) return;
    void loadSettings().then(onChange);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * `watchSettings` for callers that must not be handed the key.
 *
 * Watches the settings entry only. Adding or removing a key still gets through, because that
 * flips `hasApiKey` inside that same entry.
 */
export function watchPublicSettings(onChange: (settings: PublicSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
    void loadPublicSettings().then(onChange);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
