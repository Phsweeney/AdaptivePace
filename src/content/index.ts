/**
 * Content script entry point, isolated world. Owns the lifecycle of one video.
 *
 * YouTube never reloads between videos, so setup and teardown are driven by
 * yt-navigate-finish rather than by page load. That event fires more than once per
 * navigation, so the handler is guarded by the video id it last set up.
 *
 * The manifest matches all of youtube.com rather than just watch pages, and this file
 * filters. Matching only watch pages would mean never being injected at all for anyone who
 * arrives from the homepage or a search result, since those navigations do not load a
 * document. Everything below no-ops off a watch page.
 *
 * **Loading a video changes nothing about playback.** Everything up to and including a
 * finished speed plan happens automatically, and none of it is applied until the viewer
 * presses the button in the popup. The player element is not even attached to before then.
 * That is the point: an extension that starts moving the speed around on a video the viewer
 * did not ask it to touch is a worse extension, and the same click that turns pacing on is
 * the consent to spend tokens rating the video's difficulty.
 *
 * Ordering here matters more than it looks. The duration cap is checked before the
 * transcript is fetched, because obtaining a proof-of-origin token can take twelve seconds
 * and there is no reason to spend that on a video that is about to be refused.
 */

import { buildChunks } from '../core/chunking.ts';
import { computeSpeedPlan } from '../core/pacing.ts';
import { findSegmentAt, findSpanAt } from '../core/plan.ts';
import {
  buildUserMessage,
  estimateInputTokens,
  scoreableChunks,
  SYSTEM_PROMPT,
} from '../core/prompt.ts';
import { loadPublicSettings, watchPublicSettings } from '../storage/settings.ts';
import type { PublicSettings } from '../storage/settings.ts';
import type { Chunk, DifficultyScore, SpeedPlan, Transcript } from '../core/types.ts';
import type { AnalyzeRequest, AnalyzeResponse } from '../background/messages.ts';
import { mountDevPanel, unmountDevPanel } from './dev-panel.ts';
import { IDLE_ANALYSIS, isPopupRequest, UNAVAILABLE_STATE } from './messages.ts';
import type {
  AnalysisView,
  CurrentChunkView,
  VideoState,
  VideoStatus,
} from './messages.ts';
import { getVideoIdFromUrl } from './page-data.ts';
import { attachPlayer } from './player.ts';
import type { PlayerController } from './player.ts';
import { extractTranscript, getPlayerDuration } from './transcript.ts';
import type { ExtractionResult } from './transcript.ts';

declare const DEV_TOOLS: boolean;

const VIDEO_WAIT_MS = 20_000;
const VIDEO_POLL_MS = 250;

interface ActiveVideo {
  videoId: string;
  transcript: Transcript | null;
  chunks: Chunk[];
  plan: SpeedPlan | null;
  /** Already z-scored. Held whether or not pacing is on, so enabling is instant. */
  scores: DifficultyScore[] | null;
  settings: PublicSettings;
  status: VideoStatus;
  message: string;
  /** Per video and deliberately not remembered. Every video starts off. */
  enabled: boolean;
  analysis: AnalysisView;
}

let active: ActiveVideo | null = null;
let controller: PlayerController | null = null;
let stopWatchingSettings: (() => void) | null = null;

/**
 * Incremented on every teardown so an in-flight setup can tell it has been superseded.
 * Extraction is slow enough that a viewer can easily navigate away mid-run, and without
 * this the stale run would happily install a plan for the previous video.
 */
let generation = 0;

function waitForVideo(deadline: number): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const poll = () => {
      const video = document.querySelector<HTMLVideoElement>('video.html5-main-video');
      if (video) return resolve(video);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, VIDEO_POLL_MS);
    };
    poll();
  });
}

/** Waits for the player to know how long the video is, so the cap can be applied early. */
function waitForDuration(video: HTMLVideoElement, deadline: number): Promise<number | null> {
  return new Promise((resolve) => {
    const poll = () => {
      const duration = getPlayerDuration();
      if (duration !== null) return resolve(duration);
      if (Date.now() >= deadline || video.readyState >= 1) return resolve(getPlayerDuration());
      setTimeout(poll, VIDEO_POLL_MS);
    };
    poll();
  });
}

/** Re-plans from whatever is currently in memory. Never re-extracts and never re-analyzes. */
function replan(): void {
  if (active === null || active.transcript === null) return;
  active.plan = computeSpeedPlan(
    active.transcript,
    active.chunks,
    active.scores,
    active.settings,
  );
  applyPlan();
}

/** Pushes the current plan at the player, if the viewer has actually switched this one on. */
function applyPlan(): void {
  if (active === null || controller === null || active.plan === null) return;
  const chapterStarts = (active.transcript?.chapters ?? []).map((chapter) => chapter.start);
  controller.setPlan(active.plan, chapterStarts);
}

/** True when a difficulty analysis is possible at all: a key exists and alpha is not zero. */
function canAnalyze(settings: PublicSettings): boolean {
  return settings.hasApiKey && settings.alpha > 0;
}

function unavailableReason(settings: PublicSettings): string {
  if (!settings.hasApiKey) return 'Difficulty rating is off. Add a model provider in settings.';
  return 'Difficulty rating is off. Turn up the difficulty slider in settings.';
}

function ask(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  return chrome.runtime.sendMessage(request) as Promise<AnalyzeResponse>;
}

/**
 * Asks whether this video has already been analyzed, without any possibility of spending.
 *
 * Runs on load rather than on the click so the popup can say "already analyzed, no cost"
 * before the viewer decides. A hit also re-plans immediately, so the time saving shown in
 * the popup is the one the scores actually produce rather than the alpha = 0 estimate.
 */
async function probeCache(run: number): Promise<void> {
  if (active === null || !canAnalyze(active.settings)) return;

  // No chunks. A cache lookup is keyed on the video and the model, so sending the whole
  // transcript across the message port to ask about a key would be pure cost, on every
  // video load, for a question that is usually answered "no".
  const request: AnalyzeRequest = {
    type: 'ANALYZE',
    videoId: active.videoId,
    chunks: [],
    chapters: [],
    cacheOnly: true,
  };

  const response = await ask(request).catch(() => null);
  if (active === null || run !== generation) return;

  if (response?.ok) {
    active.scores = response.scores;
    active.analysis = {
      ...active.analysis,
      state: 'cached',
      message: '',
      imputed: response.meta.imputed,
    };
    replan();
  }
}

/** The real thing. Only ever reached from a viewer's click. */
async function analyze(run: number): Promise<void> {
  if (active === null) return;

  active.analysis = { ...active.analysis, state: 'running', message: '' };

  const request: AnalyzeRequest = {
    type: 'ANALYZE',
    videoId: active.videoId,
    chunks: active.chunks,
    chapters: active.transcript?.chapters ?? [],
  };

  const response = await ask(request).catch(
    (): AnalyzeResponse => ({
      ok: false,
      reason: 'network',
      message: 'The extension background service did not respond.',
    }),
  );
  if (active === null || run !== generation) return;

  if (!response.ok) {
    // Pacing stays on. The click meant "pace this video", not "pace this video if the
    // model cooperates", and the speech-rate plan is already running and already useful.
    active.analysis = { ...active.analysis, state: 'failed', message: response.message };
    return;
  }

  active.scores = response.scores;
  active.analysis = {
    ...active.analysis,
    state: 'ready',
    message: '',
    imputed: response.meta.imputed,
    tokensUsed: response.meta.tokensUsed,
    inputTokens: response.meta.inputTokens,
    outputTokens: response.meta.outputTokens,
    elapsedMs: response.meta.elapsedMs,
    requests: response.meta.requests,
  };
  replan();
}

/**
 * The button.
 *
 * Enabling applies the speech-rate plan first and asks the model afterwards. The other order
 * would leave the video at 1x for several seconds after the viewer asked for the opposite,
 * and the alpha = 0 plan is a complete product rather than a placeholder: the scores are an
 * improvement applied to a system that is already running.
 */
function setEnabled(enabled: boolean): void {
  if (active === null || active.transcript === null) return;
  if (active.enabled === enabled) return;
  // 'disabled' is the master switch in options being off, and no per-video button overrides
  // it. Anything else without a transcript has already returned above.
  if (enabled && active.status !== 'ready') return;

  active.enabled = enabled;

  if (!enabled) {
    // detach restores 1.0, so nothing of ours is left on the element.
    controller?.detach();
    controller = null;
    active.status = 'ready';
    return;
  }

  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (video === null) return;

  controller ??= attachPlayer(video);
  active.status = 'pacing';
  applyPlan();

  if (active.scores === null && canAnalyze(active.settings)) void analyze(generation);
}

/**
 * What the plan says about the moment being watched right now.
 *
 * Read off the chunks rather than off the plan's segments, because segments are consolidated:
 * neighbours within five percent of each other are merged and their difficulty is blended.
 * That is right for driving playback and wrong for answering "how hard is this bit", which is
 * a question about one chunk and the rating it was actually given.
 *
 * The video element is queried directly rather than going through the controller, so this
 * still answers before the viewer has switched anything on. That is the case where it is most
 * useful: it says what enabling would do.
 */
function currentChunk(): CurrentChunkView | null {
  if (active === null || active.chunks.length === 0) return null;

  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (video === null) return null;

  const chunk = findSpanAt(active.chunks, video.currentTime);
  if (chunk === null) return null;

  const score = active.scores?.find((entry) => entry.chunkId === chunk.id) ?? null;
  const segment = active.plan === null ? null : findSegmentAt(active.plan.segments, chunk.start);

  return {
    kind: chunk.kind,
    raw: score?.raw ?? null,
    z: score?.z ?? null,
    imputed: score?.imputed ?? false,
    nativeWpm: chunk.nativeWpm,
    speed: segment?.speed ?? 1,
  };
}

function currentState(): VideoState {
  if (active === null) return UNAVAILABLE_STATE;

  const status = controller?.getStatus();
  const effective =
    active.status === 'pacing' && status?.suspendedByViewer
      ? 'suspended-by-viewer'
      : active.status;

  return {
    status: effective,
    message: active.message,
    videoId: active.videoId,
    enabled: active.enabled,
    currentSpeed: status?.currentSpeed ?? 1,
    originalDurationSec: active.plan?.meta.originalDurationSec ?? 0,
    estimatedWatchTimeSec: active.plan?.meta.estimatedWatchTimeSec ?? 0,
    analysis: active.analysis,
    current: currentChunk(),
  };
}

function teardown(): void {
  generation += 1;
  controller?.detach();
  controller = null;
  stopWatchingSettings?.();
  stopWatchingSettings = null;
  active = null;
  if (DEV_TOOLS) unmountDevPanel();
}

function onSettingsChanged(settings: PublicSettings): void {
  if (active === null) return;

  // Scores are keyed to the model that produced them, and the cache entry they came from is
  // keyed the same way. A different model means these are somebody else's answers.
  if (settings.model !== active.settings.model) active.scores = null;
  active.settings = settings;

  if (!settings.enabled) {
    controller?.detach();
    controller = null;
    active.enabled = false;
    active.status = 'disabled';
    active.message = 'Adaptive playback is switched off in settings.';
    return;
  }

  if (active.transcript === null) {
    // Switched on while sitting on a page that was skipped for being off or over the length
    // cap. There is no transcript to re-plan from, so start the whole run properly rather
    // than leaving the viewer with an extension that claims to be on and does nothing.
    teardown();
    void setup();
    return;
  }

  if (active.status === 'disabled') {
    active.status = 'ready';
    active.message = '';
  }

  refreshAnalysisAvailability();
  // Moving the pace or difficulty sliders re-plans from the scores already in memory, so it
  // is instant and costs nothing. This is why the cache key excludes those settings.
  replan();
}

/** Keeps the analysis line honest when a key is added or the difficulty slider moves. */
function refreshAnalysisAvailability(): void {
  if (active === null) return;
  const { analysis, settings } = active;

  if (!canAnalyze(settings)) {
    if (analysis.state === 'running') return;
    active.analysis = { ...analysis, state: 'unavailable', message: unavailableReason(settings) };
    return;
  }

  if (analysis.state === 'unavailable') {
    active.analysis = {
      ...analysis,
      state: active.scores === null ? 'idle' : 'cached',
      message: '',
    };
  }
}

async function setup(): Promise<void> {
  const videoId = getVideoIdFromUrl();
  if (videoId === null || active?.videoId === videoId) return;

  teardown();
  const run = generation;
  const superseded = () => run !== generation;

  const settings = await loadPublicSettings();
  if (superseded()) return;

  active = {
    videoId,
    transcript: null,
    chunks: [],
    plan: null,
    scores: null,
    settings,
    status: 'loading',
    message: '',
    enabled: false,
    analysis: IDLE_ANALYSIS,
  };

  stopWatchingSettings = watchPublicSettings(onSettingsChanged);

  if (!settings.enabled) {
    active.status = 'disabled';
    active.message = 'Adaptive playback is switched off in settings.';
    return;
  }

  const deadline = Date.now() + VIDEO_WAIT_MS;
  const video = await waitForVideo(deadline);
  if (superseded() || video === null) return;

  const duration = await waitForDuration(video, deadline);
  if (superseded()) return;

  const capSec = settings.maxVideoDurationMin * 60;
  if (duration !== null && duration > capSec) {
    active.status = 'too-long';
    active.message = `This video is longer than the ${settings.maxVideoDurationMin} minute limit set in options.`;
    return;
  }

  const result = await extractTranscript(videoId);
  if (superseded()) return;

  if (DEV_TOOLS) {
    mountDevPanel(result, async () => {
      const again = await extractTranscript(videoId);
      if (!superseded() && again.ok) adopt(again, run);
      return again;
    });
  }

  if (!result.ok) {
    // Every extraction failure lands here. The typed reason drives nothing the popup shows,
    // because the message that comes with it is already written for a human to read.
    active.status = 'no-captions';
    active.message = result.message;
    return;
  }

  adopt(result, run);
}

/**
 * Installs a successful extraction: chunk it, plan it, and stop.
 *
 * Nothing is attached to the player here. The plan exists so the popup can say what enabling
 * would do before anybody commits to it.
 */
function adopt(result: Extract<ExtractionResult, { ok: true }>, run: number): void {
  if (active === null) return;

  active.transcript = result.transcript;
  active.chunks = buildChunks(result.transcript, active.settings);
  active.scores = null;
  active.status = 'ready';
  active.message = '';

  const scoreable = scoreableChunks(active.chunks);
  active.analysis = {
    ...IDLE_ANALYSIS,
    state: canAnalyze(active.settings) ? 'idle' : 'unavailable',
    message: canAnalyze(active.settings) ? '' : unavailableReason(active.settings),
    estimatedTokens: estimateInputTokens(
      SYSTEM_PROMPT,
      buildUserMessage(scoreable, result.transcript.chapters ?? []),
    ),
  };

  replan();
  void probeCache(run);
}

// Registered once at module scope. Doing this inside setup would add a listener per
// navigation, and every one of them would answer the popup.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPopupRequest(message)) return false;

  if (message.type === 'SET_ENABLED') setEnabled(message.enabled);

  sendResponse(currentState());
  return false;
});

document.addEventListener('yt-navigate-start', () => {
  // The next page's id is not known yet, so drop everything and wait for the finish event.
  teardown();
});

document.addEventListener('yt-navigate-finish', () => {
  void setup();
});

void setup();
