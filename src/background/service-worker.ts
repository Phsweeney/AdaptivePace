/**
 * Background service worker.
 *
 * A message router and nothing else for now. It exists at this stage so the manifest, the
 * module format, and the message plumbing are settled and exercised before there is anything
 * important flowing through them.
 *
 * When the difficulty layer arrives this is where it goes, and the reason is security rather
 * than tidiness. The provider API key must never be readable from a content script, because
 * a content script shares a page with YouTube's own JavaScript. So every provider request
 * originates here, the content script sends a transcript and receives scores, and no
 * credential ever crosses into the page's process.
 */

export interface AnalyzeRequest {
  type: 'ANALYZE';
  videoId: string;
}

export type BackgroundResponse =
  | { ok: true; scores: unknown[] }
  | { ok: false; reason: string; message: string };

function isAnalyzeRequest(value: unknown): value is AnalyzeRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as AnalyzeRequest).type === 'ANALYZE'
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isAnalyzeRequest(message)) return false;

  const response: BackgroundResponse = {
    ok: false,
    reason: 'not-implemented',
    message: 'Difficulty analysis is not part of this build yet.',
  };
  sendResponse(response);
  return false;
});
