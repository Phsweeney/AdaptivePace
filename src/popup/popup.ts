/**
 * The toolbar popup, which is the whole user interface of this extension while a video is
 * playing.
 *
 * Everything shown here is read from the content script on the active tab, because the
 * content script is the only thing that knows what the player is actually doing. Whether the
 * current tab is a YouTube video is answered by whether anything replies, which is why this
 * needs no `tabs` permission: the tab id alone is enough to send a message, and a missing
 * receiver is a normal answer rather than an error.
 *
 * There is one button and it does one thing: turn adaptive playback on for this video, which
 * also rates the video's difficulty if a provider is configured. Enabling is per video and is
 * forgotten on navigation, so nothing runs and nothing is spent without a deliberate click.
 *
 * Note what this file does *not* do: ask for the provider's host permission. That looks like
 * it belongs on this click, since `chrome.permissions.request` needs a user gesture and this
 * is the only gesture in the flow. It cannot live here, because Chrome dismisses an extension
 * popup when a permission prompt takes focus, which destroys this script mid-click and the
 * enable message is never sent. The options page is a tab and survives the prompt, so the
 * permission is asked for there and this button simply reports if it is missing.
 */

import { formatDuration } from '../core/stats.ts';
import { UNAVAILABLE_STATE } from '../content/messages.ts';
import type {
  AnalysisView,
  CurrentChunkView,
  PopupRequest,
  VideoState,
} from '../content/messages.ts';

const LABELS: Record<VideoState['status'], string> = {
  loading: 'Reading transcript...',
  ready: 'Ready',
  pacing: 'Adjusting speed',
  'suspended-by-viewer': 'You set the speed manually',
  disabled: 'Switched off',
  'no-captions': 'No usable transcript',
  'too-long': 'Video too long',
  'not-a-watch-page': 'Not a YouTube video',
};

/** Statuses where the button is worth showing at all. */
const ACTIONABLE: ReadonlySet<VideoState['status']> = new Set([
  'ready',
  'pacing',
  'suspended-by-viewer',
]);

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

/** One line about difficulty rating, or nothing when there is nothing useful to say. */
function describeAnalysis(analysis: AnalysisView, enabled: boolean): string {
  switch (analysis.state) {
    case 'unavailable':
      return analysis.message;
    case 'idle':
      return enabled
        ? ''
        : `Rating difficulty will use about ${analysis.estimatedTokens.toLocaleString()} tokens.`;
    case 'cached':
      return 'Already analyzed, so this one is free.';
    case 'running':
      return 'Rating difficulty...';
    case 'ready': {
      const parts: string[] = ['Difficulty rated'];
      if (analysis.tokensUsed > 0) {
        parts.push(`${analysis.tokensUsed.toLocaleString()} tokens`);
      }
      if (analysis.imputed > 0) {
        parts.push(`${analysis.imputed} gaps filled in`);
      }
      return `${parts.join(', ')}.`;
    }
    case 'failed':
      return analysis.message;
  }
}

/**
 * The difficulty of the moment being watched, in words.
 *
 * The z-score is the number the engine actually acts on, so it is shown alongside the 1-10
 * rating rather than instead of it. A rating of 7 means nothing without knowing whether 7 is
 * high for this video, and that is exactly what the z-score says.
 */
function describeDifficulty(current: CurrentChunkView): string {
  if (current.kind === 'silence') return 'pause';
  if (current.raw === null || current.z === null) return 'not rated';

  const band =
    current.z >= 1 ? 'harder' : current.z <= -1 ? 'easier' : 'about average';
  const sign = current.z >= 0 ? '+' : '';
  const suffix = current.imputed ? ', filled in' : '';

  return `${current.raw}/10, ${band} (${sign}${current.z.toFixed(1)} sd)${suffix}`;
}

/** A one-line record of what the last analysis cost, so a slow run explains itself. */
function describeTiming(analysis: AnalysisView): string {
  if (analysis.state !== 'ready' || analysis.elapsedMs === 0) return '';

  const seconds = (analysis.elapsedMs / 1000).toFixed(1);
  const requests = analysis.requests === 1 ? '1 request' : `${analysis.requests} requests`;
  return `${seconds}s, ${requests}, ${analysis.inputTokens.toLocaleString()} in / ${analysis.outputTokens.toLocaleString()} out`;
}

function render(state: VideoState): void {
  const showSpeed = state.enabled;
  const showNumbers = state.originalDurationSec > 0;

  element('status').textContent = LABELS[state.status];
  element('dot').classList.toggle('active', state.enabled);

  element('speed').hidden = !showSpeed;
  element('speedValue').textContent = state.currentSpeed.toFixed(2);

  element('numbers').hidden = !showNumbers;
  if (showNumbers) {
    const saved = Math.round(
      (1 - state.estimatedWatchTimeSec / state.originalDurationSec) * 100,
    );
    element('original').textContent = formatDuration(state.originalDurationSec);
    // Before the click this is a projection, afterwards it is what is happening.
    element('watch').textContent = formatDuration(state.estimatedWatchTimeSec);
    element('saved').textContent = `${saved}%`;
  }

  const moment = element('moment');
  moment.hidden = state.current === null;
  if (state.current !== null) {
    element('momentDifficulty').textContent = describeDifficulty(state.current);
    element('momentWpm').textContent =
      state.current.kind === 'silence' ? '-' : `${Math.round(state.current.nativeWpm)} wpm`;
    // The plan's speed, not the element's. Before enabling there is nothing driving the
    // player, and this row is what says what enabling would do.
    element('momentSpeed').textContent = `${state.current.speed.toFixed(2)}x`;
  }

  element('note').textContent = state.message;
  element('analysisNote').textContent = describeAnalysis(state.analysis, state.enabled);
  element('timingNote').textContent = describeTiming(state.analysis);

  const toggle = element<HTMLButtonElement>('toggle');
  toggle.hidden = !ACTIONABLE.has(state.status);
  toggle.textContent = state.enabled ? 'Turn off for this video' : 'Enable for this video';
  toggle.classList.toggle('on', state.enabled);
}

async function main(): Promise<void> {
  let state = await ask({ type: 'GET_STATE' });
  render(state);

  element('toggle').addEventListener('click', () => {
    const enabling = !state.enabled;

    void (async () => {
      state = await ask({ type: 'SET_ENABLED', enabled: enabling });
      render(state);
    })();
  });

  element('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // The speed moves and the analysis lands while the popup is open, so keep it live rather
  // than showing a snapshot that goes stale the moment it is drawn.
  const timer = setInterval(() => {
    void ask({ type: 'GET_STATE' }).then((next) => {
      state = next;
      render(next);
    });
  }, 1000);
  window.addEventListener('unload', () => clearInterval(timer));
}

void main();
