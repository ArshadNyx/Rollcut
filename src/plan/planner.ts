import yaml from 'js-yaml';
import { specSchema, type Spec } from '../spec/schema.js';
import {
  normalisePath,
  observeSite,
  type PageObservation,
  type SiteObservation,
} from './observe.js';
import type { PlanProvider } from './provider.js';
import { verify, type StepFailure } from './verify.js';

/** What we ask the model for: a flat, discriminated shape it can get right. */
interface PlannedStep {
  kind:
    | 'navigate'
    | 'click'
    | 'hover'
    | 'waitFor'
    | 'type'
    | 'press'
    | 'wait'
    | 'scroll'
    | 'clickAt'
    | 'drag';
  // Nullable rather than absent: strict schema modes require every property to
  // be listed as required, so "not applicable" has to be expressible as null.
  selector?: string | null;
  text?: string | null;
  key?: string | null;
  ms?: number | null;
  pixels?: number | null;
  /** Canvas coordinates, only offered when the page has a drawing surface. */
  at?: [number, number] | null;
  from?: [number, number] | null;
  to?: [number, number] | null;
  note?: string | null;
}

export interface PlanResult {
  spec: Spec;
  yaml: string;
  site: SiteObservation;
  /** Steps dropped because they could not have worked, with the reason. */
  rejected: string[];
  /** Steps that were proposed but failed when actually run. */
  failures: StepFailure[];
  /** Whether the spec was replayed in a browser. */
  verified: boolean;
}

/** Longer demos are allowed; this is the default, not a ceiling. */
export const DEFAULT_MAX_STEPS = 14;

/**
 * The spec format is a union of single-key objects, which models get wrong in
 * fiddly ways. Asking for a flat discriminated shape and translating it here
 * keeps the failure modes in our code rather than in the prompt.
 */
const STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  // Constrained decoding (Groq's strict mode, and OpenAI-style strict in
  // general) requires every property to appear in `required`, so fields that do
  // not apply to a given step kind are nullable rather than omitted.
  required: ['kind', 'selector', 'text', 'key', 'ms', 'pixels', 'at', 'from', 'to', 'note'],
  properties: {
    kind: {
      type: 'string',
      enum: [
        'navigate',
        'click',
        'hover',
        'waitFor',
        'type',
        'press',
        'wait',
        'scroll',
        'clickAt',
        'drag',
      ],
    },
    selector: {
      type: ['string', 'null'],
      description:
        'For click, hover, waitFor, or scroll-to. Copy it verbatim from the page targets. Null otherwise.',
    },
    text: {
      type: ['string', 'null'],
      description: 'For navigate (a path) or type (the text to type). Null otherwise.',
    },
    key: {
      type: ['string', 'null'],
      description: 'For press, e.g. Escape or Enter. Null otherwise.',
    },
    ms: { type: ['integer', 'null'], description: 'For wait, in milliseconds. Null otherwise.' },
    pixels: {
      type: ['integer', 'null'],
      description: 'For scroll by a distance. Null otherwise.',
    },
    at: {
      type: ['array', 'null'],
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: 'For clickAt: [x, y] inside the canvas. Null otherwise.',
    },
    from: {
      type: ['array', 'null'],
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: 'For drag: the [x, y] to start from, inside the canvas. Null otherwise.',
    },
    to: {
      type: ['array', 'null'],
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: 'For drag: the [x, y] to end at, inside the canvas. Null otherwise.',
    },
    note: {
      type: ['string', 'null'],
      description: 'One spoken sentence of narration. Null for steps that need no commentary.',
    },
  },
};

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: { type: 'array', minItems: 3, maxItems: DEFAULT_MAX_STEPS, items: STEP_SCHEMA },
  },
};

const SYSTEM = `You plan short product demo videos.

You are given the interactive targets on a real page and, optionally, the
project's README. Produce a walkthrough that shows what the product is for.

Hard rules:
- Only use a selector that appears verbatim in the page targets. Never invent one.
- Several pages are listed below, each with its own targets. A selector is only
  valid on the page it is listed under. After a step marked [navigates], you
  are on that link's page — use only that page's targets from then on.
- You may only move between the pages listed. Never leave the product: no
  GitHub, no social links, no external sites.
- No logins, payments, sign-ups, or destructive actions.

Make it worth watching:
- The first step must navigate to the landing page (the first page listed) and
  must carry a note. That is where the viewer learns what they are looking at.
- Show one task with a visible result. A tool selected but never used, an undo
  immediately followed by a redo, or a menu opened and closed again, all
  demonstrate nothing.
- Match the page. If it is an app, do something in it. If it is mainly content
  — documentation, a landing page — the content is the demo: scroll down
  through it and narrate what it says. Do not hunt for controls to click.
- Roughly half the steps should carry a note; silent steps are fine.
- Write notes as spoken sentences: plain and declarative. Say what is happening
  and why it matters, not what the button is called. No marketing language.
- Keep it under ${DEFAULT_MAX_STEPS} steps.`;

/** Extra rules that only make sense when the page is a canvas app. */
function canvasRules(canvas: NonNullable<PageObservation['canvas']>): string {
  const x = canvas.x + Math.round(canvas.width / 2);
  const y = canvas.y + Math.round(canvas.height / 2);
  return `

This page is a canvas app: its content has no selectors, so clicking a tool
proves nothing on its own. You may use "clickAt" with an [x, y] point and
"drag" with [x, y] from/to points, but only inside the canvas, which spans
x ${canvas.x}-${canvas.x + canvas.width} and y ${canvas.y}-${canvas.y + canvas.height}
(its centre is roughly [${x}, ${y}]).

Select a tool with a selector, then actually use it on the canvas so the viewer
sees something appear. Keep drags well inside the canvas and away from the
toolbars at the edges.`;
}

function describe(site: SiteObservation, readme?: string): string {
  const parts: string[] = [`Site: ${site.origin}`];

  for (const page of site.pages) {
    const targets = page.elements
      .map(
        (e) =>
          `- ${e.selector}  (${e.role})${e.navigates ? ' [navigates]' : ''} ${e.name ? `"${e.name}"` : ''}`,
      )
      .join('\n');
    parts.push(
      '',
      `## Page ${page.path}`,
      `Title: ${page.title}`,
      page.headings.length ? `Headings: ${page.headings.slice(0, 8).join(' | ')}` : '',
      `Scrolls: ${page.scrollable ? 'yes' : 'no'}`,
      'Targets:',
      targets || '(none)',
    );
  }

  if (readme?.trim()) {
    // Truncating beats blowing the budget, and the top of a README is where
    // the pitch lives.
    parts.push('', 'README (may be truncated):', readme.trim().slice(0, 6000));
  }
  return parts.filter((line) => line !== '').join('\n');
}

/**
 * Translate the flat plan into the spec format.
 *
 * Steps are tracked against the page they run on: a click that navigates moves
 * the cursor to that page, and from then on selectors are checked against
 * *that* page's targets. A step landing on a page nobody observed is dropped,
 * because its selectors could not be verified.
 */
function toSpec(
  steps: PlannedStep[],
  site: SiteObservation,
  viewport: { width: number; height: number },
): { spec: unknown; rejected: string[] } {
  // Keyed by origin and path: a site can span subdomains, and "/" on the
  // marketing site is not "/" on the app.
  const key = (page: PageObservation) => `${new URL(page.url).origin}${page.path}`;
  const byPath = new Map<string, PageObservation>();
  for (const page of site.pages) {
    byPath.set(key(page), page);
    // Also reachable by the address that led here, before any redirect.
    if (page.requested) {
      try {
        const asked = new URL(page.requested);
        byPath.set(`${asked.origin}${normalisePath(asked.pathname)}`, page);
      } catch {
        // An unparseable request is simply not an extra way in.
      }
    }
  }
  const landingOrigin = new URL(site.pages[0]!.url).origin;

  /** How a step should refer to a page: relative at home, absolute elsewhere. */
  const target = (page: PageObservation): string =>
    new URL(page.url).origin === landingOrigin ? page.path : page.url;

  const find = (path: string): PageObservation | undefined => {
    const direct = byPath.get(`${landingOrigin}${normalisePath(path)}`);
    if (direct) return direct;
    // An absolute path already names its origin.
    try {
      const url = new URL(path);
      return byPath.get(`${url.origin}${normalisePath(url.pathname)}`);
    } catch {
      return site.pages.find((page) => page.path === normalisePath(path));
    }
  };
  const rejected: string[] = [];
  const out: Record<string, unknown>[] = [];

  const landing = site.pages[0]!;
  let current: PageObservation | undefined = landing;

  /** Where a link goes, if we observed it. */
  const destinationOf = (selector: string): PageObservation | undefined => {
    const href = /^a\[href="(.*)"\]$/.exec(selector)?.[1];
    if (!href) return undefined;
    try {
      const url = new URL(href, site.origin);
      return byPath.get(`${url.origin}${normalisePath(url.pathname)}`);
    } catch {
      return undefined;
    }
  };

  const inCanvas = (p?: [number, number] | null): p is [number, number] => {
    const canvas = current?.canvas;
    return Boolean(
      canvas &&
      p &&
      p[0] >= canvas.x &&
      p[0] <= canvas.x + canvas.width &&
      p[1] >= canvas.y &&
      p[1] <= canvas.y + canvas.height,
    );
  };

  for (const step of steps) {
    const note = step.note?.trim() ? { note: step.note.trim() } : {};
    const needsSelector = step.kind === 'click' || step.kind === 'hover' || step.kind === 'waitFor';

    if (needsSelector) {
      if (!step.selector) continue;
      if (!current) {
        rejected.push(`${step.selector} (on a page that was not observed)`);
        continue;
      }
      if (!current.elements.some((e) => e.selector === step.selector)) {
        // A selector the page never had would abort the whole recording, so it
        // is dropped here and reported rather than shipped into a spec.
        rejected.push(`${step.selector} (not on ${current.path})`);
        continue;
      }

      out.push({ [step.kind]: step.selector, ...note });

      if (step.kind === 'click') {
        const target = current.elements.find((e) => e.selector === step.selector);
        if (target?.navigates) current = destinationOf(step.selector);
      }
      continue;
    }

    switch (step.kind) {
      case 'navigate': {
        // Models reach for "/" out of habit. When that is not where the demo
        // starts, treat the opening navigate as meaning the landing page
        // rather than silently invalidating every step after it.
        const found = find(step.text || '/') ?? (out.length === 0 ? landing : undefined);
        out.push({ navigate: found ? target(found) : normalisePath(step.text || '/'), ...note });
        current = found;
        break;
      }
      case 'type':
        if (step.text) out.push({ type: step.text, ...note });
        break;
      case 'press':
        if (step.key) out.push({ press: step.key, ...note });
        break;
      case 'wait':
        out.push({ wait: Math.max(0, Math.round(step.ms ?? 1000)) });
        break;
      case 'clickAt':
        if (inCanvas(step.at)) out.push({ clickAt: step.at, ...note });
        else rejected.push(`clickAt ${JSON.stringify(step.at)} (outside the canvas)`);
        break;
      case 'drag':
        if (inCanvas(step.from) && inCanvas(step.to)) {
          out.push({ drag: { from: step.from, to: step.to }, ...note });
        } else {
          rejected.push(
            `drag ${JSON.stringify(step.from)}->${JSON.stringify(step.to)} (outside the canvas)`,
          );
        }
        break;
      case 'scroll':
        if (step.selector) {
          if (current?.elements.some((e) => e.selector === step.selector)) {
            out.push({ scroll: step.selector, ...note });
          } else {
            rejected.push(`${step.selector} (not on ${current?.path ?? 'an observed page'})`);
          }
        } else {
          out.push({ scroll: Math.round(step.pixels ?? 500), ...note });
        }
        break;
    }
  }

  // A demo has to start somewhere; the model is told this but may still skip it.
  if (!out.some((step) => 'navigate' in step)) out.unshift({ navigate: target(landing) });

  return {
    spec: {
      baseUrl: landingOrigin,
      viewport,
      pauseMs: 700,
      steps: dropNoOpPairs(out),
    },
    rejected,
  };
}

/**
 * Remove an undo immediately followed by a redo (or the reverse). The prompt
 * forbids it and models do it anyway: the pair looks like activity, leaves the
 * document exactly as it was, and burns seconds of a short video.
 */
function dropNoOpPairs(steps: Record<string, unknown>[]): Record<string, unknown>[] {
  const actionOf = (step: Record<string, unknown>): string | undefined => {
    const selector = step.click;
    if (typeof selector !== 'string') return undefined;
    if (/undo/i.test(selector)) return 'undo';
    if (/redo/i.test(selector)) return 'redo';
    return undefined;
  };

  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = actionOf(steps[i]!);
    const b = i + 1 < steps.length ? actionOf(steps[i + 1]!) : undefined;
    if ((a === 'undo' && b === 'redo') || (a === 'redo' && b === 'undo')) {
      i++; // skip both halves of the pair
      continue;
    }
    out.push(steps[i]!);
  }
  return out;
}

export interface PlanOptions {
  url: string;
  readme?: string;
  viewport?: { width: number; height: number };
  provider: PlanProvider;
  /** Pages to observe, landing page included. */
  maxPages?: number;
  /** Skip the browser pass and reuse an observation, e.g. to re-plan. */
  site?: SiteObservation;
  /** Replay the proposed spec and drop steps that fail. Default true. */
  verify?: boolean;
  log?: (message: string) => void;
}

/** url (+ README) -> a proposed spec. Never records; a human confirms. */
export async function plan(options: PlanOptions): Promise<PlanResult> {
  const log = options.log ?? (() => undefined);
  const viewport = options.viewport ?? { width: 1280, height: 720 };

  let site = options.site;
  if (!site) {
    log(`observing ${options.url}…`);
    site = await observeSite(options.url, {
      viewport,
      maxPages: options.maxPages,
      onPage: (path, count) => log(`  ${path} — ${count} targets`),
    });
  }

  const usable = site.pages.reduce((total, page) => total + page.elements.length, 0);
  if (usable === 0) {
    throw new Error(
      `No stable selectors found on \`${options.url}\`. The page may render after load or sit behind a login — write the spec by hand, or point at a page that shows the product.`,
    );
  }

  log(`planning with ${options.provider.name}…`);
  const landing = site.pages[0]!;
  const proposed = await options.provider.propose({
    system: landing.canvas ? SYSTEM + canvasRules(landing.canvas) : SYSTEM,
    user: describe(site, options.readme),
    schema: PLAN_SCHEMA,
    maxSteps: DEFAULT_MAX_STEPS,
  });

  const steps = (proposed as { steps?: PlannedStep[] }).steps;
  if (!Array.isArray(steps)) {
    throw new Error('The model returned a plan with no steps.');
  }

  const { spec: candidate, rejected } = toSpec(steps, site, viewport);

  // The generated spec goes through exactly the same validation a hand-written
  // one does; the planner gets no special treatment.
  const parsed = specSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `The proposed plan did not produce a valid spec: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  let final = parsed.data;
  let failures: StepFailure[] = [];
  const shouldVerify = options.verify !== false;

  if (shouldVerify) {
    log('verifying the plan in a browser…');
    const result = await verify(final, {
      viewport,
      onStep: (n, kind, ok, reason) =>
        log(`  step ${n}: ${kind} ${ok ? 'ok' : `failed — ${reason}`}`),
    });
    final = result.spec;
    failures = result.failures;
  }

  return {
    spec: final,
    yaml: yaml.dump(final, { lineWidth: 100, quotingType: '"' }),
    site,
    rejected,
    failures,
    verified: shouldVerify,
  };
}
