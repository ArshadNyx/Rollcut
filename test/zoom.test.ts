import { describe, expect, it } from 'vitest';
import { buildZoomFilter, ZOOM_SCALE, ZOOM_TIMING, ZOOM_TOTAL_MS } from '../src/media/zoom.js';

const size = { width: 1280, height: 720 };

describe('buildZoomFilter', () => {
  it('returns nothing when there are no clicks, so assembly can skip it', () => {
    expect(buildZoomFilter([], size)).toBeUndefined();
  });

  it('ignores events with no usable timestamp', () => {
    expect(buildZoomFilter([{ atMs: Number.NaN, x: 1, y: 2 }], size)).toBeUndefined();
    expect(buildZoomFilter([{ atMs: -5, x: 1, y: 2 }], size)).toBeUndefined();
  });

  it('uses zoompan, because crop cannot vary its size over time', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], size)!;
    expect(filter).toContain('zoompan=');
    expect(filter).toContain('s=1280x720');
    // One output frame per input frame; without this a short clip stretches.
    expect(filter).toContain(':d=1:');
  });

  it('drives the animation from in_time, the only time zoompan exposes', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], size)!;
    expect(filter).toContain('in_time');
    // `t` is a crop-ism and is undefined here.
    expect(/[^_a-z]t[^_a-z]/.test(filter.replace(/in_time/g, ''))).toBe(false);
  });

  it('clamps the zoom so overlapping clicks cannot scale past the maximum', () => {
    const filter = buildZoomFilter(
      [
        { atMs: 1000, x: 100, y: 100 },
        { atMs: 1050, x: 900, y: 500 },
      ],
      size,
    )!;
    expect(filter).toContain(`1+${(ZOOM_SCALE - 1).toFixed(4)}*clip(`);
    expect(filter).toContain(',0,1)');
  });

  it('averages the focus rather than summing it, so the picture cannot drift', () => {
    // Summing slides the focus toward the frame origin while the zoom ramps.
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], size)!;
    expect(filter).toContain('/max(');
  });

  it('keeps the crop window inside the frame', () => {
    const filter = buildZoomFilter([{ atMs: 500, x: 1279, y: 719 }], size)!;
    expect(filter).toContain('clip(');
    expect(filter).toContain('iw-iw/');
    expect(filter).toContain('ih-ih/');
  });

  it('builds one ramp-hold-ramp envelope per click', () => {
    const one = buildZoomFilter([{ atMs: 1000, x: 10, y: 10 }], size)!;
    const two = buildZoomFilter(
      [
        { atMs: 1000, x: 10, y: 10 },
        { atMs: 5000, x: 20, y: 20 },
      ],
      size,
    )!;
    const count = (s: string) => s.split('gte(in_time,').length - 1;
    // Three half-open segments per event, in both the zoom and each focus axis.
    expect(count(two)).toBe(count(one) * 2);
  });

  it('uses half-open segments so no frame is counted by two of them', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 10, y: 10 }], size)!;
    // `between()` is inclusive at both ends and would double-count boundaries.
    expect(filter).not.toContain('between(');
    expect(filter).toContain('lt(in_time,');
  });

  it('agrees with the timing the recorder holds steps for', () => {
    expect(ZOOM_TOTAL_MS).toBe(ZOOM_TIMING.inMs + ZOOM_TIMING.holdMs + ZOOM_TIMING.outMs);
    // Out is slower than in: a demo should settle, not snap back.
    expect(ZOOM_TIMING.outMs).toBeGreaterThan(ZOOM_TIMING.inMs);
    expect(ZOOM_TIMING.holdMs).toBeGreaterThan(0);
  });
});

describe('smoothness', () => {
  it('supersamples, because zoompan rounds its window to whole pixels', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], size)!;
    // Without this the crop window jitters by a pixel and the motion wobbles.
    expect(filter.startsWith('scale=iw*2:ih*2')).toBe(true);
  });

  it('scales the focus point into supersampled space', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], { ...size, supersample: 2 })!;
    expect(filter).toContain(')*2*(1-1/');
  });

  it('can be told not to supersample', () => {
    const filter = buildZoomFilter([{ atMs: 1000, x: 640, y: 360 }], {
      ...size,
      supersample: 1,
    })!;
    expect(filter.startsWith('zoompan=')).toBe(true);
  });

  it('runs at the frame rate it is given, so no frames are duplicated', () => {
    // Resampling 25 -> 30 duplicates every fifth frame; mid-zoom that stutters.
    expect(buildZoomFilter([{ atMs: 0, x: 1, y: 1 }], { ...size, fps: 25 })!).toContain('fps=25');
    expect(buildZoomFilter([{ atMs: 0, x: 1, y: 1 }], { ...size, fps: 30 })!).toContain('fps=30');
  });

  it('gives the ease enough frames to be smooth at 25fps', () => {
    // A 420ms ramp is ~10 frames, few enough that each step is visible.
    const framesIn = (ZOOM_TIMING.inMs / 1000) * 25;
    const framesOut = (ZOOM_TIMING.outMs / 1000) * 25;
    expect(framesIn).toBeGreaterThanOrEqual(15);
    expect(framesOut).toBeGreaterThanOrEqual(15);
  });
});
