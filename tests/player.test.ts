import { describe, expect, it } from 'vitest';
import { classifyRateChange, isMenuPreset, rampSteps } from '../src/content/player.ts';

describe('isMenuPreset', () => {
  it('recognises the values YouTube offers', () => {
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      expect(isMenuPreset(rate)).toBe(true);
    }
  });

  it('rejects values the menu cannot produce', () => {
    // Our own plan speeds sit on a 0.05 grid, so most of them are not menu values. That is
    // what lets a rate we did not set be told apart from one a viewer chose.
    for (const rate of [1.05, 1.1, 1.35, 1.7, 2.45]) {
      expect(isMenuPreset(rate)).toBe(false);
    }
  });

  it('rejects rates outside the menu range', () => {
    expect(isMenuPreset(2.25)).toBe(false);
    expect(isMenuPreset(0)).toBe(false);
    expect(isMenuPreset(3)).toBe(false);
  });
});

describe('classifyRateChange', () => {
  it('ignores our own writes', () => {
    expect(classifyRateChange(1.7, 1.7)).toBe('expected');
    // Assigning a rate does not always read back bit-identical.
    expect(classifyRateChange(1.7049, 1.7)).toBe('expected');
  });

  it('treats a menu value as the viewer taking over', () => {
    expect(classifyRateChange(1.5, 1.7)).toBe('user-override');
    expect(classifyRateChange(2, 1.05)).toBe('user-override');
  });

  it('treats anything else as YouTube interfering', () => {
    expect(classifyRateChange(1.35, 1.7)).toBe('external-reset');
    expect(classifyRateChange(3, 1.7)).toBe('external-reset');
  });

  it('reads 1.0 as an ad reset only in the window after an ad', () => {
    // 1.0 is genuinely ambiguous: it is what YouTube resets to, and it is also what a viewer
    // picks to get normal speed. Only the surrounding context separates the two, and getting
    // it wrong either way is bad. Outside the ad window the viewer wins.
    expect(classifyRateChange(1, 1.7, true)).toBe('external-reset');
    expect(classifyRateChange(1, 1.7, false)).toBe('user-override');
  });
});

describe('rampSteps', () => {
  it('lands exactly on the target', () => {
    const steps = rampSteps(1, 1.75, 5);
    expect(steps).toHaveLength(5);
    expect(steps[steps.length - 1]).toBe(1.75);
  });

  it('moves monotonically in both directions', () => {
    const up = rampSteps(1, 2, 5);
    for (let i = 1; i < up.length; i += 1) expect(up[i]!).toBeGreaterThan(up[i - 1]!);

    const down = rampSteps(2, 1, 5);
    for (let i = 1; i < down.length; i += 1) expect(down[i]!).toBeLessThan(down[i - 1]!);
  });

  it('stays strictly between the endpoints on the way', () => {
    for (const step of rampSteps(1, 2, 5).slice(0, -1)) {
      expect(step).toBeGreaterThan(1);
      expect(step).toBeLessThan(2);
    }
  });

  it('steps evenly in log space rather than linearly', () => {
    // Perceptually even, for the same reason the engine works in logs. A linear walk would
    // put the midpoint of 1 to 4 at 2.5; the perceptual midpoint is 2.
    const steps = rampSteps(1, 4, 2);
    expect(steps[0]).toBeCloseTo(2, 6);
  });

  it('degenerates safely', () => {
    expect(rampSteps(1.5, 1.5, 5)).toEqual([1.5, 1.5, 1.5, 1.5, 1.5]);
    expect(rampSteps(1, 2, 1)).toEqual([2]);
    expect(rampSteps(0, 2, 5)).toEqual([2]);
  });
});
