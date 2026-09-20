import { describe, expect, it } from 'vitest';
import { rank, readSelector, score } from '../src/plan/repair.js';
import type { PageTarget } from '../src/plan/observe.js';

function target(selector: string, name: string, tag = 'button'): PageTarget {
  return { selector, name, role: tag, tag, navigates: false, at: [0, 0] };
}

describe('readSelector', () => {
  it('pulls the identifying text out of each selector shape', () => {
    expect(readSelector('[data-testid="toolbar-rectangle"]').text).toBe('toolbar-rectangle');
    expect(readSelector('[aria-label="Sign in as Teacher"]').text).toBe('Sign in as Teacher');
    expect(readSelector('input[placeholder="STX-2025"]')).toEqual({
      text: 'STX-2025',
      tag: 'input',
    });
    expect(readSelector('button:has-text("Verify & continue")')).toEqual({
      text: 'Verify & continue',
      tag: 'button',
    });
    expect(readSelector('#install').text).toBe('install');
  });
});

describe('score', () => {
  it('rates a reworded label highly', () => {
    // The commonest breakage: the words change slightly, the thing does not.
    const value = score(
      'button:has-text("Verify & continue")',
      target('button:has-text("Verify and continue")', 'Verify and continue'),
    );
    expect(value).toBeGreaterThan(0.6);
  });

  it('rates an unrelated control near zero', () => {
    const value = score(
      'button:has-text("Verify & continue")',
      target('button:has-text("Delete account")', 'Delete account'),
    );
    expect(value).toBeLessThan(0.34);
  });

  it('survives a rename that keeps the wording', () => {
    // data-testid changed, the visible label did not.
    const value = score(
      '[data-testid="verify-school"]',
      target('button:has-text("Verify school")', 'Verify school'),
    );
    expect(value).toBeGreaterThan(0.5);
  });

  it('prefers a candidate of the same kind', () => {
    const sameTag = score(
      'input[placeholder="Email"]',
      target('input[placeholder="Email address"]', 'Email address', 'input'),
    );
    const otherTag = score(
      'input[placeholder="Email"]',
      target('button:has-text("Email address")', 'Email address', 'button'),
    );
    expect(sameTag).toBeGreaterThan(otherTag);
  });
});

describe('rank', () => {
  const page = [
    target('button:has-text("Verify and continue")', 'Verify and continue'),
    target('button:has-text("Delete account")', 'Delete account'),
    target('button:has-text("Back")', 'Back'),
    target('[data-testid="verify"]', 'Verify'),
  ];

  it('puts the likeliest replacement first', () => {
    const best = rank('button:has-text("Verify & continue")', page);
    expect(best[0]!.selector).toBe('button:has-text("Verify and continue")');
  });

  it('never suggests something unrelated', () => {
    const best = rank('button:has-text("Verify & continue")', page);
    // Offering a Delete button as a repair would be worse than failing.
    expect(best.map((b) => b.name)).not.toContain('Delete account');
  });

  it('returns nothing when the page has no plausible match', () => {
    expect(
      rank('button:has-text("Verify & continue")', [target('a[href="/"]', 'Home', 'a')]),
    ).toEqual([]);
  });

  it('offers a few candidates, not the whole page', () => {
    expect(rank('button:has-text("Verify")', page).length).toBeLessThanOrEqual(3);
  });
});

describe('nothing site-specific is baked in', () => {
  it('lets the confidence bar move for sites with unusual labels', async () => {
    const { DEFAULT_CONFIDENCE } = await import('../src/plan/repair.js');
    const page = [target('button:has-text("Go")', 'Go')];

    // Terse labels score low; a site full of them needs a lower bar.
    expect(rank('button:has-text("Continue")', page, 3, DEFAULT_CONFIDENCE)).toEqual([]);
    expect(rank('button:has-text("Continue")', page, 3, 0).length).toBeGreaterThan(0);
  });

  it('lets the caller ask for more candidates', () => {
    const page = [
      target('button:has-text("Verify one")', 'Verify one'),
      target('button:has-text("Verify two")', 'Verify two'),
      target('button:has-text("Verify three")', 'Verify three'),
      target('button:has-text("Verify four")', 'Verify four'),
    ];
    expect(rank('button:has-text("Verify")', page, 3).length).toBe(3);
    expect(rank('button:has-text("Verify")', page, 4).length).toBe(4);
  });
});

describe('a selector must not match on how it is written', () => {
  it('reads every attribute form, not just the double-quoted one', () => {
    // A spec written by hand is as likely to use ^= and single quotes; failing
    // to parse one leaves the raw selector standing in for its own meaning.
    expect(readSelector("[title^='Rectangle']").text).toBe('Rectangle');
    expect(readSelector('[title^="Rectangle"]').text).toBe('Rectangle');
    expect(readSelector("[title*='Rect']").text).toBe('Rect');
    expect(readSelector("input[placeholder^='STX']")).toEqual({ text: 'STX', tag: 'input' });
    expect(readSelector("button:has-text('Verify')").text).toBe('Verify');
  });

  it('never matches two controls just because both use a title attribute', () => {
    // This exact pair was once "repaired" on a live site: the only thing the
    // two shared was the word "title" from the selector syntax itself.
    const live = target('[title="Live collaboration..."]', 'Live collaboration...');
    expect(score("[title^='Nope']", live)).toBeLessThan(0.34);
    expect(rank("[title^='Nope']", [live])).toEqual([]);
  });

  it('still finds a genuine rename once the noise is gone', () => {
    const rect = target('[data-testid="toolbar-rectangle"]', 'Rectangle');
    expect(rank("[title^='Rectangle tool']", [rect])[0]?.selector).toBe(
      '[data-testid="toolbar-rectangle"]',
    );
  });
});

describe('patchSpec', () => {
  const source = [
    'baseUrl: https://example.com',
    'viewport: { width: 1280, height: 720 }',
    'steps:',
    '  - navigate: /',
    `  - click: "[title^='Rectangle']"`,
    "    note: 'Pick the rectangle tool.'",
    '  - drag: { from: [420, 260], to: [760, 470] }',
    '  - clickAt: [590, 360]',
    '',
  ].join('\n');

  const repair = (from: string, to: string, step = 5) => ({
    step,
    from,
    to,
    because: 'test',
  });

  it('changes only the selector, leaving the rest of the file alone', async () => {
    const { patchSpec } = await import('../src/plan/repair.js');
    const out = patchSpec(source, [
      repair("[title^='Rectangle']", '[data-testid="toolbar-rectangle"]'),
    ])!;

    // Everything a full rewrite would have reformatted must survive verbatim.
    expect(out).toContain('viewport: { width: 1280, height: 720 }');
    expect(out).toContain('  - drag: { from: [420, 260], to: [760, 470] }');
    expect(out).toContain('  - clickAt: [590, 360]');
    expect(out).toContain("    note: 'Pick the rectangle tool.'");
    expect(out).toContain('[data-testid="toolbar-rectangle"]');
    expect(out).not.toContain("[title^='Rectangle']");
  });

  it('produces exactly one changed line', async () => {
    const { patchSpec } = await import('../src/plan/repair.js');
    const out = patchSpec(source, [repair("[title^='Rectangle']", '#rect')])!;
    const before = source.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
  });

  it('quotes a selector containing double quotes without mangling it', async () => {
    const { patchSpec } = await import('../src/plan/repair.js');
    const { load } = await import('js-yaml');
    const out = patchSpec(source, [
      repair("[title^='Rectangle']", 'button:has-text("Verify & continue")'),
    ])!;
    const parsed = load(out) as { steps: Record<string, string>[] };
    expect(parsed.steps[1]!.click).toBe('button:has-text("Verify & continue")');
  });

  it('replaces each occurrence when one selector broke in two steps', async () => {
    const { patchSpec } = await import('../src/plan/repair.js');
    const twice = ['steps:', '  - click: "#a"', '  - waitFor: "#a"', ''].join('\n');
    const out = patchSpec(twice, [
      { step: 2, from: '#a', to: '#b', because: 't' },
      { step: 3, from: '#a', to: '#c', because: 't' },
    ])!;
    expect(out).toContain("- click: '#b'");
    expect(out).toContain("- waitFor: '#c'");
  });

  it('gives up rather than guessing when the selector is not found verbatim', async () => {
    const { patchSpec } = await import('../src/plan/repair.js');
    // The caller falls back to a full rewrite instead of writing something it
    // did not fully understand.
    expect(patchSpec(source, [repair('#not-in-the-file', '#x')])).toBeUndefined();
  });
});
