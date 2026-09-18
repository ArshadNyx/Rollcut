import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPipeline } from '../../src/pipeline.js';

/**
 * Served from disk rather than a live site: a third party changing their markup
 * should never turn CI red.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Rollcut fixture</title>
<style>
  body { font: 16px system-ui; margin: 0; padding: 40px; }
  #panel { display: none; margin-top: 20px; padding: 20px; background: #eef; }
  button { padding: 12px 20px; font-size: 16px; }
  #tall { height: 1400px; }
</style></head>
<body>
  <h1>Rollcut fixture</h1>
  <button id="go">Show panel</button>
  <input id="field" placeholder="type here" />
  <div id="panel">Panel is visible</div>
  <div id="tall"></div>
  <div id="bottom">Bottom of the page</div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('panel').style.display = 'block';
    });
  </script>
</body></html>`;

let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollcut-e2e-'));
  await writeFile(join(dir, 'index.html'), PAGE, 'utf8');
  // Trailing slash matters: step paths resolve against it.
  baseUrl = `${pathToFileURL(dir).href}/`;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function specFile(steps: string): Promise<string> {
  const path = join(dir, `spec-${Math.random().toString(36).slice(2)}.yaml`);
  await writeFile(path, `baseUrl: ${baseUrl}\npauseMs: 150\nsteps:\n${steps}`, 'utf8');
  return path;
}

describe('pipeline (silent)', () => {
  it('records every step type and produces a playable mp4 and gif', async () => {
    const spec = await specFile(
      [
        '  - navigate: index.html',
        '  - waitFor: "#go"',
        '  - hover: "#go"',
        '  - click: "#go"',
        '  - waitFor: "#panel"',
        '  - clickAt: [200, 200]',
        '  - click: "#field"',
        '  - type: "hello"',
        '  - press: Escape',
        '  - drag: { from: [300, 300], to: [420, 380] }',
        '  - scroll: 400',
        '  - scroll: "#bottom"',
        '  - wait: 200',
      ].join('\n'),
    );
    const out = join(dir, 'out-full');

    const result = await runPipeline({ specPath: spec, outDir: out, narration: false });

    expect(result.steps).toBe(13);
    expect(result.narrated).toBe(false);
    expect(result.durationSeconds).toBeGreaterThan(1);

    const [mp4, gif] = await Promise.all([stat(result.mp4), stat(result.gif)]);
    expect(mp4.size).toBeGreaterThan(10_000);
    expect(gif.size).toBeGreaterThan(1_000);
    // Phase 2 target: the GIF has to stay embeddable in a README.
    expect(gif.size).toBeLessThan(8_000_000);

    // ftyp box marks a real MP4 container.
    const head = await readFile(result.mp4);
    expect(head.subarray(4, 8).toString('ascii')).toBe('ftyp');
    // A silent run must not produce a subtitle sidecar.
    expect(result.srt).toBeUndefined();
  });

  it('fails with an actionable message when a selector is missing', async () => {
    const spec = await specFile(
      ['  - navigate: index.html', '  - click: "#does-not-exist"'].join('\n'),
    );
    await expect(
      runPipeline({ specPath: spec, outDir: join(dir, 'out-bad'), narration: false }),
    ).rejects.toThrow(/#does-not-exist.*step 2/s);
  });
});
