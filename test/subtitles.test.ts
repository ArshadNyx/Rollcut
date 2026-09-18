import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, maxChars, toAss, toSrt, wrap } from '../src/media/subtitles.js';

describe('wrap', () => {
  it('leaves a short line alone', () => {
    expect(wrap('Pick the rectangle tool.')).toEqual(['Pick the rectangle tool.']);
  });

  it('keeps a typical note on one line', () => {
    expect(wrap('This is Excalidraw, a whiteboard that runs in the browser.')).toHaveLength(1);
  });

  it('splits a line that cannot fit into two balanced lines', () => {
    const lines = wrap(
      'This is Excalidraw, a whiteboard that runs in the browser and needs no account at all, ever, for anyone.',
    );
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toBe(
      'This is Excalidraw, a whiteboard that runs in the browser and needs no account at all, ever, for anyone.',
    );
    const diff = Math.abs(lines[0]!.length - lines[1]!.length);
    expect(diff).toBeLessThan(20);
  });

  it('collapses whitespace', () => {
    expect(wrap('  a   b  ')).toEqual(['a b']);
  });
});

describe('toSrt', () => {
  it('formats timings as hh:mm:ss,mmm', () => {
    const srt = toSrt([{ startMs: 3_661_500, endMs: 3_663_000, text: 'hi' }]);
    expect(srt).toContain('01:01:01,500 --> 01:01:03,000');
  });

  it('numbers cues from one and separates them with a blank line', () => {
    const srt = toSrt([
      { startMs: 0, endMs: 1000, text: 'one' },
      { startMs: 2000, endMs: 3000, text: 'two' },
    ]);
    expect(srt.split('\n')[0]).toBe('1');
    expect(srt).toContain('\n2\n');
    expect(srt.endsWith('\n')).toBe(true);
  });

  it('drops cues with no duration or no text', () => {
    const srt = toSrt([
      { startMs: 1000, endMs: 1000, text: 'zero length' },
      { startMs: 0, endMs: 500, text: '   ' },
      { startMs: 0, endMs: 900, text: 'kept' },
    ]);
    expect(srt).toContain('kept');
    expect(srt).not.toContain('zero length');
    expect(srt.trim().split('\n')[0]).toBe('1');
  });
});

describe('toAss', () => {
  it('declares the video resolution so sizes are real pixels', () => {
    const ass = toAss([{ startMs: 0, endMs: 1000, text: 'hi' }]);
    expect(ass).toContain(`PlayResX: ${DEFAULT_STYLE.width}`);
    expect(ass).toContain(`PlayResY: ${DEFAULT_STYLE.height}`);
  });

  it('formats dialogue times in centiseconds', () => {
    const ass = toAss([{ startMs: 5963, endMs: 8363, text: 'Pick the rectangle tool.' }]);
    expect(ass).toContain('Dialogue: 0,0:00:05.96,0:00:08.36,Rollcut');
  });

  it('honours a custom viewport when sizing', () => {
    const wide = maxChars({ ...DEFAULT_STYLE, width: 1920 });
    expect(wide).toBeGreaterThan(maxChars());
  });

  it('joins wrapped lines with the ASS line break', () => {
    const long = 'word '.repeat(40).trim();
    expect(toAss([{ startMs: 0, endMs: 1000, text: long }])).toContain('\\N');
  });
});

describe('font selection', () => {
  it('names a font that resolves on macOS, Windows and Linux runners', () => {
    // Helvetica does not exist on ubuntu runners; libass would substitute a
    // wider face and the same spec would wrap differently in CI.
    expect(DEFAULT_STYLE.fontName).toBe('Arial');
    expect(toAss([{ startMs: 0, endMs: 1000, text: 'hi' }])).toContain('Style: Rollcut,Arial,');
  });

  it('lets a caller override the font', () => {
    const ass = toAss([{ startMs: 0, endMs: 1000, text: 'hi' }], {
      ...DEFAULT_STYLE,
      fontName: 'Inter',
    });
    expect(ass).toContain('Style: Rollcut,Inter,');
  });
});
