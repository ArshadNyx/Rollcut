import type { Page } from '@playwright/test';

/** How many intermediate mouse positions we emit when gliding the cursor. */
const GLIDE_STEPS = 22;

export type Point = readonly [number, number];

/** Tracked so a glide always starts where the cursor actually is. */
let last: Point = [40, 40];

export function resetPointer(start: Point = [40, 40]): void {
  last = start;
}

/** Move the mouse along a short eased path so the overlay reads as motion. */
export async function glide(page: Page, to: Point): Promise<void> {
  const [fx, fy] = last;
  const [tx, ty] = to;
  for (let i = 1; i <= GLIDE_STEPS; i++) {
    const t = i / GLIDE_STEPS;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(fx + (tx - fx) * e, fy + (ty - fy) * e);
  }
  last = to;
}

async function centerOf(page: Page, selector: string, stepNumber: number): Promise<Point> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    throw new Error(
      `Selector \`${selector}\` not found on step ${stepNumber} — open the site and check the element's attributes, then update the spec.`,
    );
  }
  // We drive the real mouse so the cursor overlay is visible, which means we
  // skip Playwright's built-in auto-scroll — do it explicitly or a click after
  // a scroll lands on empty space.
  await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => undefined);
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(
      `Selector \`${selector}\` matched on step ${stepNumber} but has no on-screen box — it may be hidden or zero-sized. Pick a visible element.`,
    );
  }

  const point: Point = [box.x + box.width / 2, box.y + box.height / 2];
  const view = page.viewportSize();
  if (view && (point[0] < 0 || point[1] < 0 || point[0] > view.width || point[1] > view.height)) {
    throw new Error(
      `Selector \`${selector}\` on step ${stepNumber} sits outside the viewport at (${Math.round(point[0])}, ${Math.round(point[1])}) even after scrolling — it may be in a fixed overlay or a scroll container. Try a \`scroll\` step first.`,
    );
  }
  return point;
}

export async function navigate(page: Page, baseUrl: string, path: string): Promise<void> {
  const url = new URL(path, baseUrl).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

export async function click(page: Page, selector: string, stepNumber: number): Promise<void> {
  const point = await centerOf(page, selector, stepNumber);
  await glide(page, point);
  await page.mouse.down();
  await page.mouse.up();
}

export async function clickAt(page: Page, point: Point): Promise<void> {
  await glide(page, point);
  await page.mouse.down();
  await page.mouse.up();
}

export async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await glide(page, from);
  await page.mouse.down();
  await glide(page, to);
  await page.mouse.up();
}

export async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 55 });
}

export async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a smooth scroll is given to settle before the next step. */
const SCROLL_SETTLE_MS = 650;

export async function hover(page: Page, selector: string, stepNumber: number): Promise<void> {
  const point = await centerOf(page, selector, stepNumber);
  await glide(page, point);
}

/**
 * Scroll by a pixel amount or bring a selector into view. Smooth in both cases
 * so the viewer can follow where the page went.
 */
export async function scroll(
  page: Page,
  target: number | string,
  stepNumber: number,
): Promise<void> {
  if (typeof target === 'number') {
    await page.evaluate((by) => window.scrollBy({ top: by, behavior: 'smooth' }), target);
  } else {
    const locator = page.locator(target).first();
    try {
      await locator.waitFor({ state: 'attached', timeout: 8000 });
    } catch {
      throw new Error(
        `Selector \`${target}\` not found on step ${stepNumber} — cannot scroll to it. Open the site and check the selector.`,
      );
    }
    await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  await wait(SCROLL_SETTLE_MS);
}

/** Wait until a selector is visible, rather than guessing with a fixed pause. */
export async function waitFor(page: Page, selector: string, stepNumber: number): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error(
      `Timed out after 15s waiting for \`${selector}\` on step ${stepNumber} — check the selector, or whether the app needs a different trigger first.`,
    );
  }
}
