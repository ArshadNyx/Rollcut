import { chatCompletion } from './openai-compatible.js';
/**
 * Groq is the fast-inference provider. Not to be confused with Grok, xAI's
 * model — the two differ by one letter and use different keys and endpoints.
 *
 * Only some Groq models support constrained decoding; the default is one that
 * does. Point ROLLCUT_PLAN_MODEL elsewhere and strict may be ignored, which
 * the schema validation downstream will catch.
 */
export const groqPlanner = {
    name: 'groq',
    propose(request) {
        return chatCompletion({
            label: 'Groq',
            endpoint: process.env.ROLLCUT_GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions',
            model: process.env.ROLLCUT_PLAN_MODEL || 'openai/gpt-oss-120b',
            apiKey: process.env.GROQ_API_KEY,
            keyHint: 'Set GROQ_API_KEY — get one from https://console.groq.com/keys.',
            strict: true,
        }, request);
    },
};
//# sourceMappingURL=groq.js.map