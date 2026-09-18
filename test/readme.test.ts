import { describe, expect, it } from 'vitest';
import { applyBlock, renderBlock } from '../src/publish/readme.js';

const block = {
  gifUrl: 'https://example.com/demo.gif',
  mp4Url: 'https://example.com/demo.mp4',
  tag: 'v1.2.0',
  durationSeconds: 18.573,
};

describe('renderBlock', () => {
  it('embeds the gif linking to the mp4, with the tag and duration', () => {
    const md = renderBlock(block);
    expect(md).toContain('[![Demo](https://example.com/demo.gif)](https://example.com/demo.mp4)');
    expect(md).toContain('`v1.2.0`');
    expect(md).toContain('demo-18.6s');
  });
});

describe('applyBlock', () => {
  it('inserts under the first heading when there are no markers', () => {
    const out = applyBlock('# Project\n\nSome prose.\n', renderBlock(block));
    const lines = out.split('\n');
    expect(lines[0]).toBe('# Project');
    expect(out.indexOf('rollcut:start')).toBeLessThan(out.indexOf('Some prose.'));
  });

  it('replaces an existing block rather than stacking a second one', () => {
    const first = applyBlock('# Project\n\nProse.\n', renderBlock(block));
    const second = applyBlock(first, renderBlock({ ...block, tag: 'v2.0.0', durationSeconds: 21 }));
    expect(second.match(/rollcut:start/g)).toHaveLength(1);
    expect(second).toContain('`v2.0.0`');
    expect(second).not.toContain('`v1.2.0`');
    expect(second).toContain('Prose.');
  });

  it('is idempotent for the same input', () => {
    const once = applyBlock('# P\n\nx\n', renderBlock(block));
    expect(applyBlock(once, renderBlock(block))).toBe(once);
  });

  it('prepends when the document has no heading', () => {
    const out = applyBlock('just prose', renderBlock(block));
    expect(out.startsWith('<!-- rollcut:start -->')).toBe(true);
    expect(out).toContain('just prose');
  });
});
