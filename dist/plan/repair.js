import { chromium } from '@playwright/test';
import { specSchema, stepKind } from '../spec/schema.js';
import { executeStep, resetPointer, wait } from '../record/steps.js';
import { collectTargets } from './observe.js';
import { lexicalMatcher } from './match.js';
/** The identifying text inside a selector, and the tag it was attached to. */
export function readSelector(selector) {
    // Any operator and either quote style: a spec written by hand is as likely
    // to say [title^='Rectangle'] as [title="Rectangle"], and failing to parse
    // one leaves the raw selector standing in for its own meaning.
    const attr = /^(?:([a-z0-9]+))?\[[a-z-]+(?:[~^$*|]?=)?(?:"([^"]*)"|'([^']*)')?\]$/i.exec(selector);
    if (attr)
        return { text: attr[2] ?? attr[3] ?? '', tag: attr[1] };
    const hasText = /^([a-z0-9]+):has-text\(["'](.*)["']\)$/i.exec(selector);
    if (hasText)
        return { text: hasText[2] ?? '', tag: hasText[1] };
    const id = /^#(.+)$/.exec(selector);
    if (id)
        return { text: id[1] ?? '' };
    return { text: selector };
}
/**
 * Words that describe how an element is addressed rather than what it is.
 *
 * Without this, two unrelated controls both named by a `title` attribute share
 * the token "title" and look half alike — which is how a broken selector was
 * once "repaired" to an unrelated button.
 */
const STRUCTURAL = new Set([
    'title',
    'href',
    'aria',
    'label',
    'placeholder',
    'data',
    'testid',
    'test',
    'id',
    'name',
    'type',
    'role',
    'class',
    'button',
    'input',
    'div',
    'span',
    'has',
    'text',
]);
function tokens(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((t) => t.length > 1 && !STRUCTURAL.has(t));
}
/**
 * How likely a target is the thing the broken selector used to point at.
 *
 * Deliberately deterministic: a rename usually keeps most of the wording, and
 * a score you can explain beats a model's guess you cannot.
 */
export function score(broken, candidate) {
    const want = readSelector(broken);
    const wantTokens = tokens(want.text);
    const haveTokens = new Set([...tokens(candidate.name), ...tokens(candidate.selector)]);
    if (wantTokens.length === 0)
        return 0;
    const shared = wantTokens.filter((t) => haveTokens.has(t)).length;
    let value = shared / wantTokens.length;
    // One side containing the other survives "Verify" -> "Verify & continue".
    const a = want.text.toLowerCase();
    const b = candidate.name.toLowerCase();
    if (a && b && (a.includes(b) || b.includes(a)))
        value = Math.max(value, 0.75);
    // A penalty rather than a bonus: strong text matches already reach the top
    // of the range, where a bonus could not tell an input from a button.
    if (want.tag && want.tag !== candidate.tag)
        value *= 0.8;
    return Math.min(1, value);
}
/**
 * How sure a match must be before it is worth trying.
 *
 * Lower it for a site with terse labels, raise it for one where every control
 * reads alike. Overridable because no single number suits every site.
 */
export const DEFAULT_CONFIDENCE = 0.34;
/** Best matches first, weakest guesses discarded. */
export function rank(broken, candidates, limit = 3, confidence = DEFAULT_CONFIDENCE) {
    return candidates
        .map((candidate) => ({ candidate, value: score(broken, candidate) }))
        .filter((entry) => entry.value >= confidence)
        .sort((a, b) => b.value - a.value)
        .slice(0, limit)
        .map((entry) => entry.candidate);
}
function selectorOf(step) {
    if ('click' in step)
        return step.click;
    if ('hover' in step)
        return step.hover;
    if ('waitFor' in step)
        return step.waitFor;
    if ('scroll' in step && typeof step.scroll === 'string')
        return step.scroll;
    return undefined;
}
function withSelector(step, selector) {
    const { note } = step;
    const rest = note ? { note } : {};
    if ('click' in step)
        return { click: selector, ...rest };
    if ('hover' in step)
        return { hover: selector, ...rest };
    if ('waitFor' in step)
        return { waitFor: selector, ...rest };
    return { scroll: selector, ...rest };
}
/**
 * Replay a spec and mend the steps that no longer work.
 *
 * A replacement is tried on the live page before it is written down, so a
 * repair is something that demonstrably worked rather than a suggestion. The
 * run continues from whatever state the fix produced, which is the only way
 * later steps can be checked at all.
 */
export async function repair(spec, options = {}) {
    const viewport = options.viewport ?? spec.viewport;
    const baseUrl = options.url ?? spec.baseUrl;
    const log = options.onStep ?? (() => undefined);
    const repairs = [];
    const unrepaired = [];
    const steps = [];
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        resetPointer();
        for (const [i, original] of spec.steps.entries()) {
            const n = i + 1;
            const run = (step) => executeStep(page, step, n, { baseUrl, settle: 'navigate' in step });
            try {
                await run(original);
                steps.push(original);
                // Replay at the pace the recorder uses. Run back-to-back, an app gets
                // no time to settle and steps fail that are not actually broken —
                // which for a repair tool means rewriting selectors that were fine.
                await wait(spec.pauseMs);
                continue;
            }
            catch (e) {
                const broken = selectorOf(original);
                if (!broken) {
                    unrepaired.push({ step: n, selector: '', reason: e.message.split('\n')[0] });
                    continue;
                }
                log(n, `${stepKind(original)} ${broken} failed — looking for a replacement`);
                // The page is wherever the spec left it, which is exactly where the
                // missing element was supposed to be.
                const present = await collectTargets(page);
                const matcher = options.matcher ?? lexicalMatcher;
                const candidates = (await matcher.pick(broken, present)).slice(0, options.candidates ?? 3);
                let mended = false;
                for (const candidate of candidates) {
                    const attempt = withSelector(original, candidate.selector);
                    try {
                        await run(attempt);
                    }
                    catch {
                        continue;
                    }
                    steps.push(attempt);
                    await wait(spec.pauseMs);
                    repairs.push({ step: n, from: broken, to: candidate.selector, because: candidate.why });
                    log(n, `repaired: ${broken} -> ${candidate.selector}`);
                    mended = true;
                    break;
                }
                if (!mended) {
                    unrepaired.push({
                        step: n,
                        selector: broken,
                        reason: candidates.length
                            ? 'no candidate on the page worked'
                            : 'nothing on the page resembles it',
                    });
                    log(n, `could not repair ${broken}`);
                }
            }
        }
    }
    finally {
        await browser.close();
    }
    const parsed = specSchema.safeParse({ ...spec, steps });
    if (!parsed.success) {
        throw new Error(`Repair left a spec that no longer validates: ${parsed.error.issues
            .map((issue) => issue.message)
            .join('; ')}`);
    }
    return {
        spec: parsed.data,
        repairs,
        unrepaired,
        healthy: repairs.length === 0 && unrepaired.length === 0,
    };
}
//# sourceMappingURL=repair.js.map