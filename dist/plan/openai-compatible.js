/**
 * One POST to an OpenAI-shaped `/chat/completions`, shared by every provider
 * that speaks that dialect. Uses `fetch` rather than an SDK: keeping this
 * behind PlanProvider is pointless if each backend drags in a dependency an
 * install may never call.
 */
export async function chatCompletion(config, request) {
    if (!config.apiKey) {
        throw new Error(`No ${config.label} credentials found. ${config.keyHint}`);
    }
    // Without constrained decoding the model has to be told the shape, and the
    // result is checked against the schema downstream either way.
    const system = config.structured === 'json_schema'
        ? request.system
        : `${request.system}\n\nReply with JSON only, matching this JSON Schema exactly:\n${JSON.stringify(request.schema)}`;
    let response;
    try {
        response = await fetch(config.endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: request.user },
                ],
                response_format: config.structured === 'json_schema'
                    ? {
                        type: 'json_schema',
                        json_schema: { name: 'rollcut_plan', schema: request.schema, strict: true },
                    }
                    : { type: 'json_object' },
            }),
        });
    }
    catch (e) {
        throw new Error(`Could not reach the ${config.label} API at ${config.endpoint}.`, { cause: e });
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Providers disagree on the status for a bad key — xAI answers 400, not
        // 401 — so the body has to be consulted or the user is sent to debug the
        // wrong thing.
        if (response.status === 401 || response.status === 403 || /api[ _-]?key/i.test(body)) {
            throw new Error(`${config.label} rejected the API key (HTTP ${response.status}). ${config.keyHint}`);
        }
        // Checked before the model branch: a rate-limit body mentions the model
        // too, and telling someone to change models when they need to wait sends
        // them to fix the wrong thing.
        if (response.status === 429 || /rate.?limit|too many requests|quota/i.test(body)) {
            const retry = response.headers.get('retry-after');
            throw new Error(`${config.label} is rate limiting this key${retry ? ` — retry in ${retry}s` : ''}. ` +
                'Wait and run it again, or set ROLLCUT_PLAN_MODEL to a model with more headroom.');
        }
        if (/model/i.test(body)) {
            throw new Error(`${config.label} rejected the model \`${config.model}\` (HTTP ${response.status}). ` +
                `Set ROLLCUT_PLAN_MODEL to one your account can use. ${body.slice(0, 200)}`);
        }
        throw new Error(`${config.label} returned HTTP ${response.status}. ${body.slice(0, 300)}`);
    }
    const data = (await response.json());
    if (data.error?.message)
        throw new Error(`${config.label} error: ${data.error.message}`);
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
        throw new Error(`${config.label} returned no plan (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'unknown'}).`);
    }
    try {
        return JSON.parse(content);
    }
    catch (e) {
        throw new Error(`${config.label} returned a plan that was not valid JSON.`, { cause: e });
    }
}
//# sourceMappingURL=openai-compatible.js.map