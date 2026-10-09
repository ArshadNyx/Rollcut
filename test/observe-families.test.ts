import { describe, expect, it } from 'vitest';
import { familyOf, trimByFamily } from '../src/plan/observe.js';

describe('trimByFamily', () => {
  it('groups query variants, list items and numeric buttons', () => {
    expect(familyOf('a[href="/models?pipeline_tag=text-generation"]')).toBe(
      'a[href="/models?pipeline_tag=*"]',
    );
    expect(familyOf('a[href="/google/embeddinggemma-2"]')).toBe('a[href="/google/*"]');
    expect(familyOf('a[href="/models"]')).toBe('a[href="/models"]');
    expect(familyOf('button:has-text("12B")')).toBe('button:has-text(<number>)');
    expect(familyOf('button:has-text("Tasks")')).toBe('button:has-text("Tasks")');
  });

  it('keeps a few of each family so the content below the filters survives the budget', () => {
    const els = [
      ...Array.from({ length: 6 }, (_, i) => ({
        selector: `a[href="/models?pipeline_tag=t${i}"]`,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({ selector: `button:has-text("${i}B")` })),
      { selector: 'button:has-text("Sort: Trending")' },
      { selector: 'a[href="/org/model-a"]' },
      { selector: 'a[href="/org/model-b"]' },
    ];
    const kept = trimByFamily(els, 10).map((e) => e.selector);
    expect(kept).toHaveLength(9);
    expect(kept.filter((s) => s.includes('pipeline_tag'))).toHaveLength(3);
    expect(kept.filter((s) => /\dB/.test(s))).toHaveLength(3);
    expect(kept).toContain('a[href="/org/model-a"]');
    expect(kept).toContain('a[href="/org/model-b"]');
  });
});
