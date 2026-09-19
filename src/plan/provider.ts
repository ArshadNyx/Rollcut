/**
 * The planner's view of an LLM. Deliberately narrow: one call, a JSON schema in,
 * a parsed object out. Anything provider-specific — structured output modes,
 * thinking, retries — lives inside an implementation, never here.
 */
export interface PlanProvider {
  readonly name: string;
  propose(request: ProposeRequest): Promise<unknown>;
}

export interface ProposeRequest {
  system: string;
  user: string;
  /** JSON Schema the returned object must satisfy. */
  schema: Record<string, unknown>;
  /** Hint for how much output to allow; implementations may ignore it. */
  maxSteps: number;
}

/** Planner backends, selected with `--llm`. */
export const PLAN_PROVIDERS = [
  'anthropic',
  'openai',
  'grok',
  'groq',
  'kimi',
  'qwen',
  'openrouter',
  'custom',
] as const;
export type PlanProviderName = (typeof PLAN_PROVIDERS)[number];
export const DEFAULT_PLAN_PROVIDER: PlanProviderName = 'anthropic';

/** Loaded on demand so an unused provider never costs an import. */
export async function loadPlanProvider(name: string): Promise<PlanProvider> {
  if (name === 'anthropic') return (await import('./anthropic.js')).anthropicPlanner;

  const { PRESETS, presetPlanner } = await import('./presets.js');
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown planner \`${name}\`. Use one of: ${PLAN_PROVIDERS.join(', ')}.`);
  }
  return presetPlanner(name, preset);
}
