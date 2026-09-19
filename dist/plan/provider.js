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
];
export const DEFAULT_PLAN_PROVIDER = 'anthropic';
/** Loaded on demand so an unused provider never costs an import. */
export async function loadPlanProvider(name) {
    if (name === 'anthropic')
        return (await import('./anthropic.js')).anthropicPlanner;
    const { PRESETS, presetPlanner } = await import('./presets.js');
    const preset = PRESETS[name];
    if (!preset) {
        throw new Error(`Unknown planner \`${name}\`. Use one of: ${PLAN_PROVIDERS.join(', ')}.`);
    }
    return presetPlanner(name, preset);
}
//# sourceMappingURL=provider.js.map