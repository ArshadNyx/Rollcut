import { chromium } from '@playwright/test';
import { specSchema, stepKind, type Spec, type Step } from '../spec/schema.js';
import { executeStep, resetPointer } from '../record/steps.js';

export interface StepFailure {
  /** 1-based, against the spec as proposed. */
  step: number;
  kind: string;
  reason: string;
}

export interface VerifyResult {
  /** The spec with unrunnable steps removed. */
  spec: Spec;
  failures: StepFailure[];
  /** Steps that ran cleanly. */
  passed: number;
}

/** A step that cannot be skipped without invalidating everything after it. */
function isStructural(step: Step): boolean {
  return 'navigate' in step;
}

export interface VerifyOptions {
  viewport?: { width: number; height: number };
  /** Overrides the spec's baseUrl, matching `record --url`. */
  url?: string;
  onStep?: (step: number, description: string, ok: boolean, reason?: string) => void;
}

/**
 * Replay a proposed spec in a real browser and drop the steps that fail.
 *
 * Static checks can only prove a selector was on the page when we looked.
 * Whether a step actually works — the element is reachable, nothing covers it,
 * the app is in the right state — is only answerable by doing it. Steps run
 * through the same executor the recorder uses, so a pass here means the same
 * thing it will mean during recording.
 */
export async function verify(spec: Spec, options: VerifyOptions = {}): Promise<VerifyResult> {
  const viewport = options.viewport ?? spec.viewport;
  const baseUrl = options.url ?? spec.baseUrl;
  const failures: StepFailure[] = [];
  const kept: Step[] = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    resetPointer();

    for (const [i, step] of spec.steps.entries()) {
      const n = i + 1;
      const kind = stepKind(step);
      try {
        await executeStep(page, step, n, {
          baseUrl,
          // Every navigate settles here: verification is not trying to be
          // fast, and an unsettled page produces failures that are about
          // timing rather than the spec.
          settle: 'navigate' in step,
        });
        kept.push(step);
        options.onStep?.(n, kind, true);
      } catch (e) {
        const reason = (e as Error).message.split('\n')[0] ?? 'failed';
        failures.push({ step: n, kind, reason });
        options.onStep?.(n, kind, false, reason);

        if (isStructural(step)) {
          // Everything after a failed navigate happens on the wrong page, so
          // there is nothing left worth verifying.
          for (let rest = i + 1; rest < spec.steps.length; rest++) {
            failures.push({
              step: rest + 1,
              kind: stepKind(spec.steps[rest]!),
              reason: 'skipped: an earlier navigate failed',
            });
          }
          break;
        }
      }
    }

    if (kept.length === 0) {
      // Returning a spec with no steps would just fail validation with a
      // message that hides the real cause.
      const first = failures[0];
      throw new Error(
        `No proposed step ran against \`${baseUrl}\`${
          first ? ` — step ${first.step} (${first.kind}) failed: ${first.reason}` : '.'
        }`,
      );
    }
  } finally {
    await browser.close();
  }

  // Re-validate: dropping steps must not produce a spec the recorder rejects.
  const parsed = specSchema.safeParse({ ...spec, steps: kept });
  if (!parsed.success) {
    throw new Error(
      `Verification left a spec that no longer validates: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  return { spec: parsed.data, failures, passed: kept.length };
}
