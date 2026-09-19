import { chromium } from '@playwright/test';
/** Enough to plan a walkthrough; few enough to keep the prompt affordable. */
const MAX_ELEMENTS = 90;
const MAX_HEADINGS = 20;
/**
 * Browser-side collector.
 *
 * Built as a string, like the cursor overlay, because the bundler rewrites
 * named functions with a `__name` helper that does not exist in the page.
 *
 * The planner can only write selectors that exist, so this returns selectors
 * already resolved against the live DOM — guessing from raw HTML is how
 * generated specs end up referencing elements that were never there.
 */
function collectorScript(maxElements, maxHeadings) {
    return `(() => {
  // Inside a quoted attribute value only a quote or backslash needs escaping.
  // CSS.escape would also escape '/' and ':', producing selectors that work but
  // are painful to read in a spec a human has to review.
  var attr = function (v) { return v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"'); };
  var ident = function (v) { return window.CSS && window.CSS.escape ? window.CSS.escape(v) : v; };
  var generated = function (id) { return /^[a-z]*[0-9a-f]{6,}$/i.test(id) || /^(radix|headless|mui|react|:r)/i.test(id); };

  // Most stable first: a test id survives a redesign, an nth-child does not.
  var selectorFor = function (el) {
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return '[data-testid="' + attr(testId) + '"]';
    if (el.id && !generated(el.id)) return '#' + ident(el.id);
    var aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + attr(aria) + '"]';
    var title = el.getAttribute('title');
    if (title) return '[title="' + attr(title) + '"]';
    var nm = el.getAttribute('name');
    if (nm) return el.tagName.toLowerCase() + '[name="' + attr(nm) + '"]';
    var href = el.getAttribute('href');
    if (href && href.length < 60) return 'a[href="' + attr(href) + '"]';
    return null;
  };

  var nameOf = function (el) {
    var t = el.getAttribute('aria-label') || el.getAttribute('title') ||
            el.getAttribute('placeholder') || el.textContent || '';
    return t.replace(/\\s+/g, ' ').trim().slice(0, 80);
  };

  var roleOf = function (el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return 'input:' + (el.getAttribute('type') || 'text');
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  };

  var candidates = Array.prototype.slice.call(document.querySelectorAll(
    'a[href], button, input, textarea, select, canvas, [role], [onclick], [data-testid], [data-test-id]'
  ));

  var seen = {};
  var elements = [];
  for (var i = 0; i < candidates.length && elements.length < ${maxElements}; i++) {
    var el = candidates[i];
    var box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

    var selector = selectorFor(el);
    if (!selector || seen[selector]) continue;
    // Keep only selectors resolving to exactly one element, so a generated step
    // cannot silently act on the wrong one.
    if (document.querySelectorAll(selector).length !== 1) continue;
    seen[selector] = true;

    var hrefAttr = el.getAttribute('href') || '';
    var navigates = el.tagName.toLowerCase() === 'a' && hrefAttr !== '' && hrefAttr.charAt(0) !== '#';

    elements.push({
      selector: selector,
      name: nameOf(el),
      role: roleOf(el),
      tag: el.tagName.toLowerCase(),
      navigates: navigates,
      at: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]
    });
  }

  // Only a canvas that *is* the app: on screen at load and covering a real
  // share of the viewport. Decorative or below-the-fold canvases would invite
  // coordinates that point at nothing.
  var canvas = null;
  var vw = window.innerWidth, vh = window.innerHeight;
  var canvases = document.querySelectorAll('canvas');
  for (var c = 0; c < canvases.length; c++) {
    var cb = canvases[c].getBoundingClientRect();
    if (cb.width < 200 || cb.height < 200) continue;
    if (cb.bottom <= 0 || cb.top >= vh || cb.right <= 0 || cb.left >= vw) continue;
    if ((cb.width * cb.height) / (vw * vh) < 0.25) continue;
    if (!canvas || cb.width * cb.height > canvas.width * canvas.height) {
      canvas = {
        x: Math.round(cb.x), y: Math.round(cb.y),
        width: Math.round(cb.width), height: Math.round(cb.height)
      };
    }
  }

  var headings = Array.prototype.slice
    .call(document.querySelectorAll('h1, h2, h3'))
    .map(function (h) { return (h.textContent || '').replace(/\\s+/g, ' ').trim(); })
    .filter(Boolean)
    .slice(0, ${maxHeadings});

  return {
    title: document.title,
    headings: headings,
    elements: elements,
    canvas: canvas,
    scrollable: document.documentElement.scrollHeight > window.innerHeight + 50
  };
})()`;
}
/** Trailing slashes and hashes make the same page look like two. */
export function normalisePath(pathname) {
    const withoutHash = pathname.split('#')[0] ?? '/';
    if (withoutHash.length > 1 && withoutHash.endsWith('/'))
        return withoutHash.slice(0, -1);
    return withoutHash || '/';
}
async function observeInPage(page, url, maxElements) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    catch (e) {
        throw new Error(`Could not load \`${url}\` — check the URL is reachable.`, { cause: e });
    }
    await page.waitForLoadState('load').catch(() => undefined);
    // Single-page apps often paint their controls a beat after load.
    await page.waitForTimeout(1500);
    const observed = (await page.evaluate(collectorScript(maxElements, MAX_HEADINGS)));
    return { url, path: normalisePath(new URL(url).pathname), ...observed };
}
/** Open one page and describe what a demo could interact with. */
export async function observe(url, viewport = { width: 1280, height: 720 }) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport });
        return await observeInPage(await context.newPage(), url, MAX_ELEMENTS);
    }
    finally {
        await browser.close();
    }
}
/** Links worth following: same-site, not a download, not an auth dead end. */
function navigationCandidates(landing, origin) {
    const skip = /\.(pdf|zip|tar|gz|dmg|exe|png|jpe?g|svg|mp4)$/i;
    const avoid = /(login|signin|sign-in|signup|sign-up|register|logout|account|billing|checkout)/i;
    const seen = new Set([landing.path]);
    const out = [];
    for (const element of landing.elements) {
        if (!element.navigates)
            continue;
        const match = /^a\[href="(.*)"\]$/.exec(element.selector);
        if (!match?.[1])
            continue;
        let resolved;
        try {
            resolved = new URL(match[1], origin);
        }
        catch {
            continue;
        }
        if (resolved.origin !== origin)
            continue;
        if (skip.test(resolved.pathname) || avoid.test(resolved.pathname))
            continue;
        const path = normalisePath(resolved.pathname);
        if (seen.has(path))
            continue;
        seen.add(path);
        out.push(`${origin}${path}${resolved.search}`);
    }
    return out;
}
/**
 * Observe the landing page and a few pages it links to.
 *
 * A demo that moves between pages needs to know what is on each of them —
 * observing only where it starts is what made generated specs break the moment
 * they navigated.
 */
export async function observeSite(url, options = {}) {
    const viewport = options.viewport ?? { width: 1280, height: 720 };
    const maxPages = Math.max(1, options.maxPages ?? 4);
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        // Fewer targets per page once there are several, so the prompt stays a
        // sensible size as pages are added.
        const perPage = maxPages > 1 ? Math.max(30, Math.floor(MAX_ELEMENTS / 2)) : MAX_ELEMENTS;
        const landing = await observeInPage(page, url, perPage);
        options.onPage?.(landing.path, landing.elements.length);
        const origin = new URL(landing.url).origin;
        const pages = [landing];
        for (const candidate of navigationCandidates(landing, origin)) {
            if (pages.length >= maxPages)
                break;
            try {
                const observed = await observeInPage(page, candidate, perPage);
                // A redirect can land us somewhere already seen.
                if (pages.some((seenPage) => seenPage.path === observed.path))
                    continue;
                pages.push(observed);
                options.onPage?.(observed.path, observed.elements.length);
            }
            catch {
                // A page that will not load is simply not offered to the planner.
                continue;
            }
        }
        return { origin, pages };
    }
    finally {
        await browser.close();
    }
}
//# sourceMappingURL=observe.js.map