import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/spec/load.js';
import { specSchema, stepKind } from '../src/spec/schema.js';

async function specFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rollcut-'));
  const path = join(dir, 'spec.yaml');
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('specSchema', () => {
  it('applies defaults for viewport and pauseMs', () => {
    const spec = specSchema.parse({
      baseUrl: 'https://example.com',
      steps: [{ navigate: '/' }],
    });
    expect(spec.viewport).toEqual({ width: 1280, height: 720 });
    expect(spec.pauseMs).toBe(700);
  });

  it('identifies the step kind, ignoring note', () => {
    expect(stepKind({ click: 'button', note: 'hi' })).toBe('click');
    expect(stepKind({ wait: 500 })).toBe('wait');
  });
});

describe('loadSpec', () => {
  it('parses the canonical demo spec', async () => {
    const spec = await loadSpec('demos/excalidraw.yaml');
    expect(spec.baseUrl).toBe('https://excalidraw.com');
    expect(spec.steps.length).toBeGreaterThan(5);
    expect(stepKind(spec.steps[3]!)).toBe('drag');
  });

  it('names the offending step for an unknown step type', async () => {
    const path = await specFile(
      'baseUrl: https://example.com\nsteps:\n  - navigate: /\n  - frobnicate: yes\n',
    );
    await expect(loadSpec(path)).rejects.toThrow(/step 2/);
  });

  it('rejects a bad baseUrl', async () => {
    const path = await specFile('baseUrl: not-a-url\nsteps:\n  - navigate: /\n');
    await expect(loadSpec(path)).rejects.toThrow(/baseUrl/);
  });

  it('explains a missing file', async () => {
    await expect(loadSpec('demos/nope.yaml')).rejects.toThrow(/Cannot read spec/);
  });
});
