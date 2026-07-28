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
 */

import { DEFAULTS } from '../core/types.ts';
import type { Settings } from '../core/types.ts';

const STORAGE_KEY = 'settings';

/** Keeps a stored blob from contributing junk types to the merged result. */
function pickValid(stored: Record<string, unknown>): Partial<Settings> {
  const result: Record<string, unknown> = {};

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = stored[key];
    if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) {
      result[key] = value;
    }
  }

  return result as Partial<Settings>;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY];
    if (raw === null || typeof raw !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...pickValid(raw as Record<string, unknown>) };
  } catch {
    // A storage failure must not stop the extension working; defaults are a valid product.
    return { ...DEFAULTS };
  }
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...partial } });
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
    if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
    void loadSettings().then(onChange);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
