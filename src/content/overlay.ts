/**
 * The on-page overlay: a difficulty ribbon on the progress bar, a hover chip, and a speed badge.
 *
 * Two problems this file exists to solve, neither of them the drawing.
 *
 * The first is that **YouTube rebuilds the player chrome whenever it feels like it**, on
 * fullscreen, on theater mode, on an ad, and sometimes for no visible reason at all. Anything
 * mounted inside it has to assume it will be thrown away and put itself back. The lifecycle here
 * is therefore not "render on event" but "check the nodes are still attached, and re-attach the
 * ones that are not". A MutationObserver drives that, coalesced through a frame so a burst of
 * DOM churn costs one pass.
 *
 * The second is that **nothing here may interfere with seeking.** The ribbon is
 * `pointer-events: none` and the hover listener only ever reads, never `preventDefault` and never
 * `stopPropagation`. Breaking click-to-seek on YouTube to show a decoration would be a bad trade.
 *
 * Everything that can be computed without an element lives in `src/core/heatmap.ts`, where it is
 * unit tested in Node. What is left here is element handling, and it is deliberately dull.
 */

import { buildHeatBands, describeBand, gradientCss } from '../core/heatmap.ts';
import type { HeatBand } from '../core/heatmap.ts';
import { findSpanAt } from '../core/plan.ts';
import type { Chunk, DifficultyScore, PacingSettings, SpeedPlan } from '../core/types.ts';
import { RATE_TOLERANCE } from './player.ts';
import type { PlayerStatus } from './player.ts';
import { getPlayerDuration } from './transcript.ts';

const PREFIX = 'adaptive-playback';
const STYLE_ID = `${PREFIX}-overlay-style`;
const RIBBON_ID = `${PREFIX}-heatmap`;
const CHIP_ID = `${PREFIX}-chip`;
const BADGE_ID = `${PREFIX}-badge`;

const PLAYER_SELECTOR = '.html5-video-player';
const BAR_SELECTOR = '.ytp-progress-bar';
const BAR_CONTAINER_SELECTOR = '.ytp-progress-bar-container';
const RIGHT_CONTROLS_SELECTOR = '.ytp-right-controls';

/** Vertical slop around the progress bar that still counts as hovering it. */
const HOVER_PADDING_PX = 8;

/** How far above the bar the chip floats, clear of YouTube's own storyboard preview. */
const CHIP_LIFT_PX = 12;

const STYLE = `
#${RIBBON_ID} {
  position: absolute; left: 0; right: 0; top: 0; bottom: 0;
  pointer-events: none; z-index: 1;
  opacity: .65; border-radius: inherit;
  box-shadow: 0 0 0 1px rgba(0,0,0,.35);
}
#${CHIP_ID} {
  position: fixed; z-index: 2147483000;
  transform: translate(-50%, -100%);
  padding: 3px 7px; border-radius: 4px;
  background: rgba(20,20,20,.92); color: #f1f1f1;
  border: 1px solid rgba(255,255,255,.15);
  font: 500 12px/1.4 Roboto, Arial, sans-serif;
  white-space: nowrap; pointer-events: none;
  opacity: 0; transition: opacity .1s;
}
#${CHIP_ID}.visible { opacity: 1; }
#${BADGE_ID} {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; height: 100%; padding: 0 4px;
  color: #fff; font: 500 13px/1 Roboto, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 2px rgba(0,0,0,.5);
  opacity: .9; vertical-align: top; cursor: default;
}
#${BADGE_ID}.suspended { opacity: .45; }
#${BADGE_ID}.hidden { display: none; }
`;

/** Everything the overlay draws from. Handed over whole on every re-plan. */
export interface OverlayData {
  chunks: readonly Chunk[];
  scores: DifficultyScore[] | null;
  plan: SpeedPlan | null;
  settings: PacingSettings;
}

export interface OverlayController {
  update(data: OverlayData): void;
  unmount(): void;
}

/**
 * How the badge learns the current speed.
 *
 * A callback rather than a pushed value, because the badge has to keep up with a ramp that
 * moves in five steps over 400ms and with YouTube resetting the rate after an ad. Both of
 * those already fire events on the video element, so the overlay listens to those and pulls,
 * and the content script is spared having to remember to push.
 */
export type StatusReader = () => PlayerStatus | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/**
 * Mounts the overlay around a video element the viewer has switched pacing on for.
 *
 * Nothing is drawn until `update` supplies a plan, and the mount is best effort: if the player
 * chrome is not ready yet the observer picks it up on the next mutation.
 */
export function mountOverlay(
  video: HTMLVideoElement,
  readStatus: StatusReader,
): OverlayController {
  const player = video.closest<HTMLElement>(PLAYER_SELECTOR);

  const style = el('style', { id: STYLE_ID });
  style.textContent = STYLE;
  const ribbon = el('div', { id: RIBBON_ID });
  const chip = el('div', { id: CHIP_ID });
  const badge = el('div', { id: BADGE_ID, class: 'hidden' });
  badge.title = 'Adaptive playback speed';

  let data: OverlayData | null = null;
  let bands: HeatBand[] = [];
  let detached = false;
  let pending = 0;

  const durationSec = (): number =>
    getPlayerDuration() ?? data?.plan?.meta.originalDurationSec ?? 0;

  const paintRibbon = (): void => {
    ribbon.style.background = gradientCss(bands, durationSec());
  };

  const paintBadge = (): void => {
    const status = readStatus();
    if (detached || status === null || status.adShowing) {
      badge.classList.add('hidden');
      return;
    }

    badge.classList.remove('hidden');
    badge.classList.toggle('suspended', status.suspendedByViewer);

    // The gap between where the rate is and where the plan wants it is a ramp in progress.
    // Showing the direction is the point: a speed that moves without explanation reads as a
    // glitch, and a speed that announces which way it is going reads as a decision.
    const { currentSpeed, targetSpeed } = status;
    const moving = targetSpeed !== null && Math.abs(targetSpeed - currentSpeed) > RATE_TOLERANCE;
    const arrow = moving ? (targetSpeed > currentSpeed ? ' ↑' : ' ↓') : '';

    badge.textContent = `${currentSpeed.toFixed(2)}x${arrow}`;
    badge.title = status.suspendedByViewer
      ? 'You set this speed yourself. Adaptive playback is standing down for a minute.'
      : 'Adaptive playback speed';
  };

  const hideChip = (): void => chip.classList.remove('visible');

  const onMouseMove = (event: MouseEvent): void => {
    if (detached || bands.length === 0) return;

    const bar = document.querySelector<HTMLElement>(BAR_SELECTOR);
    if (bar === null) return hideChip();

    // The hit test uses the padded container, which is the region YouTube itself treats as
    // hovering the bar. The x to time mapping uses the bar, which is the element that actually
    // spans the video.
    const hover = document.querySelector<HTMLElement>(BAR_CONTAINER_SELECTOR) ?? bar;
    const hoverRect = hover.getBoundingClientRect();
    if (
      event.clientY < hoverRect.top - HOVER_PADDING_PX ||
      event.clientY > hoverRect.bottom + HOVER_PADDING_PX
    ) {
      return hideChip();
    }

    const barRect = bar.getBoundingClientRect();
    if (barRect.width <= 0) return hideChip();

    const fraction = (event.clientX - barRect.left) / barRect.width;
    if (fraction < 0 || fraction > 1) return hideChip();

    const band = findSpanAt(bands, fraction * durationSec());
    if (band === null) return hideChip();

    chip.textContent = describeBand(band);
    // Clamped to the bar so the chip cannot slide off the edge of the window.
    chip.style.left = `${Math.min(Math.max(event.clientX, barRect.left), barRect.right)}px`;
    chip.style.top = `${barRect.top - CHIP_LIFT_PX}px`;
    chip.classList.add('visible');
  };

  /**
   * Puts back whatever YouTube took away.
   *
   * Cheap and idempotent, so it is safe to call from every observer. `isConnected` is the whole
   * test: a node YouTube discarded is no longer in the document, whether it was removed directly
   * or its whole ancestor subtree was replaced.
   */
  const ensureMounted = (): void => {
    if (detached) return;

    if (!style.isConnected) document.documentElement.append(style);

    if (!ribbon.isConnected) {
      const bar =
        document.querySelector<HTMLElement>(BAR_SELECTOR) ??
        document.querySelector<HTMLElement>(BAR_CONTAINER_SELECTOR);
      if (bar !== null) {
        bar.append(ribbon);
        paintRibbon();
      }
    }

    if (!chip.isConnected && player !== null) player.append(chip);

    if (!badge.isConnected) {
      const controls = document.querySelector<HTMLElement>(RIGHT_CONTROLS_SELECTOR);
      if (controls !== null) {
        controls.insertBefore(badge, controls.firstChild);
        paintBadge();
      }
    }
  };

  const scheduleCheck = (): void => {
    if (detached || pending !== 0) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      ensureMounted();
    });
  };

  const observer = new MutationObserver(scheduleCheck);
  if (player !== null) observer.observe(player, { childList: true, subtree: true });

  // The gradient is percentage based, so a resize needs no repaint. Both of these are here
  // only because they are the moments YouTube is most likely to have rebuilt the chrome.
  const resize = new ResizeObserver(scheduleCheck);
  if (player !== null) resize.observe(player);
  document.addEventListener('fullscreenchange', scheduleCheck);

  player?.addEventListener('mousemove', onMouseMove);
  player?.addEventListener('mouseleave', hideChip);

  video.addEventListener('timeupdate', paintBadge);
  video.addEventListener('ratechange', paintBadge);

  ensureMounted();

  return {
    update(next) {
      if (detached) return;
      data = next;
      bands = buildHeatBands(next.chunks, next.scores, next.plan, next.settings);
      ensureMounted();
      paintRibbon();
      paintBadge();
    },

    unmount() {
      detached = true;
      if (pending !== 0) cancelAnimationFrame(pending);
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener('fullscreenchange', scheduleCheck);
      player?.removeEventListener('mousemove', onMouseMove);
      player?.removeEventListener('mouseleave', hideChip);
      video.removeEventListener('timeupdate', paintBadge);
      video.removeEventListener('ratechange', paintBadge);
      // Leave nothing of ours in the page. The next video mounts a fresh overlay.
      style.remove();
      ribbon.remove();
      chip.remove();
      badge.remove();
    },
  };
}
