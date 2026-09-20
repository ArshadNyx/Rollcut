import { describe, expect, it } from 'vitest';
import { toSteps } from '../src/plan/narrate.js';
import type { CaptureResult } from '../src/plan/capture.js';

function capture(actions: CaptureResult['actions']): CaptureResult {
  return { origin: 'https://example.com', startPath: '/app', actions };
}

describe('toSteps', () => {
  it('clicks a field before typing into it', async () => {
    // A `type` goes to whatever has focus, so a spec that types without
    // clicking first fails silently — it errors nowhere and does nothing.
    const steps = toSteps(capture([{ kind: 'type', selector: '#code', text: 'MSSS', atMs: 100 }]));
    const typeAt = steps.findIndex((s) => 'type' in s);
    expect(steps[typeAt - 1]).toEqual({ click: '#code' });
    expect(steps[typeAt]).toEqual({ type: 'MSSS' });
  });

  it('records the real value that was entered', () => {
    const steps = toSteps(capture([{ kind: 'type', selector: '#c', text: 'MSSS', atMs: 0 }]));
    // The planner can only guess at a placeholder; capture saw the real thing.
    expect(JSON.stringify(steps)).toContain('MSSS');
  });

  it('keeps only the first navigate, since later ones follow from clicks', () => {
    const steps = toSteps(
      capture([
        { kind: 'navigate', selector: '/app', atMs: 0 },
        { kind: 'click', selector: '#go', atMs: 200 },
        { kind: 'navigate', selector: '/next', atMs: 400 },
        { kind: 'click', selector: '#other', atMs: 600 },
      ]),
    );
    expect(steps.filter((s) => 'navigate' in s)).toHaveLength(1);
    expect(steps[0]).toEqual({ navigate: '/app' });
    expect(steps).toContainEqual({ click: '#other' });
  });

  it('turns a real pause into a wait', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#a', atMs: 0 },
        { kind: 'click', selector: '#b', atMs: 2500 },
      ]),
    );
    expect(steps).toContainEqual({ wait: 2500 });
  });

  it('ignores a pause too short to be deliberate', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#a', atMs: 0 },
        { kind: 'click', selector: '#b', atMs: 200 },
      ]),
    );
    expect(steps.some((s) => 'wait' in s)).toBe(false);
  });

  it('caps a very long pause rather than freezing the video', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#a', atMs: 0 },
        { kind: 'click', selector: '#b', atMs: 90_000 },
      ]),
    );
    const wait = steps.find((s) => 'wait' in s) as { wait: number };
    expect(wait.wait).toBeLessThanOrEqual(4000);
  });

  it('always starts somewhere, even if no navigation was seen', () => {
    const steps = toSteps(capture([{ kind: 'click', selector: '#a', atMs: 0 }]));
    expect(steps[0]).toEqual({ navigate: '/app' });
  });

  it('carries presses and scrolls through', () => {
    const steps = toSteps(
      capture([
        { kind: 'press', key: 'Enter', atMs: 0 },
        { kind: 'scroll', pixels: 400, atMs: 100 },
      ]),
    );
    expect(steps).toContainEqual({ press: 'Enter' });
    expect(steps).toContainEqual({ scroll: 400 });
  });
});

describe('toSteps — what a real run exposed', () => {
  it('collapses repeated clicks on the same element', () => {
    // Someone clicks a field, pauses, clicks again, then types. That is one
    // intent, and the click added before a `type` repeats it a third time.
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#code', atMs: 0 },
        { kind: 'click', selector: '#code', atMs: 2000 },
        { kind: 'type', selector: '#code', text: 'MSSS', atMs: 4000 },
      ]),
    );
    expect(steps.filter((s) => 'click' in s && s.click === '#code')).toHaveLength(1);
    expect(steps).toContainEqual({ type: 'MSSS' });
  });

  it('drops the pause between two clicks on the same element', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#code', atMs: 0 },
        { kind: 'click', selector: '#code', atMs: 3000 },
      ]),
    );
    // Padding around an intent that no longer exists.
    expect(steps.filter((s) => 'wait' in s)).toHaveLength(0);
  });

  it('never emits a wait for an action that produced no step', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#a', atMs: 0 },
        // No selector and no text: nothing to replay.
        { kind: 'click', atMs: 2000 },
        { kind: 'type', atMs: 4000 },
        { kind: 'click', selector: '#b', atMs: 6000 },
      ]),
    );
    // One real gap, not three waits sitting between nothing and nothing.
    expect(steps.filter((s) => 'wait' in s)).toHaveLength(1);
  });

  it('keeps distinct clicks that merely sit next to each other', () => {
    const steps = toSteps(
      capture([
        { kind: 'click', selector: '#a', atMs: 0 },
        { kind: 'click', selector: '#b', atMs: 100 },
      ]),
    );
    expect(steps).toContainEqual({ click: '#a' });
    expect(steps).toContainEqual({ click: '#b' });
  });
});
