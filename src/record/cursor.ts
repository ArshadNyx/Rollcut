import type { Page } from '@playwright/test';

/**
 * Script injected into every document (including after navigation) that draws
 * an SVG cursor following the real mouse, plus a ripple on click.
 *
 * Deliberately does not zoom: a CSS transform on `<html>` makes
 * `position: fixed` resolve against the transformed element, so sticky headers
 * detach and vanish. The zoom is applied to the finished recording instead —
 * see media/zoom.ts.
 */
function overlayScript(): string {
  return `
(() => {
  if (window.__rollcutCursor) return;
  window.__rollcutCursor = true;

  const CURSOR_SVG =
    "<svg width='28' height='28' viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'>" +
    "<path d='M6 3 L6 22 L11 17.5 L14.2 24.5 L17.6 23 L14.4 16.2 L21 16 Z'" +
    " fill='#111' stroke='#fff' stroke-width='1.6' stroke-linejoin='round'/></svg>";

  const mount = () => {
    if (!document.body) return false;

    const layer = document.createElement('div');
    layer.id = '__rollcut-layer';
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden';

    const cursor = document.createElement('div');
    cursor.style.cssText =
      'position:absolute;left:0;top:0;width:28px;height:28px;' +
      'transform:translate(-100px,-100px);will-change:transform;' +
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))';
    cursor.innerHTML = CURSOR_SVG;
    layer.appendChild(cursor);
    (document.body || document.documentElement).appendChild(layer);

    let x = -100, y = -100;
    const draw = () => { cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };

    document.addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; draw(); }, true);

    document.addEventListener('mousedown', (e) => {
      x = e.clientX; y = e.clientY; draw();
      ripple(e.clientX, e.clientY);
    }, true);

    function ripple(cx, cy) {
      const r = document.createElement('div');
      r.style.cssText =
        'position:absolute;left:' + (cx - 6) + 'px;top:' + (cy - 6) + 'px;' +
        'width:12px;height:12px;border-radius:50%;border:2px solid rgba(37,99,235,.9);' +
        'background:rgba(37,99,235,.18)';
      layer.appendChild(r);
      r.animate(
        [
          { transform: 'scale(0.4)', opacity: 1 },
          { transform: 'scale(3.6)', opacity: 0 },
        ],
        { duration: 520, easing: 'cubic-bezier(.22,.61,.36,1)' },
      ).onfinish = () => r.remove();
    }

    return true;
  };

  if (!mount()) {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
})();
`;
}

/** Install the overlay so it survives every navigation in the session. */
export async function installCursor(page: Page): Promise<void> {
  const script = overlayScript();
  await page.addInitScript(script);
  // The first document may already be open; inject there too.
  await page.evaluate(script).catch(() => undefined);
}

/** Re-assert the overlay after a navigation that raced the init script. */
export async function ensureCursor(page: Page): Promise<void> {
  await page.evaluate(overlayScript()).catch(() => undefined);
}
