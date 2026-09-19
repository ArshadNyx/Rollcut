const MODEL = process.env.ROLLCUT_PLAN_MODEL || 'claude-opus-5';
/**
 * Claude-backed planner.
 *
 * Uses structured outputs so the model returns an object already conforming to
 * the spec schema — asking for raw YAML and parsing it invites a whole class of
 * formatting failures that have nothing to do with whether the plan is good.
 */
export const anthropicPlanner = {
    name: 'anthropic',
    async propose(request) {
        let Anthropic;
        try {
            ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
        }
        catch (e) {
            throw new Error('The planner needs `@anthropic-ai/sdk`, which is an optional dependency and is not installed here.\n' +
                '  Install it: pnpm add @anthropic-ai/sdk', { cause: e });
        }
        const client = new Anthropic();
        const response = await client.messages
            .create({
            model: MODEL,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            output_config: {
                format: { type: 'json_schema', schema: request.schema },
            },
        })
            .catch((e) => {
            // Credentials resolve lazily, so a missing key surfaces here as an
            // opaque SDK message rather than at construction.
            const message = e instanceof Error ? e.message : String(e);
            if (/authentication|api[_ -]?key|401/i.test(message)) {
                throw new Error('No Anthropic credentials found. Set one and try again:\n' +
                    '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
                    '  (or run `ant auth login`)', { cause: e });
            }
            throw e;
        });
        if (response.stop_reason === 'refusal') {
            throw new Error(`The model declined to plan this page${response.stop_details && 'category' in response.stop_details
                ? ` (${String(response.stop_details.category)})`
                : ''}. Write the spec by hand, or try a different page.`);
        }
        const text = response.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
        if (!text.trim()) {
            throw new Error(`The model returned no plan (stop_reason: ${response.stop_reason}). Try again, or narrow the page.`);
        }
        try {
            return JSON.parse(text);
        }
        catch (e) {
            throw new Error('The model returned a plan that was not valid JSON.', { cause: e });
        }
    },
};
//# sourceMappingURL=anthropic.js.map