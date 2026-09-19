import { chatCompletion } from './openai-compatible.js';
/** Grok is xAI's model. Not to be confused with Groq, the inference provider. */
export const grokPlanner = {
    name: 'grok',
    propose(request) {
        return chatCompletion({
            label: 'xAI',
            endpoint: process.env.ROLLCUT_GROK_URL || 'https://api.x.ai/v1/chat/completions',
            model: process.env.ROLLCUT_PLAN_MODEL || 'grok-4.6',
            apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
            keyHint: 'Set XAI_API_KEY — get one from https://console.x.ai.',
            strict: true,
        }, request);
    },
};
//# sourceMappingURL=grok.js.map