/**
 * Background service worker: a router, and the trust boundary.
 *
 * Everything that touches the provider API key happens on this side of it. A content script
 * shares a page with YouTube's own JavaScript, so a key that reached one would be readable
 * by the page. The content script sends chunks and receives z-scores; no credential ever
 * crosses into the page's process, and nothing here is ever imported by content-script code.
 *
 * Two things about this file are easy to get wrong and silent when you do.
 *
 * The listener returns true and calls sendResponse later, because every handler is async. A
 * listener that returns false has its message port closed the moment it returns, and the
 * eventual sendResponse goes nowhere without an error anybody sees.
 *
 * The host permission for a user-configured base URL cannot be requested from here.
 * chrome.permissions.request needs a user gesture and a worker has none, so this file only
 * ever checks. Asking is the job of the popup's Enable button and the options page's Test
 * connection button, both of which run inside a real click.
 */

import { loadSettings } from '../storage/settings.ts';
import { clearAnalyses } from '../storage/cache.ts';
import { runAnalysis } from './analysis.ts';
import { isBackgroundRequest } from './messages.ts';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ClearCacheResponse,
  TestConnectionResponse,
} from './messages.ts';
import { originPattern, testConnection } from './provider.ts';

async function hasProviderPermission(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  if (origin === null) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function handleAnalyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const settings = await loadSettings();

  // The permission check is skipped for a cache-only lookup, which never leaves the browser.
  // Refusing it for a missing permission would hide already-paid-for scores behind a prompt
  // the user has no reason to answer.
  if (!request.cacheOnly && !(await hasProviderPermission(settings.baseUrl))) {
    return {
      ok: false,
      reason: 'needs-permission',
      message: 'Allow access to your model provider from the extension options first.',
    };
  }

  return runAnalysis({
    videoId: request.videoId,
    chunks: request.chunks,
    chapters: request.chapters,
    settings,
    cacheOnly: request.cacheOnly ?? false,
  });
}

async function handleTestConnection(): Promise<TestConnectionResponse> {
  const settings = await loadSettings();

  if (!(await hasProviderPermission(settings.baseUrl))) {
    return {
      ok: false,
      message: 'The extension does not have permission to reach this base URL yet.',
    };
  }

  const result = await testConnection(settings);
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

async function handleClearCache(): Promise<ClearCacheResponse> {
  return { cleared: await clearAnalyses() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isBackgroundRequest(message)) return false;

  const work =
    message.type === 'ANALYZE'
      ? handleAnalyze(message)
      : message.type === 'TEST_CONNECTION'
        ? handleTestConnection()
        : handleClearCache();

  // An unexpected throw must still answer, or the caller waits forever on a port that never
  // closes cleanly. Nothing below is expected to reject; this is the backstop.
  void work.then(sendResponse, (error: unknown) => {
    sendResponse({
      ok: false,
      reason: 'network',
      message: error instanceof Error ? error.message : 'The analysis failed unexpectedly.',
    });
  });

  return true;
});
