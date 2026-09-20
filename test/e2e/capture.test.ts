import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recorderScript } from '../../src/plan/capture.js';

/** Mirrors a real app: a control with no stable attribute, and a form. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Capture fixture</title>
<style>body{font:16px system-ui;margin:0;padding:40px;height:1400px}
button{padding:12px 18px;font-size:16px}input{padding:10px;font-size:16px;display:block;margin:12px 0}</style>
</head><body>
  <h1>Capture fixture</h1>
  <button class="only-a-class">Verify &amp; continue</button>
  <input id="code" placeholder="STX-2025" />
  <input id="email" type="email" />
</body></html>`;

let dir: string;
let browser: Browser;
let page: Page;
let recorded: Record<string, unknown>[];
let finished: boolean;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollcut-capture-'));
  await writeFile(join(dir, 'index.html'), PAGE, 'utf8');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  recorded = [];
  finished = false;

  await context.exposeBinding('__rollcutRecord', (_s, action: Record<string, unknown>) => {
    recorded.push(action);
  });
  await context.exposeBinding('__rollcutFinish', () => {
    finished = true;
  });

  page = await context.newPage();
  await page.goto(`${pathToFileURL(dir).href}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(recorderScript());
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('capture recorder', () => {
  it('names a clicked element even when it has no stable attribute', async () => {
    await page.locator('button.only-a-class').click();
    const click = recorded.find((r) => r.kind === 'click');
    // This is the case the planner cannot handle at all.
    expect(click?.selector).toBe('button:has-text("Verify & continue")');
  });

  it('records the value actually entered, not a placeholder', async () => {
    await page.locator('#code').click();
    await page.keyboard.type('MSSS');
    await page.locator('#email').click(); // blur commits the change event
    const typed = recorded.find((r) => r.kind === 'type' && r.selector === '#code');
    expect(typed?.text).toBe('MSSS');
  });

  it('reports keys worth replaying', async () => {
    await page.keyboard.press('Enter');
    expect(recorded.some((r) => r.kind === 'press' && r.key === 'Enter')).toBe(true);
  });

  it('collapses a burst of scrolling into one step', async () => {
    const before = recorded.filter((r) => r.kind === 'scroll').length;
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(900);
    const scrolls = recorded.filter((r) => r.kind === 'scroll').length - before;
    // Six wheel events are one intent, not six steps.
    expect(scrolls).toBe(1);
  });

  it('shows a recording bar and never records clicks on it', async () => {
    expect(await page.locator('#__rollcut-capture-bar').isVisible()).toBe(true);
    const before = recorded.length;
    // Dispatched rather than driven: the point is what the listener does with
    // a click on the bar, not whether Playwright can reach it.
    await page.evaluate(() => {
      document.getElementById('__rollcut-capture-bar')?.click();
    });
    await page.waitForTimeout(200);
    // Rollcut's own UI must not end up in the user's spec.
    expect(recorded.length).toBe(before);
  });

  it('finishes when the Finish button is pressed', async () => {
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#__rollcut-capture-bar button')?.click();
    });
    await page.waitForTimeout(200);
    expect(finished).toBe(true);
  });
});
