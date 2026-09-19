/** How many intermediate mouse positions we emit when gliding the cursor. */
const GLIDE_STEPS = 22;
/** Tracked so a glide always starts where the cursor actually is. */
let last = [40, 40];
export function resetPointer(start = [40, 40]) {
    last = start;
}
/** Move the mouse along a short eased path so the overlay reads as motion. */
export async function glide(page, to) {
    const [fx, fy] = last;
    const [tx, ty] = to;
    for (let i = 1; i <= GLIDE_STEPS; i++) {
        const t = i / GLIDE_STEPS;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        await page.mouse.move(fx + (tx - fx) * e, fy + (ty - fy) * e);
    }
    last = to;
}
async function centerOf(page, selector, stepNumber) {
    const locator = page.locator(selector).first();
    try {
        await locator.waitFor({ state: 'visible', timeout: 8000 });
    }
    catch {
        throw new Error(`Selector \`${selector}\` not found on step ${stepNumber} — open the site and check the element's attributes, then update the spec.`);
    }
    // We drive the real mouse so the cursor overlay is visible, which means we
    // skip Playwright's built-in auto-scroll — do it explicitly or a click after
    // a scroll lands on empty space.
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box) {
        throw new Error(`Selector \`${selector}\` matched on step ${stepNumber} but has no on-screen box — it may be hidden or zero-sized. Pick a visible element.`);
    }
    const point = [box.x + box.width / 2, box.y + box.height / 2];
    // Driving the real mouse means Playwright's actionability checks are skipped,
    // so a covered element would be "clicked" through whatever sits on top of it —
    // silently producing a demo of the wrong thing. Check we would actually hit it.
    const covering = await locator
        .evaluate((el, at) => {
        const top = document.elementFromPoint(at.x, at.y);
        if (!top || el === top || el.contains(top) || top.contains(el))
            return null;
        return top.tagName.toLowerCase() + (top.id ? '#' + top.id : '');
    }, { x: point[0], y: point[1] })
        .catch(() => null);
    if (covering) {
        throw new Error(`Selector \`${selector}\` on step ${stepNumber} is covered by \`${covering}\` — a click there would hit that instead. Dismiss the overlay first, or pick a different element.`);
    }
    return point;
}
export async function navigate(page, baseUrl, path) {
    const url = new URL(path, baseUrl).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
}
export async function click(page, selector, stepNumber) {
    const point = await centerOf(page, selector, stepNumber);
    await glide(page, point);
    await page.mouse.down();
    await page.mouse.up();
    return point;
}
export async function clickAt(page, point) {
    await glide(page, point);
    await page.mouse.down();
    await page.mouse.up();
    return point;
}
export async function drag(page, from, to) {
    await glide(page, from);
    await page.mouse.down();
    await glide(page, to);
    await page.mouse.up();
}
export async function type(page, text) {
    await page.keyboard.type(text, { delay: 55 });
}
export async function press(page, key) {
    await page.keyboard.press(key);
}
export function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** How long a smooth scroll is given to settle before the next step. */
const SCROLL_SETTLE_MS = 650;
export async function hover(page, selector, stepNumber) {
    const point = await centerOf(page, selector, stepNumber);
    await glide(page, point);
}
/**
 * Scroll by a pixel amount or bring a selector into view. Smooth in both cases
 * so the viewer can follow where the page went.
 */
export async function scroll(page, target, stepNumber) {
    if (typeof target === 'number') {
        await page.evaluate((by) => window.scrollBy({ top: by, behavior: 'smooth' }), target);
    }
    else {
        const locator = page.locator(target).first();
        try {
            await locator.waitFor({ state: 'attached', timeout: 8000 });
        }
        catch {
            throw new Error(`Selector \`${target}\` not found on step ${stepNumber} — cannot scroll to it. Open the site and check the selector.`);
        }
        await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
    await wait(SCROLL_SETTLE_MS);
}
/** Wait until a selector is visible, rather than guessing with a fixed pause. */
export async function waitFor(page, selector, stepNumber) {
    try {
        await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
    }
    catch {
        throw new Error(`Timed out after 15s waiting for \`${selector}\` on step ${stepNumber} — check the selector, or whether the app needs a different trigger first.`);
    }
}
/**
 * Perform one step.
 *
 * Shared by the recorder and by plan verification on purpose: verifying a spec
 * with different logic than the one that records it would prove nothing.
 */
/**
 * Perform one step, returning where a click landed so the caller can aim the
 * zoom that is applied to the finished recording.
 */
export async function executeStep(page, step, stepNumber, options) {
    if ('navigate' in step) {
        await navigate(page, options.baseUrl, step.navigate);
        if (options.settle) {
            await page.waitForLoadState('load').catch(() => undefined);
            await wait(1200);
        }
        await options.onNavigated?.(page);
        resetPointer();
    }
    else if ('click' in step) {
        return await click(page, step.click, stepNumber);
    }
    else if ('clickAt' in step) {
        return await clickAt(page, step.clickAt);
    }
    else if ('drag' in step) {
        await drag(page, step.drag.from, step.drag.to);
    }
    else if ('type' in step) {
        await type(page, step.type);
    }
    else if ('press' in step) {
        await press(page, step.press);
    }
    else if ('wait' in step) {
        await wait(step.wait);
    }
    else if ('scroll' in step) {
        await scroll(page, step.scroll, stepNumber);
    }
    else if ('hover' in step) {
        await hover(page, step.hover, stepNumber);
    }
    else if ('waitFor' in step) {
        await waitFor(page, step.waitFor, stepNumber);
    }
    return undefined;
}
//# sourceMappingURL=steps.js.map