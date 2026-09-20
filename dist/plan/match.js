import { rank, readSelector } from './repair.js';
/**
 * Word overlap between the old selector and what is on the page.
 *
 * The default because it is instant, free and offline. Blind to a rename that
 * keeps the meaning but changes the words — "Verify & continue" to "Confirm
 * school" shares no tokens and scores zero.
 */
export const lexicalMatcher = {
    name: 'lexical',
    async pick(broken, candidates) {
        return rank(broken, candidates).map((candidate) => ({
            selector: candidate.selector,
            confidence: 1,
            why: candidate.name ? `matches "${candidate.name}" on the page` : 'closest remaining match',
        }));
    },
};
const PICK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['index', 'confidence', 'why'],
    properties: {
        index: {
            type: ['integer', 'null'],
            description: 'Which candidate replaced the missing element, or null if none did.',
        },
        confidence: { type: 'number', description: '0 to 1.' },
        why: { type: 'string', description: 'One short clause naming the evidence.' },
    },
};
const SYSTEM = `You decide which element on a page replaced one that is gone.

A demo script used a selector that no longer matches. You are given what it
used to point at, and the elements now on the page.

Pick the one that serves the same purpose — a button may have been reworded, a
test id renamed, a label rewritten. Judge by what the control is *for*, not by
shared words.

Answer null when nothing on the page plays that role. A wrong match sends a
demo clicking the wrong control, which is worse than reporting a break.`;
/**
 * Ask a model which candidate took over.
 *
 * Used only where the deterministic matcher finds nothing, so the common case
 * stays free and offline and the model is consulted for exactly the case it is
 * needed for: a rename that kept the meaning and changed the words.
 */
export function modelMatcher(provider) {
    return {
        name: provider.name,
        async pick(broken, candidates) {
            if (candidates.length === 0)
                return [];
            const listing = candidates
                .map((c, i) => `${i}. ${c.selector}  (${c.role})${c.name ? ` "${c.name}"` : ''}`)
                .join('\n');
            const answer = (await provider.propose({
                system: SYSTEM,
                user: [
                    `The selector that stopped working: ${broken}`,
                    `It used to name: "${readSelector(broken).text}"`,
                    '',
                    'Elements on the page now:',
                    listing,
                ].join('\n'),
                schema: PICK_SCHEMA,
                maxSteps: 1,
            }));
            const index = answer.index;
            if (index === null || index === undefined)
                return [];
            const chosen = candidates[index];
            if (!chosen)
                return [];
            return [
                {
                    selector: chosen.selector,
                    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0.5,
                    why: answer.why?.trim() || `chosen by ${provider.name}`,
                },
            ];
        },
    };
}
/**
 * Deterministic first, model only if that finds nothing.
 *
 * Keeps the fast, explainable path in charge and spends a call only on the
 * cases it cannot reach.
 */
export function withFallback(primary, fallback) {
    return {
        name: `${primary.name}+${fallback.name}`,
        async pick(broken, candidates) {
            const first = await primary.pick(broken, candidates);
            if (first.length > 0)
                return first;
            return fallback.pick(broken, candidates);
        },
    };
}
//# sourceMappingURL=match.js.map