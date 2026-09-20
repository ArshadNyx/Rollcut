import { chromium } from '@playwright/test';
import { normalisePath, selectorHelpersScript } from './observe.js';

/** One thing the person did, in the order they did it. */
export interface CapturedAction {
  kind: 'click' | 'type' | 'press' | 'scroll' | 'navigate';
  selector?: string;
  text?: string;
  key?: string;
  pixels?: number;
  /** Milliseconds since capture started, used to insert realistic pauses. */
  atMs: number;
}

export interface CaptureResult {
  origin: string;
  startPath: string;
  actions: CapturedAction[];
}

/** The floating bar and the listeners that report what the person does. */
export function recorderScript(): string {
  return `
  ${selectorHelpersScript()}

  if (!window.__rollcutCapture) {
    window.__rollcutCapture = true;

    var bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#111;color:#fff;font:13px system-ui;padding:10px 14px;border-radius:999px;' +
      'display:flex;gap:12px;align-items:center;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#e5484d';
    var label = document.createElement('span');
    label.textContent = 'Recording — 0 steps';
    var done = document.createElement('button');
    done.textContent = 'Finish';
    done.style.cssText =
      'background:#fff;color:#111;border:0;border-radius:999px;padding:5px 12px;' +
      'font:600 13px system-ui;cursor:pointer';
    bar.appendChild(dot); bar.appendChild(label); bar.appendChild(done);

    var mount = function () {
      if (document.body && !document.getElementById('__rollcut-capture-bar')) {
        bar.id = '__rollcut-capture-bar';
        document.body.appendChild(bar);
      }
    };
    mount();
    document.addEventListener('DOMContentLoaded', mount);

    var count = 0;
    var send = function (action) {
      // The bar is Rollcut's own UI; it must never end up in the spec.
      count++;
      label.textContent = 'Recording — ' + count + ' step' + (count === 1 ? '' : 's');
      window.__rollcutRecord(action);
    };

    done.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      window.__rollcutFinish();
    }, true);

    var interactive = function (el) {
      var t = el.tagName.toLowerCase();
      return t === 'a' || t === 'button' || t === 'input' || t === 'textarea' ||
             t === 'select' || t === 'label' || el.getAttribute('role') === 'button';
    };

    document.addEventListener('click', function (e) {
      if (bar.contains(e.target)) return;
      var el = e.target;

      // Walk up to the nearest control. Without this the label inside a button
      // names nothing, and a miss lands on a page-wide container whose only
      // distinguishing feature is a paragraph of text.
      for (var i = 0; i < 5 && el && el !== document.body; i++) {
        if (interactive(el)) break;
        el = el.parentElement;
      }
      if (!el || !interactive(el)) return;

      var sel = window.__rollcutSelector(el);
      if (!sel) return;

      if (!window.__rollcutUnique(el, sel)) {
        // A repeated control (three "Open" links, say) is still usable when
        // the one clicked is the first match, because that is what the
        // recorder acts on. Otherwise recording nothing beats recording a
        // selector that points at the wrong element.
        var matches;
        try {
          matches = document.querySelectorAll(sel);
        } catch (err) {
          return;
        }
        if (!matches.length || matches[0] !== el) return;
      }
      send({ kind: 'click', selector: sel });
    }, true);

    // 'change' fires once the field is done, so the spec gets the final value
    // rather than one step per keystroke.
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
      if (bar.contains(el)) return;
      var sel = window.__rollcutSelector(el);
      if (sel) send({ kind: 'type', selector: sel, text: el.value });
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
        send({ kind: 'press', key: e.key });
      }
    }, true);

    var scrollTimer = null;
    var lastY = window.scrollY;
    window.addEventListener('scroll', function () {
      if (scrollTimer) clearTimeout(scrollTimer);
      // One step for a burst of wheel events, not sixty.
      scrollTimer = setTimeout(function () {
        var delta = Math.round(window.scrollY - lastY);
        lastY = window.scrollY;
        if (Math.abs(delta) > 80) send({ kind: 'scroll', pixels: delta });
      }, 400);
    }, true);
  }
`;
}

export interface CaptureOptions {
  url: string;
  viewport?: { width: number; height: number };
  onAction?: (action: CapturedAction) => void;
}

/**
 * Open a real browser and record what the person does.
 *
 * No observer can reach a page that only exists after a login, a modal or a
 * multi-step wizard, and none can guess that the school code is "MSSS".
 * Watching a real run sidesteps both: the steps are what actually happened.
 */
export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const browser = await chromium.launch({ headless: false, args: ['--hide-scrollbars'] });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const started = Date.now();
  const actions: CapturedAction[] = [];
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  await context.exposeBinding(
    '__rollcutRecord',
    (_source, action: Omit<CapturedAction, 'atMs'>) => {
      const entry = { ...action, atMs: Date.now() - started } as CapturedAction;
      actions.push(entry);
      options.onAction?.(entry);
    },
  );
  await context.exposeBinding('__rollcutFinish', () => finish());

  const script = recorderScript();
  await page.addInitScript(script);

  // Every navigation is a step in its own right, and the page it lands on
  // needs the recorder re-installed.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const path = normalisePath(new URL(frame.url()).pathname);
      const last = actions[actions.length - 1];
      if (last?.kind !== 'navigate' || last.selector !== path) {
        actions.push({ kind: 'navigate', selector: path, atMs: Date.now() - started });
        // The page's own title says what this screen is, which a selector
        // never does — narration without it guesses from element labels.
        void page
          .title()
          .then((title) => {
            const entry = actions[actions.length - 1];
            if (entry?.kind === 'navigate' && title) entry.text = title;
          })
          .catch(() => undefined);
      }
    } catch {
      // A data: or about: URL is not a step.
    }
  });

  page.on('close', () => finish());
  context.on('close', () => finish());

  await page.goto(options.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(script).catch(() => undefined);

  await finished;

  const origin = new URL(options.url).origin;
  const startPath = normalisePath(new URL(options.url).pathname);
  await browser.close().catch(() => undefined);

  return { origin, startPath, actions };
}
