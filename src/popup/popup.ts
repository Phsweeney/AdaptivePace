/**
 * The toolbar popup.
 *
 * Everything shown here is read from the content script on the active tab, because the
 * content script is the only thing that knows what the player is actually doing. Whether the
 * current tab is a YouTube video is answered by whether anything replies, which is why this
 * needs no `tabs` permission: the tab id alone is enough to send a message, and a missing
 * receiver is a normal answer rather than an error.
 */

import { formatDuration } from '../core/stats.ts';
import { UNAVAILABLE_STATE } from '../content/messages.ts';
import type { PopupRequest, VideoState } from '../content/messages.ts';

const LABELS: Record<VideoState['status'], string> = {
  loading: 'Reading transcript...',
  pacing: 'Adjusting speed',
  'paused-for-video': 'Paused for this video',
  'suspended-by-viewer': 'You set the speed manually',
  disabled: 'Switched off',
  'no-captions': 'No usable transcript',
  'too-long': 'Video too long',
  'not-a-watch-page': 'Not a YouTube video',
};

const ACTIVE: ReadonlySet<VideoState['status']> = new Set(['pacing']);

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found as T;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function ask(request: PopupRequest): Promise<VideoState> {
  const tabId = await activeTabId();
  if (tabId === null) return UNAVAILABLE_STATE;

  try {
    const reply = (await chrome.tabs.sendMessage(tabId, request)) as VideoState | undefined;
    return reply ?? UNAVAILABLE_STATE;
  } catch {
    // No content script on this tab. Not an error, just not a YouTube video.
    return UNAVAILABLE_STATE;
  }
}

function render(state: VideoState): void {
  const showSpeed = state.status !== 'not-a-watch-page' && state.status !== 'disabled';
  const showNumbers = state.originalDurationSec > 0;

  element('status').textContent = LABELS[state.status];
  element('dot').classList.toggle('active', ACTIVE.has(state.status));

  element('speed').hidden = !showSpeed;
  element('speedValue').textContent = state.currentSpeed.toFixed(2);

  element('numbers').hidden = !showNumbers;
  if (showNumbers) {
    const saved = Math.round(
      (1 - state.estimatedWatchTimeSec / state.originalDurationSec) * 100,
    );
    element('original').textContent = formatDuration(state.originalDurationSec);
    element('watch').textContent = formatDuration(state.estimatedWatchTimeSec);
    element('saved').textContent = `${saved}%`;
  }

  element('note').textContent = state.message;

  const pauseRow = element('pauseRow');
  pauseRow.hidden = state.videoId === null || state.status === 'disabled';
  element<HTMLInputElement>('paused').checked = state.status === 'paused-for-video';
}

async function main(): Promise<void> {
  render(await ask({ type: 'GET_STATE' }));

  element<HTMLInputElement>('paused').addEventListener('change', (event) => {
    const paused = (event.target as HTMLInputElement).checked;
    void ask({ type: 'SET_PAUSED', paused }).then(render);
  });

  element('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // The speed moves while the popup is open, so keep it live rather than showing a snapshot
  // that goes stale the moment it is drawn.
  const timer = setInterval(() => {
    void ask({ type: 'GET_STATE' }).then(render);
  }, 1000);
  window.addEventListener('unload', () => clearInterval(timer));
}

void main();
