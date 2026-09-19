import { mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { stepKind } from '../spec/schema.js';
import { ensureCursor, installCursor } from './cursor.js';
import { ZOOM_TOTAL_MS } from '../media/zoom.js';
import * as steps from './steps.js';
/** Breathing room after a narration line before the next step moves on. */
const NARRATION_TAIL_MS = 260;
function describe(step) {
    const kind = stepKind(step);
    const value = step[kind];
    return `${kind} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
}
/** Run the whole spec in a recorded browser session. */
export async function record(spec, options) {
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
    const cues = [];
    const zooms = [];
    try {
        let navigated = false;
        for (const [i, step] of spec.steps.entries()) {
            const n = i + 1;
            options.onStep?.(n, describe(step));
            const narration = options.narration?.get(i);
            const cueStart = Date.now() - t0;
            const kind = stepKind(step);
            const clickedAt = Date.now() - t0;
            const point = await steps.executeStep(page, step, n, {
                baseUrl,
                // Only the first navigate gets a settle window; after that timing
                // stays deterministic on fixed pauses.
                settle: !navigated && 'navigate' in step,
                onNavigated: async (p) => {
                    navigated = true;
                    await ensureCursor(p);
                },
            });
            if (point)
                zooms.push({ atMs: clickedAt, x: point[0], y: point[1] });
            // The zoom is applied afterwards, but it plays over this stretch of the
            // recording, so the step has to stay on screen for at least that long.
            const zoomHold = point ? ZOOM_TOTAL_MS + 120 : 0;
            const selfPaced = kind === 'wait' || kind === 'waitFor';
            const basePause = selfPaced ? 0 : Math.max(spec.pauseMs, zoomHold);
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
            }
            else if (basePause > 0) {
                await steps.wait(basePause);
            }
        }
    }
    finally {
        await context.close();
        await browser.close();
    }
    const files = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'));
    const first = files[0];
    if (!first) {
        throw new Error('Playwright produced no video — check that the run reached at least one step and that out/ is writable.');
    }
    const raw = join(options.workDir, 'raw.webm');
    await rename(join(videoDir, first), raw);
    return { raw, cues, zooms };
}
//# sourceMappingURL=driver.js.map