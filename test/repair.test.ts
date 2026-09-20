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
