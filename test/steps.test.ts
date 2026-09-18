import { describe, expect, it } from 'vitest';
import { specSchema, stepKind } from '../src/spec/schema.js';
import { loadSpec } from '../src/spec/load.js';

describe('phase 4 step types', () => {
  it('accepts scroll by pixels and scroll to a selector', () => {
    const spec = specSchema.parse({
      baseUrl: 'https://example.com',
      steps: [{ scroll: 600 }, { scroll: '#pricing' }],
    });
    expect(stepKind(spec.steps[0]!)).toBe('scroll');
    expect(stepKind(spec.steps[1]!)).toBe('scroll');
  });

  it('accepts hover and waitFor selectors', () => {
    const spec = specSchema.parse({
      baseUrl: 'https://example.com',
      steps: [{ hover: '.nav' }, { waitFor: 'h1', note: 'loaded' }],
    });
    expect(stepKind(spec.steps[0]!)).toBe('hover');
    expect(stepKind(spec.steps[1]!)).toBe('waitFor');
  });

  it('rejects a scroll with the wrong value type', () => {
    const bad = specSchema.safeParse({
      baseUrl: 'https://example.com',
      steps: [{ scroll: true }],
    });
    expect(bad.success).toBe(false);
  });

  it('parses the second demo spec', async () => {
    const spec = await loadSpec('demos/vitest.yaml');
    const kinds = spec.steps.map(stepKind);
    expect(kinds).toContain('scroll');
    expect(kinds).toContain('hover');
    expect(kinds).toContain('waitFor');
  });
});
