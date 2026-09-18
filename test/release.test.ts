import { describe, expect, it } from 'vitest';
import { contentTypeFor } from '../src/publish/release.js';

describe('contentTypeFor', () => {
  it('maps the assets Rollcut produces', () => {
    expect(contentTypeFor('out/demo.mp4')).toBe('video/mp4');
    expect(contentTypeFor('out/demo.gif')).toBe('image/gif');
    expect(contentTypeFor('out/demo.srt')).toBe('application/x-subrip');
  });

  it('falls back to octet-stream for anything else', () => {
    expect(contentTypeFor('out/demo.webm')).toBe('application/octet-stream');
    expect(contentTypeFor('noextension')).toBe('application/octet-stream');
  });
});
