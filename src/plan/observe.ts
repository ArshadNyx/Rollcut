import { chromium, type Page } from '@playwright/test';

/** One thing on the page a step could plausibly act on. */
export interface PageTarget {
  /** A selector we have verified resolves to exactly this element. */
  selector: string;
  /** Accessible name, or trimmed text — what a human would call it. */
  name: string;
  role: string;
  tag: string;
  /**
   * True when acting on this leaves the page. Only the landing page is
   * observed, so nothing after such a step can rely on these selectors.
   */
  navigates: boolean;
  /** Centre point, for the rare case a step needs coordinates. */
  at: [number, number];
}

export interface PageObservation {
  url: string;
  /** Path within the site, normalised — the key a spec's `navigate` uses. */
  path: string;
  /**
   * The URL asked for, when it differs from the one landed on. A link to
   * app.example.com that redirects to /auth/login has to be findable by the
   * address the link actually carries.
   */
  requested?: string;
  title: string;
  /** Visible headings, in order — the page's shape. */
  headings: string[];
  elements: PageTarget[];
  /** True when the page scrolls, so the planner may propose scroll steps. */
  scrollable: boolean;
  /**
   * Bounds of the largest canvas, when the page has one. A canvas app has no
   * selectors for its content, so this is the only way a demo can show it
   * being used.
   */
  canvas?: { x: number; y: number; width: number; height: number };
  /**
   * Every in-page link, regardless of whether it can be uniquely addressed.
   * Uniqueness decides whether a step can *act* on an element; it has nothing
   * to do with knowing where a link leads.
   */
  links: string[];
}

/** Enough to plan a walkthrough; few enough to keep the prompt affordable. */
const MAX_ELEMENTS = 90;
const MAX_HEADINGS = 20;

/**
 * How long to let a page finish rendering.
 *
 * No fixed wait suits every site: a static page is ready immediately, and a
 * heavy single-page app can take seconds. Rather than pick a number that is
 * wrong for somebody, watch until the page stops changing.
 */
const SETTLE_POLL_MS = 250;
const SETTLE_STABLE_POLLS = 3;
const SETTLE_MAX_MS = 12_000;

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
/**
 * Browser-side selector helpers, shared by observation and capture.
 *
 * Both have to name elements the same way: a spec written by capture and one
 * proposed by the planner should be indistinguishable, and a selector that
 * works in one must work in the other.
 */
export function selectorHelpersScript(): string {
  return `
  var attr = function (v) { return v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"'); };
  var ident = function (v) { return window.CSS && window.CSS.escape ? window.CSS.escape(v) : v; };
  var generated = function (id) { return /^[a-z]*[0-9a-f]{6,}$/i.test(id) || /^(radix|headless|mui|react|:r)/i.test(id); };

  // Icon fonts put private-use glyphs in textContent; they are invisible in
  // the page and useless in a selector.
  var clean = function (t) {
    return (t || '')
      .replace(/[\\uE000-\\uF8FF]/g, ' ')
      .replace(/[\\uDB80-\\uDBFF][\\uDC00-\\uDFFF]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  };

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

    var tag = el.tagName.toLowerCase();

    // An input has no text of its own; its placeholder is the next best thing.
    var ph = el.getAttribute('placeholder');
    if (ph) return tag + '[placeholder="' + attr(ph) + '"]';
    var type = el.getAttribute('type');
    if (type && tag === 'input') return 'input[type="' + attr(type) + '"]';

    // Last resort: match on visible text. Component libraries that emit only
    // class names — Tamagui, many React Native Web apps — leave nothing else,
    // and without this those pages yield no targets at all.
    var text = window.__rollcutClean(el.textContent).slice(0, 40);
    if (text.length >= 2) return tag + ':has-text("' + attr(text) + '")';
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


  window.__rollcutSelector = selectorFor;
  window.__rollcutClean = clean;

  // has-text is Playwright syntax, not CSS, so querySelectorAll cannot check
  // it — count same-tag elements carrying the same text instead.
  // A control repeated in a header, hero and footer — the commonest shape for
  // the most important link on a marketing page — is never unique. It is
  // still usable when the one in question is the first match, because that is
  // what a spec acts on.
  window.__rollcutAddressable = function (el, selector) {
    if (window.__rollcutUnique(el, selector)) return true;
    try {
      var all = document.querySelectorAll(selector);
      return all.length > 0 && all[0] === el;
    } catch (e) {
      return false;
    }
  };

  window.__rollcutUnique = function (el, selector) {
    if (!selector) return false;
    if (selector.indexOf(':has-text("') !== -1) {
      var wanted = clean(el.textContent).slice(0, 40);
      var sameTag = document.querySelectorAll(el.tagName.toLowerCase());
      var hits = 0;
      for (var t = 0; t < sameTag.length; t++) {
        if (clean(sameTag[t].textContent).indexOf(wanted) !== -1) hits++;
      }
      return hits === 1;
    }
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  };
`;
}

function collectorScript(maxElements: number, maxHeadings: number, canvasShare = 0.25): string {
  return `(() => {
  // Inside a quoted attribute value only a quote or backslash needs escaping.
  // CSS.escape would also escape '/' and ':', producing selectors that work but
  // are painful to read in a spec a human has to review.
  ${selectorHelpersScript()}

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

    var selector = window.__rollcutSelector(el);
    if (!selector || seen[selector]) continue;

    // A selector must address *this* element: either uniquely, or as the first
    // of several identical ones, which is what a step would act on anyway.
    if (!window.__rollcutAddressable(el, selector)) continue;
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
    if ((cb.width * cb.height) / (vw * vh) < ${canvasShare}) continue;
    if (!canvas || cb.width * cb.height > canvas.width * canvas.height) {
      canvas = {
        x: Math.round(cb.x), y: Math.round(cb.y),
        width: Math.round(cb.width), height: Math.round(cb.height)
      };
    }
  }

  var links = [];
  var anchors = document.querySelectorAll('a[href]');
  for (var L = 0; L < anchors.length && links.length < 200; L++) {
    var h = anchors[L].getAttribute('href');
    if (h && h.charAt(0) !== '#' && links.indexOf(h) === -1) links.push(h);
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
    links: links,
    canvas: canvas,
    scrollable: document.documentElement.scrollHeight > window.innerHeight + 50
  };
})()`;
}

/** Everything the planner knows about a site, one entry per page visited. */
export interface SiteObservation {
  /** Scheme and host; a spec's baseUrl. */
  origin: string;
  /** The landing page is always first. */
  pages: PageObservation[];
}

/** Trailing slashes and hashes make the same page look like two. */
export function normalisePath(pathname: string): string {
  const withoutHash = pathname.split('#')[0] ?? '/';
  if (withoutHash.length > 1 && withoutHash.endsWith('/')) return withoutHash.slice(0, -1);
  return withoutHash || '/';
}

/**
 * Read the targets on a page that is already open.
 *
 * Repair needs this: the page it must search is the one the spec has already
 * navigated and clicked its way to, which no fresh visit could reproduce.
 */
export async function collectTargets(
  page: Page,
  maxElements: number = MAX_ELEMENTS,
): Promise<PageTarget[]> {
  const observed = (await page
    .evaluate(collectorScript(maxElements, MAX_HEADINGS))
    .catch(() => ({ elements: [] }))) as { elements?: PageTarget[] };
  return observed.elements ?? [];
}

/**
 * Wait until the page stops producing new targets.
 *
 * Polls rather than guessing: an app that hydrates in 200ms is not delayed,
 * and one that takes four seconds is not cut short. The cap only exists so a
 * page that never settles — a carousel, a live feed — cannot hang the run.
 */
async function settle(page: Page, maxElements: number): Promise<void> {
  const deadline = Date.now() + SETTLE_MAX_MS;
  let previous = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const count = (await collectTargets(page, maxElements).catch(() => [])).length;
    stable = count === previous ? stable + 1 : 0;
    previous = count;
    // Settled means unchanged for a few polls *and* actually showing something;
    // a count stuck at zero is a page still building itself.
    if (stable >= SETTLE_STABLE_POLLS && count > 0) return;
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
}

async function observeInPage(
  page: Page,
  url: string,
  maxElements: number,
): Promise<PageObservation> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    throw new Error(`Could not load \`${url}\` — check the URL is reachable.`, { cause: e });
  }
  await page.waitForLoadState('load').catch(() => undefined);
  await settle(page, maxElements);

  const observed = (await page.evaluate(collectorScript(maxElements, MAX_HEADINGS))) as Omit<
    PageObservation,
    'url' | 'path'
  >;
  // The URL landed on, not the one asked for: app.example.com/ may redirect to
  // /auth/login, and the spec has to navigate to where it actually ended up.
  const landed = page.url() || url;
  return {
    url: landed,
    ...(landed === url ? {} : { requested: url }),
    path: normalisePath(new URL(landed).pathname),
    ...observed,
  };
}

/** Open one page and describe what a demo could interact with. */
export async function observe(
  url: string,
  viewport: { width: number; height: number } = { width: 1280, height: 720 },
): Promise<PageObservation> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport });
    return await observeInPage(await context.newPage(), url, MAX_ELEMENTS);
  } finally {
    await browser.close();
  }
}

/**
 * Paths never worth crawling: they end the session or cost money.
 *
 * Deliberately short. Sign-in and sign-up pages are *not* excluded — for a
 * great many products the sign-in flow is the demo, and refusing to look at it
 * means refusing to look at the product.
 */
export const DEFAULT_AVOID = /(logout|signout|sign-out|delete|checkout|billing)/i;

/**
 * Whether two hosts belong to the same product.
 *
 * Same-origin is too strict: a marketing site on www and the app on a
 * subdomain is the commonest shape there is, and refusing to cross that
 * boundary means never reaching the product. Compares the registrable domain,
 * which is a simplification for multi-part suffixes like co.uk but errs
 * towards staying put rather than wandering off-site.
 */
export function sameSite(a: string, b: string): boolean {
  const base = (host: string) =>
    host
      .replace(/^www\./, '')
      .split('.')
      .slice(-2)
      .join('.');
  return base(a) === base(b);
}

/** Binary files a browser would download rather than render. */
const DOWNLOADS = /\.(pdf|zip|tar|gz|dmg|exe|png|jpe?g|svg|mp4)$/i;

/** Links worth following: same-site, not a download, not a dead end. */
function navigationCandidates(
  landing: PageObservation,
  origin: string,
  avoid: RegExp = DEFAULT_AVOID,
): string[] {
  const skip = DOWNLOADS;
  const seen = new Set([`${origin}${landing.path}`]);
  const out: string[] = [];

  for (const href of landing.links ?? []) {
    let resolved: URL;
    try {
      resolved = new URL(href, origin);
    } catch {
      continue;
    }
    if (!sameSite(resolved.hostname, new URL(origin).hostname)) continue;
    if (skip.test(resolved.pathname) || avoid.test(resolved.pathname)) continue;

    // Keyed by origin too: /auth on the app is not /auth on the marketing site.
    const path = normalisePath(resolved.pathname);
    const key = `${resolved.origin}${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${resolved.origin}${path}${resolved.search}`);
  }
  return out;
}

export interface SiteOptions {
  viewport?: { width: number; height: number };
  /** Total pages to observe, landing page included. */
  maxPages?: number;
  /** Targets kept per page. Raise it for a dense app. */
  maxElements?: number;
  /** Paths not to crawl. Defaults to session-ending and paid ones. */
  avoid?: RegExp;
  onPage?: (path: string, elements: number) => void;
}

/**
 * Observe the landing page and a few pages it links to.
 *
 * A demo that moves between pages needs to know what is on each of them —
 * observing only where it starts is what made generated specs break the moment
 * they navigated.
 */
export async function observeSite(
  url: string,
  options: SiteOptions = {},
): Promise<SiteObservation> {
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const maxPages = Math.max(1, options.maxPages ?? 4);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    // Fewer targets per page once there are several, so the prompt stays a
    // sensible size as pages are added.
    const budget = options.maxElements ?? MAX_ELEMENTS;
    const perPage = maxPages > 1 ? Math.max(30, Math.floor(budget / 2)) : budget;

    const landing = await observeInPage(page, url, perPage);
    options.onPage?.(landing.path, landing.elements.length);

    const origin = new URL(landing.url).origin;
    const pages: PageObservation[] = [landing];

    for (const candidate of navigationCandidates(landing, origin, options.avoid)) {
      if (pages.length >= maxPages) break;
      try {
        const observed = await observeInPage(page, candidate, perPage);
        // Keyed by origin as well as path: a marketing site's "/" and an app
        // subdomain's "/" are different pages that happen to share a name.
        const key = (p: PageObservation) => `${new URL(p.url).origin}${p.path}`;
        if (pages.some((seenPage) => key(seenPage) === key(observed))) continue;
        pages.push(observed);
        options.onPage?.(observed.path, observed.elements.length);
      } catch {
        // A page that will not load is simply not offered to the planner.
        continue;
      }
    }

    return { origin, pages };
  } finally {
    await browser.close();
  }
}
