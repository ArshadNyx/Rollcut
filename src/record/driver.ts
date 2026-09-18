import { mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Spec, Step } from '../spec/schema.js';
import { stepKind } from '../spec/schema.js';
import { ensureCursor, installCursor, setZoomEnabled, ZOOM_MS } from './cursor.js';
import * as steps from './steps.js';
import type { Narration } from '../tts/provider.js';
import type { Cue } from '../media/subtitles.js';

export interface RecordOptions {
  /** Directory for the raw Playwright video. */
  workDir: string;
  /** Overrides spec.baseUrl (preview deployments). */
  url?: string;
  /** Pre-measured narration, keyed by step index. Empty for a silent run. */
  narration?: Map<number, Narration>;
  onStep?: (index: number, description: string) => void;
}

export interface RecordResult {
  /** Raw Playwright webm. */
  raw: string;
  /** Narration placements, in video time, for muxing and subtitles. */
  cues: (Cue & { wavPath: string })[];
}

/** Breathing room after a narration line before the next step moves on. */
const NARRATION_TAIL_MS = 260;

function describe(step: Step): string {
  const kind = stepKind(step);
  const value = (step as Record<string, unknown>)[kind];
  return `${kind} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
}

/** Run the whole spec in a recorded browser session. */
export async function record(spec: Spec, options: RecordOptions): Promise<RecordResult> {
  const baseUrl = options.url ?? spec.baseUrl;
  const videoDir = join(options.workDir, 'raw');
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: spec.viewport },
  });
  const page = await context.newPage();
  // Recording is running from here on; every cue is measured against this.
  const t0 = Date.now();
  await installCursor(page);

  const cues: (Cue & { wavPath: string })[] = [];

  try {
    let navigated = false;
    for (const [i, step] of spec.steps.entries()) {
      const n = i + 1;
      options.onStep?.(n, describe(step));
      const narration = options.narration?.get(i);
      const cueStart = Date.now() - t0;
      const kind = stepKind(step);

      if ('navigate' in step) {
        await steps.navigate(page, baseUrl, step.navigate);
        if (!navigated) {
          // Only the first navigate gets a settle window; after that timing
          // stays deterministic on fixed pauses.
          await page.waitForLoadState('load').catch(() => undefined);
          await steps.wait(1200);
          navigated = true;
        }
        await ensureCursor(page);
        steps.resetPointer();
      } else if ('click' in step) {
        await steps.click(page, step.click, n);
      } else if ('clickAt' in step) {
        await steps.clickAt(page, step.clickAt);
      } else if ('drag' in step) {
        await setZoomEnabled(page, false);
        await steps.drag(page, step.drag.from, step.drag.to);
        await setZoomEnabled(page, true);
      } else if ('type' in step) {
        await steps.type(page, step.type);
      } else if ('press' in step) {
        await steps.press(page, step.press);
      } else if ('wait' in step) {
        await steps.wait(step.wait);
      } else if ('scroll' in step) {
        await steps.scroll(page, step.scroll, n);
      } else if ('hover' in step) {
        await steps.hover(page, step.hover, n);
      } else if ('waitFor' in step) {
        await steps.waitFor(page, step.waitFor, n);
      }

      // Clicks trigger the zoom; hold long enough for it to ease back out.
      const zoomTail = kind === 'click' || kind === 'clickAt' ? ZOOM_MS + 240 : 0;
      const selfPaced = kind === 'wait' || kind === 'waitFor';
      const basePause = selfPaced ? 0 : spec.pauseMs + zoomTail;

      if (narration) {
        // The step must stay on screen at least as long as its narration.
        const spent = Date.now() - t0 - cueStart;
        const remaining = narration.durationMs - spent + NARRATION_TAIL_MS;
        await steps.wait(Math.max(basePause, remaining));
        cues.push({
          startMs: cueStart,
          endMs: cueStart + narration.durationMs,
          text: narration.text,
          wavPath: narration.wavPath,
        });
      } else if (basePause > 0) {
        await steps.wait(basePause);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const files = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'));
  const first = files[0];
  if (!first) {
    throw new Error(
      'Playwright produced no video — check that the run reached at least one step and that out/ is writable.',
    );
  }
  const raw = join(options.workDir, 'raw.webm');
  await rename(join(videoDir, first), raw);
  return { raw, cues };
}
