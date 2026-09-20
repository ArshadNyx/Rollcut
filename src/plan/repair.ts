import { chromium } from '@playwright/test';
import { specSchema, stepKind, type Spec, type Step } from '../spec/schema.js';
import { executeStep, resetPointer, wait } from '../record/steps.js';
import { collectTargets, type PageTarget } from './observe.js';
import { lexicalMatcher, type MatchProvider } from './match.js';

export interface Repair {
  /** 1-based index in the original spec. */
  step: number;
  from: string;
  to: string;
  /** Why this replacement was believed to be the same thing. */
  because: string;
}

export interface RepairResult {
  spec: Spec;
  repairs: Repair[];
  /** Steps that broke and could not be matched to anything on the page. */
  unrepaired: { step: number; selector: string; reason: string }[];
  /** True when the spec ran clean and nothing needed changing. */
  healthy: boolean;
}

/** The identifying text inside a selector, and the tag it was attached to. */
export function readSelector(selector: string): { text: string; tag?: string } {
  // Any operator and either quote style: a spec written by hand is as likely
  // to say [title^='Rectangle'] as [title="Rectangle"], and failing to parse
  // one leaves the raw selector standing in for its own meaning.
  const attr = /^(?:([a-z0-9]+))?\[[a-z-]+(?:[~^$*|]?=)?(?:"([^"]*)"|'([^']*)')?\]$/i.exec(
    selector,
  );
  if (attr) return { text: attr[2] ?? attr[3] ?? '', tag: attr[1] };

  const hasText = /^([a-z0-9]+):has-text\(["'](.*)["']\)$/i.exec(selector);
  if (hasText) return { text: hasText[2] ?? '', tag: hasText[1] };

  const id = /^#(.+)$/.exec(selector);
  if (id) return { text: id[1] ?? '' };

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

function tokens(value: string): string[] {
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
export function score(broken: string, candidate: PageTarget): number {
  const want = readSelector(broken);
  const wantTokens = tokens(want.text);
  const haveTokens = new Set([...tokens(candidate.name), ...tokens(candidate.selector)]);
  if (wantTokens.length === 0) return 0;

  const shared = wantTokens.filter((t) => haveTokens.has(t)).length;
  let value = shared / wantTokens.length;

  // One side containing the other survives "Verify" -> "Verify & continue".
  const a = want.text.toLowerCase();
  const b = candidate.name.toLowerCase();
  if (a && b && (a.includes(b) || b.includes(a))) value = Math.max(value, 0.75);

  // A penalty rather than a bonus: strong text matches already reach the top
  // of the range, where a bonus could not tell an input from a button.
  if (want.tag && want.tag !== candidate.tag) value *= 0.8;
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
export function rank(
  broken: string,
  candidates: PageTarget[],
  limit = 3,
  confidence = DEFAULT_CONFIDENCE,
): PageTarget[] {
  return candidates
    .map((candidate) => ({ candidate, value: score(broken, candidate) }))
    .filter((entry) => entry.value >= confidence)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * Try a step again before concluding it is broken.
 *
 * A live site fails a step occasionally for reasons that have nothing to do
 * with the spec — a slow response, an animation still settling. A drift check
 * that reports those gets ignored, and an ignored check is worse than none.
 */
async function runWithRetry(
  step: Step,
  run: (step: Step) => Promise<unknown>,
  pauseMs: number,
): Promise<void> {
  try {
    await run(step);
    return;
  } catch (first) {
    // Only worth retrying something that could plausibly settle; a selector
    // that is genuinely gone will not appear because we waited.
    if (!selectorOf(step)) throw first;
    await wait(Math.max(500, pauseMs));
    await run(step);
  }
}

function selectorOf(step: Step): string | undefined {
  if ('click' in step) return step.click;
  if ('hover' in step) return step.hover;
  if ('waitFor' in step) return step.waitFor;
  if ('scroll' in step && typeof step.scroll === 'string') return step.scroll;
  return undefined;
}

function withSelector(step: Step, selector: string): Step {
  const { note } = step as { note?: string };
  const rest = note ? { note } : {};
  if ('click' in step) return { click: selector, ...rest };
  if ('hover' in step) return { hover: selector, ...rest };
  if ('waitFor' in step) return { waitFor: selector, ...rest };
  return { scroll: selector, ...rest };
}

export interface RepairOptions {
  url?: string;
  viewport?: { width: number; height: number };
  /** How sure a match must be, 0 to 1. */
  confidence?: number;
  /** Replacements to try per broken step. */
  candidates?: number;
  /**
   * How replacements are chosen. Defaults to word overlap, which is instant
   * and offline; pass a model-backed one to catch renames that keep the
   * meaning but change the words.
   */
  matcher?: MatchProvider;
  onStep?: (step: number, message: string) => void;
}

/**
 * Replay a spec and mend the steps that no longer work.
 *
 * A replacement is tried on the live page before it is written down, so a
 * repair is something that demonstrably worked rather than a suggestion. The
 * run continues from whatever state the fix produced, which is the only way
 * later steps can be checked at all.
 */
export async function repair(spec: Spec, options: RepairOptions = {}): Promise<RepairResult> {
  const viewport = options.viewport ?? spec.viewport;
  const baseUrl = options.url ?? spec.baseUrl;
  const log = options.onStep ?? (() => undefined);

  const repairs: Repair[] = [];
  const unrepaired: RepairResult['unrepaired'] = [];
  const steps: Step[] = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    resetPointer();

    for (const [i, original] of spec.steps.entries()) {
      const n = i + 1;
      const run = (step: Step) =>
        executeStep(page, step, n, { baseUrl, settle: 'navigate' in step });

      try {
        await runWithRetry(original, run, spec.pauseMs);
        steps.push(original);
        // Replay at the pace the recorder uses. Run back-to-back, an app gets
        // no time to settle and steps fail that are not actually broken —
        // which for a repair tool means rewriting selectors that were fine.
        await wait(spec.pauseMs);
        continue;
      } catch (e) {
        const broken = selectorOf(original);
        if (!broken) {
          // Kept, not dropped: removing a step silently shortens the demo, and
          // a step that failed once may be fine on the next run.
          steps.push(original);
          unrepaired.push({ step: n, selector: '', reason: (e as Error).message.split('\n')[0]! });
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
          } catch {
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
          // Left exactly as it was. Repair reports what it could not mend; it
          // does not decide on the author's behalf that a step should go.
          steps.push(original);
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
  } finally {
    await browser.close();
  }

  const parsed = specSchema.safeParse({ ...spec, steps });
  if (!parsed.success) {
    throw new Error(
      `Repair left a spec that no longer validates: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  return {
    spec: parsed.data,
    repairs,
    unrepaired,
    healthy: repairs.length === 0 && unrepaired.length === 0,
  };
}

/** Quote a selector the way YAML needs, preferring the less noisy form. */
function yamlQuote(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Apply repairs to the original YAML text rather than re-serialising the spec.
 *
 * Dumping the parsed spec rewrites the whole file — flow style expands, quoting
 * changes, `clickAt: [590, 360]` becomes a three-line list — so a one-line fix
 * arrives as a hundred-line diff. Reading that diff is the one thing a person
 * must do before accepting a repair, so it has to stay small.
 *
 * Returns undefined when a selector cannot be found verbatim, so the caller can
 * fall back rather than write something it did not fully understand.
 */
export function patchSpec(source: string, repairs: Repair[]): string | undefined {
  let out = source;
  let from = 0;

  for (const repair of [...repairs].sort((a, b) => a.step - b.step)) {
    const at = out.indexOf(repair.from, from);
    if (at === -1) return undefined;

    let start = at;
    let end = at + repair.from.length;
    // Swallow the surrounding quotes so the replacement can choose its own.
    const before = out[start - 1];
    const after = out[end];
    if ((before === '"' && after === '"') || (before === "'" && after === "'")) {
      start -= 1;
      end += 1;
    }

    const replacement = yamlQuote(repair.to);
    out = out.slice(0, start) + replacement + out.slice(end);
    // Continue past this one: the same selector may be broken in two steps.
    from = start + replacement.length;
  }
  return out;
}
