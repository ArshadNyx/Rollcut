import yaml from 'js-yaml';
import { specSchema } from '../spec/schema.js';
/** Pause inserted where the person visibly waited, clamped to sane limits. */
const MIN_GAP_MS = 900;
const MAX_GAP_MS = 4000;
export const NOTES_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['notes'],
    properties: {
        notes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['step', 'note'],
                properties: {
                    step: { type: 'integer', description: '1-based index of the step this narrates.' },
                    note: {
                        type: ['string', 'null'],
                        description: 'One spoken sentence, or null to leave the step silent.',
                    },
                },
            },
        },
    },
};
const SYSTEM = `You write narration for a product demo video.

You are given the steps someone actually performed in an app, in order. Write a
spoken sentence for the steps that deserve one.

Rules:
- Narrate what the product is doing and why it matters, not the mechanics. Say
  "Every school has its own code", not "Click the input and type".
- Roughly half the steps should have a note. Leave the rest null; a wall of
  narration is worse than silence.
- The first step should almost always have one: it is where the viewer learns
  what they are looking at.
- Plain, declarative sentences. No marketing language, no exclamation marks.
- Narrate the product, not the person. Write "Every school has its own code",
  never "The user enters the school code" — nobody narrates a demo that way.
- A selector contains an element's label, which is not necessarily the name of
  a feature. Do not infer what something does from the text in a selector; if
  you are unsure what a step accomplishes, leave it null.
- Never invent features you cannot see in the steps.
- Do not read out credentials, codes or email addresses.`;
/** Turn recorded actions into spec steps, with waits where the person paused. */
export function toSteps(capture, titles = new Map()) {
    const steps = [];
    let previousAt = 0;
    let navigated = false;
    for (const action of capture.actions) {
        const produced = [];
        switch (action.kind) {
            case 'navigate':
                // The browser navigates as a *result* of a click; recording both would
                // make the spec click and then navigate to where the click already led.
                if (!navigated) {
                    produced.push({ navigate: action.selector ?? '/' });
                    navigated = true;
                }
                break;
            case 'click':
                if (action.selector)
                    produced.push({ click: action.selector });
                break;
            case 'type':
                if (action.text) {
                    // Click first: typing goes to whatever has focus, and a spec that
                    // types into nothing fails silently.
                    if (action.selector)
                        produced.push({ click: action.selector });
                    produced.push({ type: action.text });
                }
                break;
            case 'press':
                if (action.key)
                    produced.push({ press: action.key });
                break;
            case 'scroll':
                if (action.pixels)
                    produced.push({ scroll: Math.round(action.pixels) });
                break;
        }
        // An action that yields no step yields no pause either, or the spec fills
        // with waits that sit between nothing and nothing.
        if (produced.length === 0)
            continue;
        const gap = action.atMs - previousAt;
        if (steps.length > 0 && gap > MIN_GAP_MS) {
            // A pause the person took is a pause the viewer needs too.
            steps.push({ wait: Math.min(MAX_GAP_MS, Math.round(gap)) });
        }
        previousAt = action.atMs;
        if (action.kind === 'navigate' && action.text)
            titles.set(steps.length, action.text);
        steps.push(...produced);
    }
    if (!steps.some((s) => 'navigate' in s)) {
        steps.unshift({ navigate: capture.startPath });
    }
    return dropRepeatedClicks(steps);
}
/**
 * Collapse consecutive clicks on the same element.
 *
 * Someone clicking a field, pausing, and clicking it again is one intent, and
 * the click this code adds before a `type` often repeats the one the person
 * actually made.
 */
function dropRepeatedClicks(steps) {
    const out = [];
    for (const step of steps) {
        const previous = out[out.length - 1];
        const repeat = 'click' in step && previous && 'click' in previous && previous.click === step.click;
        if (repeat)
            continue;
        // A wait between two clicks on the same element is padding around an
        // intent that no longer exists.
        const beforeWait = out[out.length - 2];
        if ('click' in step &&
            previous &&
            'wait' in previous &&
            beforeWait &&
            'click' in beforeWait &&
            beforeWait.click === step.click) {
            out.pop();
            continue;
        }
        out.push(step);
    }
    return out;
}
/**
 * A readable description of a step, for the model to narrate.
 *
 * A click that only exists to focus a field is marked as such: left to itself
 * the model narrates it ("the app focuses the input"), which is mechanics
 * rather than product.
 */
function describe(step, next, title) {
    if ('navigate' in step) {
        return `open ${String(step.navigate)}${title ? ` — the "${title}" screen` : ''}`;
    }
    if ('click' in step) {
        return next && 'type' in next
            ? `focus a field (skip this one — narrate the next step instead)`
            : `click ${String(step.click)}`;
    }
    if ('type' in step)
        return `fill that field in`;
    if ('press' in step)
        return `press ${String(step.press)}`;
    if ('scroll' in step)
        return `scroll ${String(step.scroll)}px`;
    if ('wait' in step)
        return `wait ${String(step.wait)}ms`;
    return 'step';
}
/**
 * Build a spec from a capture, and optionally have a model write the notes.
 *
 * The split is deliberate: capture gets the mechanics exactly right because it
 * watched them happen, and the model only supplies words for what it is told
 * occurred. It never invents a step.
 */
export async function narrate(options) {
    const log = options.log ?? (() => undefined);
    const titles = new Map();
    const steps = toSteps(options.capture, titles);
    if (options.provider) {
        log(`writing narration with ${options.provider.name}…`);
        const listing = steps
            .map((s, i) => `${i + 1}. ${describe(s, steps[i + 1], titles.get(i))}`)
            .join('\n');
        const user = [
            `Site: ${options.capture.origin}`,
            '',
            'Steps performed:',
            listing,
            options.readme?.trim()
                ? `\nREADME (may be truncated):\n${options.readme.trim().slice(0, 6000)}`
                : '',
        ]
            .filter(Boolean)
            .join('\n');
        const proposed = (await options.provider.propose({
            system: SYSTEM,
            user,
            schema: NOTES_SCHEMA,
            maxSteps: steps.length,
        }));
        for (const entry of proposed.notes ?? []) {
            const target = steps[entry.step - 1];
            // A note on a step that does not exist is dropped rather than shifted
            // onto the wrong one.
            if (target && entry.note?.trim() && !('wait' in target)) {
                target.note = entry.note.trim();
            }
        }
    }
    const candidate = {
        baseUrl: options.capture.origin,
        viewport: { width: 1280, height: 720 },
        pauseMs: 700,
        steps,
    };
    const parsed = specSchema.safeParse(candidate);
    if (!parsed.success) {
        throw new Error(`The captured run did not produce a valid spec: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`);
    }
    return {
        spec: parsed.data,
        yaml: yaml.dump(parsed.data, { lineWidth: 100, quotingType: '"' }),
        narrated: parsed.data.steps.filter((s) => s.note).length,
    };
}
//# sourceMappingURL=narrate.js.map