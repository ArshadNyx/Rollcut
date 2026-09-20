import { describe, expect, it } from 'vitest';
import { PLAN_SCHEMA, plan } from '../src/plan/planner.js';
import type { PageObservation, SiteObservation } from '../src/plan/observe.js';
import type { PlanProvider } from '../src/plan/provider.js';

const observation: PageObservation = {
  url: 'https://example.com/app',
  path: '/app',
  title: 'Example App',
  headings: ['Welcome'],
  scrollable: true,
  links: [],
  elements: [
    {
      selector: '[data-testid="new"]',
      name: 'New',
      role: 'button',
      tag: 'button',
      navigates: false,
      at: [100, 50],
    },
    {
      selector: '#search',
      name: 'Search',
      role: 'input:text',
      tag: 'input',
      navigates: false,
      at: [300, 50],
    },
    {
      selector: 'a[href="/docs"]',
      name: 'Docs',
      role: 'link',
      tag: 'a',
      navigates: true,
      at: [500, 50],
    },
  ],
};

/** One observed page, as a site — most cases only need the landing page. */
function siteOf(page: PageObservation): SiteObservation {
  return { origin: new URL(page.url).origin, pages: [page] };
}

/** Returns whatever it is told to, so the translation layer is what's tested. */
function stub(steps: unknown[]): PlanProvider {
  return { name: 'stub', propose: async () => ({ steps }) };
}

describe('plan', () => {
  it('translates a flat plan into the spec format', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/', note: 'This is Example App.' },
        { kind: 'waitFor', selector: '[data-testid="new"]' },
        { kind: 'click', selector: '[data-testid="new"]', note: 'Start something new.' },
        { kind: 'type', text: 'hello' },
        { kind: 'press', key: 'Enter' },
        { kind: 'wait', ms: 800 },
        { kind: 'scroll', pixels: 400 },
      ]),
    });

    expect(result.spec.baseUrl).toBe('https://example.com');
    expect(result.spec.steps).toEqual([
      { navigate: '/app', note: 'This is Example App.' },
      { waitFor: '[data-testid="new"]' },
      { click: '[data-testid="new"]', note: 'Start something new.' },
      { type: 'hello' },
      { press: 'Enter' },
      { wait: 800 },
      { scroll: 400 },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('drops steps whose selectors are not on the page, and reports them', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: '#invented-by-the-model' },
        { kind: 'click', selector: '[data-testid="new"]' },
        { kind: 'scroll', selector: '.also-invented' },
      ]),
    });

    // Each rejection names the page it was checked against.
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]).toMatch(/^#invented-by-the-model \(not on \/app\)$/);
    expect(result.rejected[1]).toMatch(/^\.also-invented \(not on \/app\)$/);
    expect(JSON.stringify(result.spec.steps)).not.toContain('invented');
    expect(result.spec.steps).toContainEqual({ click: '[data-testid="new"]' });
  });

  it('always starts with a navigate, even if the model forgets', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'waitFor', selector: '#search' },
        { kind: 'click', selector: '#search' },
        { kind: 'type', text: 'x' },
      ]),
    });
    expect(result.spec.steps[0]).toEqual({ navigate: '/app' });
  });

  it('emits YAML that round-trips back into a valid spec', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/', note: 'Here it is.' },
        { kind: 'waitFor', selector: 'a[href="/docs"]' },
        { kind: 'click', selector: 'a[href="/docs"]', note: 'Open the docs.' },
      ]),
    });
    expect(result.yaml).toContain('baseUrl: https://example.com');
    expect(result.yaml).toContain('a[href="/docs"]');

    const { load } = await import('js-yaml');
    const { specSchema } = await import('../src/spec/schema.js');
    expect(specSchema.safeParse(load(result.yaml)).success).toBe(true);
  });

  it('refuses to plan a page with no usable targets', async () => {
    await expect(
      plan({
        url: observation.url,
        site: siteOf({ ...observation, elements: [] }),
        verify: false,
        provider: stub([]),
      }),
    ).rejects.toThrow(/No stable selectors/);
  });

  it('rejects a model response with no steps array', async () => {
    await expect(
      plan({
        url: observation.url,
        site: siteOf(observation),
        verify: false,
        provider: { name: 'stub', propose: async () => ({ nonsense: true }) },
      }),
    ).rejects.toThrow(/no steps/);
  });

  it('constrains the schema it asks the model for', () => {
    expect(PLAN_SCHEMA.additionalProperties).toBe(false);
    const steps = (PLAN_SCHEMA.properties as Record<string, Record<string, unknown>>).steps!;
    expect(steps.maxItems).toBe(14);
  });
});

describe('provider selection', () => {
  it('loads each named provider', async () => {
    const { loadPlanProvider, PLAN_PROVIDERS } = await import('../src/plan/provider.js');
    for (const name of PLAN_PROVIDERS) {
      expect((await loadPlanProvider(name)).name).toBe(name);
    }
  });

  it('names the valid options when given an unknown one', async () => {
    const { loadPlanProvider } = await import('../src/plan/provider.js');
    await expect(loadPlanProvider('nope')).rejects.toThrow(/anthropic, openai, grok, groq/);
  });
});

describe('OpenAI-compatible providers', () => {
  const allKeys = [
    'XAI_API_KEY',
    'GROK_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
    'OPENROUTER_API_KEY',
    'ROLLCUT_LLM_KEY',
    'ROLLCUT_PLAN_MODEL',
  ];

  async function withoutKeys<T>(fn: () => Promise<T>): Promise<T> {
    const saved = allKeys.map((k) => [k, process.env[k]] as const);
    for (const k of allKeys) delete process.env[k];
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) if (v) process.env[k] = v;
    }
  }

  const expectedKey: Record<string, RegExp> = {
    openai: /OPENAI_API_KEY/,
    grok: /XAI_API_KEY/,
    groq: /GROQ_API_KEY/,
    kimi: /MOONSHOT_API_KEY/,
    qwen: /DASHSCOPE_API_KEY/,
    openrouter: /OPENROUTER_API_KEY/,
  };

  it('each backend names its own credential, never another one', async () => {
    const { loadPlanProvider } = await import('../src/plan/provider.js');
    await withoutKeys(async () => {
      for (const [name, pattern] of Object.entries(expectedKey)) {
        const provider = await loadPlanProvider(name);
        await expect(
          provider.propose({ system: 's', user: 'u', schema: {}, maxSteps: 5 }),
        ).rejects.toThrow(pattern);
      }
    });
  });

  it('keeps grok and groq distinct despite the one-letter difference', async () => {
    const { loadPlanProvider } = await import('../src/plan/provider.js');
    await withoutKeys(async () => {
      const groq = await loadPlanProvider('groq');
      await expect(
        groq.propose({ system: 's', user: 'u', schema: {}, maxSteps: 5 }),
      ).rejects.not.toThrow(/XAI/);
    });
  });

  it('asks for an endpoint when using a custom backend', async () => {
    const { loadPlanProvider } = await import('../src/plan/provider.js');
    await withoutKeys(async () => {
      const custom = await loadPlanProvider('custom');
      await expect(
        custom.propose({ system: 's', user: 'u', schema: {}, maxSteps: 5 }),
      ).rejects.toThrow(/ROLLCUT_LLM_URL/);
    });
  });

  it('only claims json_schema where the provider documents it', async () => {
    const { PRESETS } = await import('../src/plan/presets.js');
    expect(PRESETS.groq!.structured).toBe('json_schema');
    expect(PRESETS.kimi!.structured).toBe('json_schema');
    // Model Studio does not document json_schema, so it must not be claimed.
    expect(PRESETS.qwen!.structured).toBe('json_object');
  });

  it('every listed provider resolves', async () => {
    const { loadPlanProvider, PLAN_PROVIDERS } = await import('../src/plan/provider.js');
    for (const name of PLAN_PROVIDERS) {
      expect((await loadPlanProvider(name)).name).toBe(name);
    }
  });
});

describe('plan schema under strict decoding', () => {
  it('lists every step property as required, so strict modes accept it', () => {
    const steps = (PLAN_SCHEMA.properties as Record<string, Record<string, unknown>>).steps!;
    const item = steps.items as Record<string, unknown>;
    const required = item.required as string[];
    expect(Object.keys(item.properties as object).sort()).toEqual(required.slice().sort());
    expect(item.additionalProperties).toBe(false);
  });

  it('treats a null field as absent when translating', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        {
          kind: 'navigate',
          text: '/',
          selector: null,
          key: null,
          ms: null,
          pixels: null,
          note: null,
        },
        { kind: 'wait', ms: null, selector: null, text: null, key: null, pixels: null, note: null },
      ]),
    });
    expect(result.spec.steps[0]).toEqual({ navigate: '/app' });
    expect(result.spec.steps[1]).toEqual({ wait: 1000 });
  });
});

describe('no-op pruning', () => {
  it('drops an undo immediately followed by a redo', async () => {
    const withHistory: PageObservation = {
      ...observation,
      elements: [
        ...observation.elements,
        {
          selector: '[data-testid="button-undo"]',
          name: 'Undo',
          role: 'button',
          tag: 'button',
          navigates: false,
          at: [10, 10],
        },
        {
          selector: '[data-testid="button-redo"]',
          name: 'Redo',
          role: 'button',
          tag: 'button',
          navigates: false,
          at: [30, 10],
        },
      ],
    };
    const result = await plan({
      url: observation.url,
      site: siteOf(withHistory),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: '[data-testid="new"]' },
        { kind: 'click', selector: '[data-testid="button-undo"]' },
        { kind: 'click', selector: '[data-testid="button-redo"]' },
      ]),
    });
    const json = JSON.stringify(result.spec.steps);
    expect(json).not.toContain('undo');
    expect(json).not.toContain('redo');
    expect(result.spec.steps).toContainEqual({ click: '[data-testid="new"]' });
  });

  it('keeps an undo that is not immediately undone again', async () => {
    const withUndo: PageObservation = {
      ...observation,
      elements: [
        ...observation.elements,
        {
          selector: '[data-testid="button-undo"]',
          name: 'Undo',
          role: 'button',
          tag: 'button',
          navigates: false,
          at: [10, 10],
        },
      ],
    };
    const result = await plan({
      url: observation.url,
      site: siteOf(withUndo),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: '[data-testid="button-undo"]', note: 'Undo that.' },
        { kind: 'click', selector: '[data-testid="new"]' },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).toContain('undo');
  });
});

describe('canvas steps', () => {
  const canvasPage: PageObservation = {
    ...observation,
    canvas: { x: 0, y: 0, width: 1280, height: 720 },
  };

  it('accepts drag and clickAt inside the canvas', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(canvasPage),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'drag', from: [400, 300], to: [800, 500], note: 'Draw a shape.' },
        { kind: 'clickAt', at: [640, 360] },
      ]),
    });
    expect(result.spec.steps).toContainEqual({
      drag: { from: [400, 300], to: [800, 500] },
      note: 'Draw a shape.',
    });
    expect(result.spec.steps).toContainEqual({ clickAt: [640, 360] });
    expect(result.rejected).toEqual([]);
  });

  it('rejects coordinates outside the canvas', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf({ ...canvasPage, canvas: { x: 0, y: 0, width: 400, height: 400 } }),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'clickAt', at: [900, 900] },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).not.toContain('clickAt');
    expect(result.rejected.join(' ')).toMatch(/outside the canvas/);
  });

  it('rejects canvas steps entirely when the page has no canvas', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'drag', from: [100, 100], to: [200, 200] },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).not.toContain('drag');
    expect(result.rejected.join(' ')).toMatch(/outside the canvas/);
  });
});

describe('single-page enforcement', () => {
  // Both models tested clicked a link and then kept using selectors from the
  // original page, which fails at record time. The prompt asks them not to;
  // this makes it impossible.
  it('drops selector steps that follow a navigating click', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: 'a[href="/docs"]', note: 'Open the docs.' },
        { kind: 'click', selector: '[data-testid="new"]', note: 'This page is gone.' },
        { kind: 'waitFor', selector: '#search' },
      ]),
    });
    expect(result.spec.steps).toContainEqual({ click: 'a[href="/docs"]', note: 'Open the docs.' });
    expect(JSON.stringify(result.spec.steps)).not.toContain('data-testid="new"');
    expect(result.rejected.join(' ')).toMatch(/on a page that was not observed/);
  });

  it('keeps selector steps after clicking something that does not navigate', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: '[data-testid="new"]' },
        { kind: 'click', selector: '#search' },
      ]),
    });
    expect(result.spec.steps).toContainEqual({ click: '#search' });
    expect(result.rejected).toEqual([]);
  });

  it('treats a second navigate as leaving the page', async () => {
    const result = await plan({
      url: observation.url,
      site: siteOf(observation),
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'navigate', text: '/other' },
        { kind: 'click', selector: '[data-testid="new"]' },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).not.toContain('data-testid="new"');
  });
});

describe('multi-page plans', () => {
  const docs: PageObservation = {
    url: 'https://example.com/docs',
    path: '/docs',
    title: 'Docs',
    headings: ['Getting started'],
    scrollable: true,
    links: [],
    elements: [
      {
        selector: '#install',
        name: 'Install',
        role: 'button',
        tag: 'button',
        navigates: false,
        at: [100, 200],
      },
    ],
  };
  const site: SiteObservation = { origin: 'https://example.com', pages: [observation, docs] };

  it('lets a demo follow a link and keep going on the page it lands on', async () => {
    const result = await plan({
      url: observation.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/app', note: 'Here is the app.' },
        { kind: 'click', selector: 'a[href="/docs"]', note: 'Open the docs.' },
        { kind: 'waitFor', selector: '#install' },
        { kind: 'click', selector: '#install', note: 'Install it.' },
      ]),
    });

    expect(result.rejected).toEqual([]);
    expect(result.spec.steps).toContainEqual({ waitFor: '#install' });
    expect(result.spec.steps).toContainEqual({ click: '#install', note: 'Install it.' });
  });

  it('still rejects a selector that belongs to the page it just left', async () => {
    const result = await plan({
      url: observation.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/app' },
        { kind: 'click', selector: 'a[href="/docs"]' },
        // #search is on /app, not /docs.
        { kind: 'click', selector: '#search' },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).not.toContain('#search');
    expect(result.rejected.join(' ')).toMatch(/#search \(not on \/docs\)/);
  });

  it('follows an explicit navigate to another observed page', async () => {
    const result = await plan({
      url: observation.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/app' },
        { kind: 'navigate', text: '/docs', note: 'Over to the docs.' },
        { kind: 'click', selector: '#install' },
      ]),
    });
    expect(result.rejected).toEqual([]);
    expect(result.spec.steps).toContainEqual({ click: '#install' });
  });

  it('drops steps after navigating somewhere nobody observed', async () => {
    const result = await plan({
      url: observation.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/app' },
        { kind: 'navigate', text: '/nowhere' },
        { kind: 'click', selector: '#install' },
      ]),
    });
    expect(JSON.stringify(result.spec.steps)).not.toContain('#install');
    expect(result.rejected.join(' ')).toMatch(/not observed/);
  });
});

describe('crawl policy is not an opinion about your product', () => {
  it('does not refuse to look at sign-in pages', async () => {
    const { DEFAULT_AVOID } = await import('../src/plan/observe.js');
    // For a great many products the sign-in flow *is* the demo.
    expect(DEFAULT_AVOID.test('/auth/login')).toBe(false);
    expect(DEFAULT_AVOID.test('/signup')).toBe(false);
    expect(DEFAULT_AVOID.test('/auth/school-code')).toBe(false);
  });

  it('still avoids what would end the session or cost money', async () => {
    const { DEFAULT_AVOID } = await import('../src/plan/observe.js');
    expect(DEFAULT_AVOID.test('/logout')).toBe(true);
    expect(DEFAULT_AVOID.test('/checkout')).toBe(true);
    expect(DEFAULT_AVOID.test('/account/billing')).toBe(true);
  });
});

describe('a site can span subdomains', () => {
  const marketing: PageObservation = {
    url: 'https://www.example.com/',
    path: '/',
    title: 'Marketing',
    headings: [],
    scrollable: false,
    links: ['https://app.example.com'],
    elements: [
      {
        selector: 'a[href="https://app.example.com"]',
        name: 'Open the app',
        role: 'link',
        tag: 'a',
        navigates: true,
        at: [10, 10],
      },
    ],
  };
  const app: PageObservation = {
    url: 'https://app.example.com/auth/login',
    requested: 'https://app.example.com/',
    path: '/auth/login',
    title: 'Sign in',
    headings: [],
    scrollable: false,
    links: [],
    elements: [
      {
        selector: '#email',
        name: 'Email',
        role: 'input:text',
        tag: 'input',
        navigates: false,
        at: [20, 20],
      },
    ],
  };
  const site: SiteObservation = { origin: 'https://www.example.com', pages: [marketing, app] };

  it('refers to another subdomain by absolute URL, not a bare path', async () => {
    // `/auth/login` against the marketing origin is a different, wrong page.
    const result = await plan({
      url: marketing.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'navigate', text: '/auth/login' },
        { kind: 'click', selector: '#email' },
      ]),
    });
    expect(result.spec.steps).toContainEqual({ navigate: 'https://app.example.com/auth/login' });
    expect(result.spec.steps).toContainEqual({ click: '#email' });
  });

  it('keeps using a bare path for the landing origin', async () => {
    const result = await plan({
      url: marketing.url,
      site,
      verify: false,
      provider: stub([{ kind: 'navigate', text: '/' }]),
    });
    expect(result.spec.steps[0]).toEqual({ navigate: '/' });
  });

  it('follows a link across subdomains and validates against the page it reaches', async () => {
    const result = await plan({
      url: marketing.url,
      site,
      verify: false,
      provider: stub([
        { kind: 'navigate', text: '/' },
        { kind: 'click', selector: 'a[href="https://app.example.com"]' },
        { kind: 'click', selector: '#email' },
      ]),
    });
    expect(result.rejected).toEqual([]);
    expect(result.spec.steps).toContainEqual({ click: '#email' });
  });
});

describe('sameSite', () => {
  it('treats a marketing site and its app subdomain as one product', async () => {
    const { sameSite } = await import('../src/plan/observe.js');
    expect(sameSite('app.teacherosapp.com', 'www.teacherosapp.com')).toBe(true);
    expect(sameSite('admin.example.com', 'example.com')).toBe(true);
  });

  it('does not wander onto somebody else"s site', async () => {
    const { sameSite } = await import('../src/plan/observe.js');
    expect(sameSite('github.com', 'www.example.com')).toBe(false);
    expect(sameSite('teacher-os.github.io', 'www.teacherosapp.com')).toBe(false);
  });
});

describe('provider errors say what to do', () => {
  /** Stands in for a provider responding with a given status and body. */
  function respond(status: number, body: string, headers: Record<string, string> = {}) {
    return async () =>
      new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  async function callWith(fetchImpl: typeof fetch): Promise<string> {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    process.env.GROQ_API_KEY = 'test-key';
    try {
      const { loadPlanProvider } = await import('../src/plan/provider.js');
      const provider = await loadPlanProvider('groq');
      await provider.propose({ system: 's', user: 'u', schema: {}, maxSteps: 3 });
      return '';
    } catch (e) {
      return (e as Error).message;
    } finally {
      globalThis.fetch = original;
      delete process.env.GROQ_API_KEY;
    }
  }

  it('calls a rate limit a rate limit, not a bad model', async () => {
    // The body names the model, so a naive check sends the user to change it.
    const message = await callWith(
      respond(429, '{"error":{"message":"Rate limit reached for model `x` ... TPM"}}', {
        'retry-after': '30',
      }),
    );
    expect(message).toMatch(/rate limiting/i);
    expect(message).toMatch(/30s/);
    expect(message).not.toMatch(/a model your account can use/);
  });

  it('still points at the model when the model really is wrong', async () => {
    const message = await callWith(
      respond(400, '{"error":{"message":"model `nope` does not exist"}}'),
    );
    expect(message).toMatch(/ROLLCUT_PLAN_MODEL/);
  });

  it('still points at the key when the key is wrong', async () => {
    const message = await callWith(respond(401, '{"error":{"message":"Invalid API Key"}}'));
    expect(message).toMatch(/GROQ_API_KEY/);
  });
});
