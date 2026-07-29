/**
 * Driving the YouTube video element from a SpeedPlan.
 *
 * The hard part is not setting playbackRate. It is that three parties write to the same
 * property and only one of them is us. YouTube resets it to 1 after an ad or a quality
 * change, the viewer sets it from the player menu, and we set it from the plan. Getting this
 * wrong produces either an extension that silently stops working after every ad, or one that
 * fights the viewer for control of their own player.
 *
 * The rule this file implements: a rate we did not set is a viewer's choice if it looks like
 * something the menu can produce, and YouTube interfering otherwise. A viewer's choice always
 * wins, for a while. YouTube's interference is always overruled immediately.
 *
 * A controller exists only while the viewer has this video switched on. There is no paused
 * state to hold, because switching off detaches, and detaching puts the rate back to 1.
 */

import { findSegmentAt } from '../core/plan.ts';
import type { SpeedPlan } from '../core/types.ts';

/** How close counts as already correct. Below this a write is not worth the ratechange event. */
export const RATE_TOLERANCE = 0.01;

/** Transitions are ramped rather than snapped, over roughly this long. */
const RAMP_MS = 400;
const RAMP_STEPS = 5;

/** How long a viewer's manual speed choice suppresses automatic control. */
const OVERRIDE_SUSPEND_MS = 60_000;

/**
 * A rate change arriving this soon after an ad finished is YouTube resetting us, not a
 * viewer choosing 1x. Without this window the two are indistinguishable, since 1.0 is both
 * the value YouTube resets to and a perfectly ordinary thing to pick from the menu.
 */
const AD_RESET_GRACE_MS = 3000;

/** YouTube's speed menu offers multiples of a quarter, from 0.25 up to 2. */
const MENU_STEP = 0.25;
const MENU_MIN = 0.25;
const MENU_MAX = 2;

export type RateChangeKind = 'expected' | 'user-override' | 'external-reset';

/** True for a value the YouTube speed menu is capable of producing. */
export function isMenuPreset(rate: number): boolean {
  if (!(rate >= MENU_MIN - RATE_TOLERANCE && rate <= MENU_MAX + RATE_TOLERANCE)) return false;
  const steps = rate / MENU_STEP;
  return Math.abs(steps - Math.round(steps)) < 0.001;
}

/**
 * Decides who changed the playback rate.
 *
 * `adJustEnded` exists because 1.0 is ambiguous on its own: it is what YouTube resets to
 * after an ad, and it is also what a viewer picks when they want normal speed. Only the
 * surrounding context separates them.
 *
 * Everything not recognisable as a menu value is treated as interference. That is the safe
 * direction: reasserting over YouTube costs nothing, whereas reasserting over a viewer who
 * deliberately chose a speed is the single most annoying thing this extension could do.
 */
export function classifyRateChange(
  actual: number,
  expected: number,
  adJustEnded = false,
): RateChangeKind {
  if (Math.abs(actual - expected) <= RATE_TOLERANCE) return 'expected';
  if (adJustEnded && Math.abs(actual - 1) <= RATE_TOLERANCE) return 'external-reset';
  return isMenuPreset(actual) ? 'user-override' : 'external-reset';
}

/**
 * The intermediate rates for a ramp, ending exactly on the target.
 *
 * Interpolated in log space for the same reason the engine works there: 1.5x and 0.667x are
 * the same size of change to a listener, so a linear walk between two multipliers is not a
 * perceptually even one. The final entry is the target itself rather than a computed value,
 * so the ramp cannot land a rounding error away from where the plan asked.
 */
export function rampSteps(from: number, to: number, steps: number = RAMP_STEPS): number[] {
  if (!(from > 0) || !(to > 0) || steps <= 1) return [to];

  const logFrom = Math.log(from);
  const logTo = Math.log(to);
  const result: number[] = [];

  for (let i = 1; i <= steps; i += 1) {
    result.push(i === steps ? to : Math.exp(logFrom + (logTo - logFrom) * (i / steps)));
  }

  return result;
}

export interface PlayerStatus {
  /** A plan is loaded and control is not suspended for any reason. */
  controlling: boolean;
  currentSpeed: number;
  /**
   * What the plan wants for the moment being played, or null if it has nothing to say.
   *
   * The badge in the overlay is the only reader. A gap between this and `currentSpeed` is a
   * ramp in progress, which is what it draws the arrow from, and reading the target here is
   * cheaper and more honest than watching for `ratechange` events and guessing a direction
   * from them.
   */
  targetSpeed: number | null;
  suspendedByViewer: boolean;
  adShowing: boolean;
}

export interface PlayerController {
  setPlan(plan: SpeedPlan | null, chapterStarts?: readonly number[]): void;
  getStatus(): PlayerStatus;
  detach(): void;
}

export function attachPlayer(video: HTMLVideoElement): PlayerController {
  const container = video.closest<HTMLElement>('.html5-video-player');

  let plan: SpeedPlan | null = null;
  let chapterStarts: readonly number[] = [];
  let expectedRate = video.playbackRate;

  let suspendedUntilMs = 0;
  let suspendedFromVideoTime = 0;
  let adEndedAtMs = 0;
  let sawAd = false;
  let rampTimer: ReturnType<typeof setTimeout> | null = null;
  let detached = false;

  // Pitch correction is the difference between "watchable at 1.7x" and "chipmunks".
  video.preservesPitch = true;

  const adShowing = (): boolean => container?.classList.contains('ad-showing') ?? false;

  const cancelRamp = (): void => {
    if (rampTimer !== null) {
      clearTimeout(rampTimer);
      rampTimer = null;
    }
  };

  /** Assigns through `expectedRate` so our own writes are never mistaken for someone else's. */
  const assign = (rate: number): void => {
    expectedRate = rate;
    video.playbackRate = rate;
  };

  const rampTo = (target: number): void => {
    cancelRamp();
    const steps = rampSteps(video.playbackRate, target);
    let index = 0;

    const step = (): void => {
      if (detached || index >= steps.length) {
        rampTimer = null;
        return;
      }
      assign(steps[index]!);
      index += 1;
      rampTimer = setTimeout(step, RAMP_MS / RAMP_STEPS);
    };

    step();
  };

  const suspended = (): boolean => Date.now() < suspendedUntilMs;

  /** A viewer's override lapses at the next chapter, or after a minute, whichever is sooner. */
  const releaseSuspensionIfDue = (): void => {
    if (!suspended()) return;
    const crossedChapter = chapterStarts.some(
      (start) => start > suspendedFromVideoTime && start <= video.currentTime,
    );
    if (crossedChapter) suspendedUntilMs = 0;
  };

  const tick = (): void => {
    if (detached || plan === null) return;

    if (adShowing()) {
      sawAd = true;
      return;
    }
    if (sawAd) {
      sawAd = false;
      adEndedAtMs = Date.now();
    }

    releaseSuspensionIfDue();
    if (suspended()) return;

    const target = findSegmentAt(plan.segments, video.currentTime)?.speed;
    if (target === undefined) return;
    if (Math.abs(video.playbackRate - target) <= RATE_TOLERANCE) return;

    rampTo(target);
  };

  const onRateChange = (): void => {
    if (detached) return;

    const adJustEnded = adShowing() || Date.now() - adEndedAtMs < AD_RESET_GRACE_MS;
    const kind = classifyRateChange(video.playbackRate, expectedRate, adJustEnded);
    if (kind === 'expected') return;

    cancelRamp();

    if (kind === 'user-override') {
      suspendedUntilMs = Date.now() + OVERRIDE_SUSPEND_MS;
      suspendedFromVideoTime = video.currentTime;
      expectedRate = video.playbackRate;
      return;
    }

    // YouTube reset us. Take it back straight away rather than waiting for the next tick,
    // which would leave a visible stretch of the video playing at the wrong speed.
    tick();
  };

  const onSeeked = (): void => {
    // Recompute now rather than waiting up to a quarter second for the next timeupdate.
    cancelRamp();
    tick();
  };

  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('ratechange', onRateChange);

  return {
    setPlan(next, starts = []) {
      plan = next;
      chapterStarts = starts;
      tick();
    },

    getStatus() {
      return {
        controlling: plan !== null && !suspended() && !adShowing(),
        currentSpeed: video.playbackRate,
        targetSpeed:
          plan === null ? null : findSegmentAt(plan.segments, video.currentTime)?.speed ?? null,
        suspendedByViewer: suspended(),
        adShowing: adShowing(),
      };
    },

    detach() {
      detached = true;
      cancelRamp();
      video.removeEventListener('timeupdate', tick);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ratechange', onRateChange);
      // Never leak a speed onto whatever the viewer watches next.
      expectedRate = 1;
      video.playbackRate = 1;
    },
  };
}
