import { describe, expect, it } from 'vitest';
import { lexicalMatcher, modelMatcher, withFallback } from '../src/plan/match.js';
import type { PageTarget } from '../src/plan/observe.js';
import type { PlanProvider } from '../src/plan/provider.js';

function target(selector: string, name: string, tag = 'button'): PageTarget {
  return { selector, name, role: tag, tag, navigates: false, at: [0, 0] };
}

/** Answers with a fixed decision and records what it was asked. */
function model(answer: unknown): { provider: PlanProvider; prompt: () => string } {
  let seen = '';
  return {
    provider: {
      name: 'stub',
      propose: async (r) => {
        seen = r.user;
        return answer;
      },
    },
    prompt: () => seen,
  };
}

const page = [
  target('button:has-text("Confirm school")', 'Confirm school'),
  target('button:has-text("Delete account")', 'Delete account'),
];

describe('lexicalMatcher', () => {
  it('finds a rename that kept the words', async () => {
    const got = await lexicalMatcher.pick('button:has-text("Verify continue")', [
      target('button:has-text("Verify and continue")', 'Verify and continue'),
    ]);
    expect(got[0]?.selector).toBe('button:has-text("Verify and continue")');
  });

  it('is blind to a rename that changed the words', async () => {
    // Documents the limitation the model fallback exists for: no shared
    // tokens between "Verify & continue" and "Confirm school".
    expect(await lexicalMatcher.pick('button:has-text("Verify & continue")', page)).toEqual([]);
  });
});

describe('modelMatcher', () => {
  it('returns the candidate it chose', async () => {
    const { provider } = model({ index: 0, confidence: 0.7, why: 'same purpose' });
    const got = await modelMatcher(provider).pick('button:has-text("Verify")', page);
    expect(got[0]).toMatchObject({
      selector: 'button:has-text("Confirm school")',
      confidence: 0.7,
      why: 'same purpose',
    });
  });

  it('accepts a refusal rather than forcing a pick', async () => {
    const { provider } = model({ index: null, confidence: 0, why: 'nothing plays that role' });
    expect(await modelMatcher(provider).pick('button:has-text("Verify")', page)).toEqual([]);
  });

  it('ignores an index that is not on the page', async () => {
    // A hallucinated index must not become a selector.
    const { provider } = model({ index: 99, confidence: 1, why: 'made up' });
    expect(await modelMatcher(provider).pick('button:has-text("Verify")', page)).toEqual([]);
  });

  it('does not call out to a model when there is nothing to choose between', async () => {
    const { provider, prompt } = model({ index: 0, confidence: 1, why: 'x' });
    expect(await modelMatcher(provider).pick('button:has-text("Verify")', [])).toEqual([]);
    expect(prompt()).toBe('');
  });

  it('tells the model what the selector used to name', async () => {
    const { provider, prompt } = model({ index: null, confidence: 0, why: '' });
    await modelMatcher(provider).pick('button:has-text("Verify & continue")', page);
    expect(prompt()).toContain('Verify & continue');
    expect(prompt()).toContain('Confirm school');
  });
});

describe('withFallback', () => {
  it('does not consult the model when word overlap already answered', async () => {
    const { provider, prompt } = model({ index: 1, confidence: 1, why: 'should not be used' });
    const matcher = withFallback(lexicalMatcher, modelMatcher(provider));
    const got = await matcher.pick('button:has-text("Confirm school")', page);

    expect(got[0]?.selector).toBe('button:has-text("Confirm school")');
    // The common case stays free and offline.
    expect(prompt()).toBe('');
  });

  it('falls through when word overlap finds nothing', async () => {
    const { provider, prompt } = model({ index: 0, confidence: 0.8, why: 'same purpose' });
    const matcher = withFallback(lexicalMatcher, modelMatcher(provider));
    const got = await matcher.pick('button:has-text("Verify & continue")', page);

    expect(got[0]?.selector).toBe('button:has-text("Confirm school")');
    expect(prompt()).not.toBe('');
  });
});
