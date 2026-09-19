import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { specSchema } from '../../src/spec/schema.js';
import { verify } from '../../src/plan/verify.js';

/**
 * Deliberately awkward: a button that only appears after a delay, and one
 * covered by an overlay. Neither is detectable by looking at selectors — the
 * whole point of verifying in a browser.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Verify fixture</title>
<style>
  body { font: 16px system-ui; margin: 0; padding: 40px; height: 1600px; }
  #late { display: none; }
  /* The overlay covers only #covered, not the whole page. */
  #covered-wrap { position: relative; display: inline-block; }
  #overlay { position: absolute; inset: -4px; background: rgba(0,0,0,.4); z-index: 99; }
  button { padding: 12px 20px; font-size: 16px; }
</style></head>
<body>
  <h1>Verify fixture</h1>
  <button id="ready">Ready now</button>
  <button id="late">Appears late</button>
  <span id="covered-wrap"><button id="covered">Under an overlay</button><div id="overlay"></div></span>
  <input id="field" />
  <script>
    setTimeout(() => { document.getElementById('late').style.display = 'inline-block'; }, 1200);
  </script>
</body></html>`;

let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollcut-verify-'));
  await writeFile(join(dir, 'index.html'), PAGE, 'utf8');
  baseUrl = `${pathToFileURL(dir).href}/`;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spec(steps: unknown[]) {
  return specSchema.parse({ baseUrl, pauseMs: 100, steps });
}

describe('verify', () => {
  it('passes a spec whose steps all work', async () => {
    const result = await verify(
      spec([{ navigate: 'index.html' }, { waitFor: '#ready' }, { click: '#ready' }]),
    );
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(3);
    expect(result.spec.steps).toHaveLength(3);
  });

  it('drops a step whose selector does not exist and keeps the rest', async () => {
    const result = await verify(
      spec([
        { navigate: 'index.html' },
        { click: '#does-not-exist' },
        { click: '#ready', note: 'still fine' },
      ]),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ step: 2, kind: 'click' });
    expect(result.failures[0]!.reason).toMatch(/does-not-exist/);
    // The good step after the failure survives.
    expect(result.spec.steps).toContainEqual({ click: '#ready', note: 'still fine' });
  });

  it('catches a step that fails for reasons no static check could see', async () => {
    // #covered exists and is visible, but an overlay intercepts the click.
    // Only running it reveals that.
    const result = await verify(spec([{ navigate: 'index.html' }, { click: '#covered' }]));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.kind).toBe('click');
    expect(result.spec.steps).toHaveLength(1);
  });

  it('accepts a step that only works once the app catches up', async () => {
    // #late appears after 1.2s; waitFor should ride it out rather than fail.
    const result = await verify(
      spec([{ navigate: 'index.html' }, { waitFor: '#late' }, { hover: '#late' }]),
    );
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(3);
  });

  it('reports the cause when the opening navigate fails', async () => {
    // Nothing ran, so there is no spec to return — say why rather than hand
    // back something that fails validation for an unrelated reason.
    await expect(verify(spec([{ navigate: 'nope.html' }, { click: '#ready' }]))).rejects.toThrow(
      /No proposed step ran/,
    );
  });

  it('abandons later steps when a navigate mid-spec fails', async () => {
    const result = await verify(
      spec([
        { navigate: 'index.html' },
        { click: '#ready' },
        { navigate: 'nope.html' },
        { click: '#field' },
      ]),
    );
    expect(result.failures.some((f) => /earlier navigate failed/.test(f.reason))).toBe(true);
    expect(result.spec.steps).toHaveLength(2);
  });

  it('leaves behind a spec the recorder will still accept', async () => {
    const result = await verify(
      spec([{ navigate: 'index.html' }, { click: '#nope' }, { wait: 100 }]),
    );
    // Re-parsing is what guarantees pruning cannot produce an invalid spec.
    expect(specSchema.safeParse(result.spec).success).toBe(true);
  });
});
