import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { specSchema } from '../../src/spec/schema.js';
import { repair } from '../../src/plan/repair.js';

/** The page as it is *now* — the spec was written against older wording. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Repair fixture</title>
<style>body{font:16px system-ui;margin:0;padding:40px}
button{display:block;margin:10px 0;padding:12px 18px;font-size:16px}</style></head>
<body>
  <h1>Repair fixture</h1>
  <button class="a">Verify and continue</button>
  <button class="b">Delete everything</button>
  <input id="email-address" placeholder="Work email" />
</body></html>`;

let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollcut-repair-'));
  await writeFile(join(dir, 'index.html'), PAGE, 'utf8');
  baseUrl = `${pathToFileURL(dir).href}/`;
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spec = (steps: unknown[]) => specSchema.parse({ baseUrl, pauseMs: 100, steps });

describe('repair', () => {
  it('leaves a spec alone when every step still works', async () => {
    const result = await repair(
      spec([{ navigate: 'index.html' }, { click: 'button:has-text("Verify and continue")' }]),
    );
    expect(result.healthy).toBe(true);
    expect(result.repairs).toEqual([]);
  });

  it('mends a step whose label was reworded', async () => {
    // "Verify & continue" became "Verify and continue".
    const result = await repair(
      spec([
        { navigate: 'index.html' },
        { click: 'button:has-text("Verify & continue")', note: 'Carry on.' },
      ]),
    );

    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      step: 2,
      from: 'button:has-text("Verify & continue")',
      to: 'button:has-text("Verify and continue")',
    });
    // The narration belongs to the step, not the selector.
    expect(result.spec.steps[1]).toMatchObject({ note: 'Carry on.' });
  });

  it('proves a replacement on the page before writing it down', async () => {
    const result = await repair(
      spec([{ navigate: 'index.html' }, { waitFor: 'input[placeholder="Email"]' }]),
    );
    // The field is still there; it is named by its id because an id outlives a
    // placeholder, which is the same preference the observer applies.
    expect(result.repairs[0]?.to).toBe('#email-address');
    // A repair that could not actually run is never offered.
    expect(result.unrepaired).toEqual([]);
  });

  it('refuses rather than suggesting something dangerous', async () => {
    const result = await repair(
      spec([{ navigate: 'index.html' }, { click: 'button:has-text("Publish release")' }]),
    );
    // "Delete everything" is the only button left; offering it would be worse
    // than failing.
    expect(result.repairs).toEqual([]);
    expect(result.unrepaired).toHaveLength(1);
    expect(result.unrepaired[0]).toMatchObject({ step: 2 });
  });

  it('carries on through the rest of the spec after a repair', async () => {
    const result = await repair(
      spec([
        { navigate: 'index.html' },
        { click: 'button:has-text("Verify & continue")' },
        { waitFor: 'button:has-text("Delete everything")' },
      ]),
    );
    expect(result.repairs).toHaveLength(1);
    // The later step ran from whatever state the fix produced.
    expect(result.spec.steps).toHaveLength(3);
  });

  it('leaves behind a spec the recorder still accepts', async () => {
    const result = await repair(
      spec([{ navigate: 'index.html' }, { click: 'button:has-text("Verify & continue")' }]),
    );
    expect(specSchema.safeParse(result.spec).success).toBe(true);
  });
});
