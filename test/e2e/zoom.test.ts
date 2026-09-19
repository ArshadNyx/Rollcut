import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { runPipeline } from '../../src/pipeline.js';
import { ZOOM_SCALE } from '../../src/media/zoom.js';

const run = promisify(execFile);
const FFMPEG = (process.env.ROLLCUT_FFMPEG || ffmpegStatic) as unknown as string;

/** Playwright's capture rate; the output must keep it. */
const SOURCE_FPS = 25;

const WIDTH = 1280;
const HEIGHT = 720;

/**
 * A red square of known size, so the zoom can be measured rather than eyeballed,
 * plus a fixed header — the element that used to vanish when the zoom was a CSS
 * transform on `<html>`.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Zoom fixture</title>
<style>
  body{margin:0;background:#fff}
  header{position:fixed;top:0;left:0;right:0;height:60px;background:#111;z-index:10}
  main{padding-top:60px;height:1400px}
  #target{position:absolute;top:300px;left:600px;width:80px;height:40px;background:#d00;border:0}
</style></head><body>
  <header></header><main><button id="target">HIT</button></main>
</body></html>`;

interface Frame {
  /** Width of the red square, which tracks the zoom. */
  width: number;
  /** Cheap checksum, to spot a frame identical to the one before it. */
  sum: number;
}

/** Measure every frame of the clip. */
async function frames(video: string, from: number, duration: number): Promise<Frame[]> {
  const { stdout } = await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(from),
      '-t',
      String(duration),
      '-i',
      video,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 * 1024 * 512, encoding: 'buffer' },
  );

  const data = stdout as unknown as Buffer;
  const frameSize = WIDTH * HEIGHT * 3;
  const out: Frame[] = [];

  for (let f = 0; f + frameSize <= data.length; f += frameSize) {
    let min = WIDTH;
    let max = 0;
    let sum = 0;
    for (let y = 0; y < HEIGHT; y += 2) {
      for (let x = 0; x < WIDTH; x++) {
        const i = f + (y * WIDTH + x) * 3;
        const r = data[i]!;
        if (r > 150 && data[i + 1]! < 80 && data[i + 2]! < 80) {
          if (x < min) min = x;
          if (x > max) max = x;
        }
        // Sampled checksum: enough to tell two frames apart, cheap enough to
        // run over a whole clip.
        if (x % 7 === 0) sum = (sum + r * (x + 1) + data[i + 2]!) % 2147483647;
      }
    }
    if (max > min) out.push({ width: max - min, sum });
  }
  return out;
}

/** The stretch where the zoom is growing, from first movement to full size. */
function rampIn(all: Frame[]): Frame[] {
  const rest = all[0]!.width;
  const peak = Math.max(...all.map((f) => f.width));
  const start = all.findIndex((f) => f.width > rest);
  const end = all.findIndex((f) => f.width >= peak);
  return start >= 0 && end > start ? all.slice(start, end + 1) : [];
}

let dir: string;
let video: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollcut-zoom-'));
  await writeFile(join(dir, 'index.html'), PAGE, 'utf8');
  const specPath = join(dir, 'spec.yaml');
  await writeFile(
    specPath,
    [
      `baseUrl: ${pathToFileURL(dir).href}/`,
      `viewport: { width: ${WIDTH}, height: ${HEIGHT} }`,
      'pauseMs: 300',
      'steps:',
      '  - navigate: index.html',
      '  - waitFor: "#target"',
      '  - click: "#target"',
      '  - wait: 500',
    ].join('\n'),
    'utf8',
  );

  const result = await runPipeline({
    specPath,
    outDir: join(dir, 'out'),
    narration: false,
  });
  video = result.mp4;
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('zoom motion', () => {
  it('keeps the rate it was captured at, so no frame is ever duplicated', async () => {
    // zoompan decides the output rate. Give it anything but the capture rate
    // and frames get duplicated or dropped; a duplicate mid-zoom stutters.
    const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', video]).catch(
      (e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }),
    );
    expect(stderr).toMatch(new RegExp(`\\b${SOURCE_FPS} fps\\b`));
  });

  it('spends a sensible number of frames easing in', async () => {
    // Loose on purpose: the exact frame the ramp tops out on shifts by one or
    // two between runs, so anything tighter would be flaky rather than strict.
    const ramp = rampIn(await frames(video, 0, 30));
    expect(ramp.length).toBeGreaterThanOrEqual(8);
  });

  // Weaker than the others: the ±1px tolerance is the same size as the wobble
  // it looks for, so it catches whole-pixel rounding only sometimes. Kept as a
  // smoke check — the supersampling that prevents that wobble is asserted in
  // the unit tests instead.
  it('eases in and out without ever reversing direction', async () => {
    const widths = (await frames(video, 0, 30)).map((f) => f.width);
    expect(widths.length).toBeGreaterThan(30);

    const peak = Math.max(...widths);
    const rest = widths[0]!;
    expect(peak).toBeGreaterThan(rest);

    const peakAt = widths.indexOf(peak);
    const rampIn = widths.slice(0, peakAt + 1);
    const rampOut = widths.slice(widths.lastIndexOf(peak));

    // A reversal mid-ramp is the wobble that whole-pixel rounding used to
    // cause; 1px of tolerance covers antialiasing at the square's edge.
    for (let i = 1; i < rampIn.length; i++) {
      expect(rampIn[i]!).toBeGreaterThanOrEqual(rampIn[i - 1]! - 1);
    }
    for (let i = 1; i < rampOut.length; i++) {
      expect(rampOut[i]!).toBeLessThanOrEqual(rampOut[i - 1]! + 1);
    }
  });

  it('zooms by the intended amount', async () => {
    const widths = (await frames(video, 0, 30)).map((f) => f.width);
    const ratio = Math.max(...widths) / widths[0]!;
    expect(ratio).toBeGreaterThan(ZOOM_SCALE - 0.04);
    expect(ratio).toBeLessThan(ZOOM_SCALE + 0.04);
  });

  it('holds at full zoom rather than snapping straight back', async () => {
    const widths = (await frames(video, 0, 30)).map((f) => f.width);
    const peak = Math.max(...widths);
    const atPeak = widths.filter((w) => w >= peak - 1).length;
    // At 25fps a real hold is many frames; a snap-back would be one or two.
    expect(atPeak).toBeGreaterThanOrEqual(8);
  });

  it('leaves the fixed header on screen throughout', async () => {
    // The old CSS-transform zoom made position:fixed resolve against the
    // transformed element, and the header disappeared entirely.
    const { stdout } = await run(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        video,
        '-vf',
        'crop=4:4:638:2',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 1024 * 1024 * 64, encoding: 'buffer' },
    );
    const data = stdout as unknown as Buffer;
    let dark = 0;
    let total = 0;
    for (let i = 0; i + 2 < data.length; i += 3) {
      total++;
      if (data[i]! < 60 && data[i + 1]! < 60 && data[i + 2]! < 60) dark++;
    }
    // The header occupies the top of every frame, zoomed or not.
    expect(dark / total).toBeGreaterThan(0.9);
  });
});
