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
 * Ordering here matters more than it looks. The duration cap is checked before the
 * transcript is fetched, because obtaining a proof-of-origin token can take twelve seconds
 * and there is no reason to spend that on a video that is about to be refused.
 */

import { buildChunks } from '../core/chunking.ts';
import { computeSpeedPlan } from '../core/pacing.ts';
import { loadSettings, watchSettings } from '../storage/settings.ts';
import type { Settings, SpeedPlan, Transcript } from '../core/types.ts';
import { mountDevPanel, unmountDevPanel } from './dev-panel.ts';
import { isPopupRequest, UNAVAILABLE_STATE } from './messages.ts';
import type { VideoState, VideoStatus } from './messages.ts';
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
  plan: SpeedPlan | null;
  settings: Settings;
  status: VideoStatus;
  message: string;
  pausedForVideo: boolean;
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

function planFor(transcript: Transcript, settings: Settings): SpeedPlan {
  return computeSpeedPlan(transcript, buildChunks(transcript, settings), null, settings);
}

function applyPlan(): void {
  if (active === null || controller === null || active.plan === null) return;
  const chapterStarts = (active.transcript?.chapters ?? []).map((chapter) => chapter.start);
  controller.setPlan(active.plan, chapterStarts);
}

function currentState(): VideoState {
  if (active === null) return UNAVAILABLE_STATE;

  const status = controller?.getStatus();
  let effective = active.status;
  if (effective === 'pacing') {
    if (active.pausedForVideo) effective = 'paused-for-video';
    else if (status?.suspendedByViewer) effective = 'suspended-by-viewer';
  }

  return {
    status: effective,
    message: active.message,
    videoId: active.videoId,
    currentSpeed: status?.currentSpeed ?? 1,
    originalDurationSec: active.plan?.meta.originalDurationSec ?? 0,
    estimatedWatchTimeSec: active.plan?.meta.estimatedWatchTimeSec ?? 0,
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

/** Re-plans from the transcript already in memory. Never re-extracts. */
function onSettingsChanged(settings: Settings): void {
  if (active === null) return;
  active.settings = settings;

  if (!settings.enabled) {
    controller?.setPlan(null);
    controller?.setPausedForVideo(true);
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
    active.status = 'pacing';
    active.message = '';
    controller?.setPausedForVideo(active.pausedForVideo);
  }

  active.plan = planFor(active.transcript, settings);
  applyPlan();
}

async function setup(): Promise<void> {
  const videoId = getVideoIdFromUrl();
  if (videoId === null || active?.videoId === videoId) return;

  teardown();
  const run = generation;
  const superseded = () => run !== generation;

  const settings = await loadSettings();
  if (superseded()) return;

  active = {
    videoId,
    transcript: null,
    plan: null,
    settings,
    status: 'loading',
    message: '',
    pausedForVideo: false,
  };

  stopWatchingSettings = watchSettings(onSettingsChanged);

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
      if (!superseded() && again.ok) adopt(again);
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

  adopt(result);
}

/** Installs a successful extraction: build the plan, attach the player, start pacing. */
function adopt(result: Extract<ExtractionResult, { ok: true }>): void {
  if (active === null) return;

  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (video === null) return;

  active.transcript = result.transcript;
  active.plan = planFor(result.transcript, active.settings);
  active.status = 'pacing';
  active.message = '';

  controller ??= attachPlayer(video);
  controller.setPausedForVideo(active.pausedForVideo);
  applyPlan();
}

// Registered once at module scope. Doing this inside setup would add a listener per
// navigation, and every one of them would answer the popup.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPopupRequest(message)) return false;

  if (message.type === 'SET_PAUSED' && active !== null) {
    active.pausedForVideo = message.paused;
    controller?.setPausedForVideo(message.paused);
  }

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
