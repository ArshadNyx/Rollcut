import { chatCompletion, type StructuredMode } from './openai-compatible.js';
import type { PlanProvider, ProposeRequest } from './provider.js';

export interface Preset {
  /** Shown in errors. */
  label: string;
  endpoint: string;
  /** Env vars holding the key, in order of preference. */
  envKeys: string[];
  defaultModel: string;
  /** Whether the provider can constrain output to a JSON Schema. */
  structured: StructuredMode;
  keyUrl: string;
  /** Override the endpoint, for region-specific or self-hosted deployments. */
  urlEnv?: string;
}

/**
 * Every backend here speaks the OpenAI chat-completions dialect, so adding one
 * is a row rather than a file. `strict` json_schema is only claimed where the
 * provider documents it; the rest fall back to json_object with the schema in
 * the prompt, and validation downstream catches the difference.
 */
export const PRESETS: Record<string, Preset> = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envKeys: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-5',
    structured: 'json_schema',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  grok: {
    label: 'xAI',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
    defaultModel: 'grok-4.6',
    structured: 'json_schema',
    keyUrl: 'https://console.x.ai',
    urlEnv: 'ROLLCUT_GROK_URL',
  },
  groq: {
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    envKeys: ['GROQ_API_KEY'],
    defaultModel: 'openai/gpt-oss-120b',
    structured: 'json_schema',
    keyUrl: 'https://console.groq.com/keys',
    urlEnv: 'ROLLCUT_GROQ_URL',
  },
  kimi: {
    label: 'Kimi',
    endpoint: 'https://api.moonshot.ai/v1/chat/completions',
    envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    defaultModel: 'kimi-k2.6',
    structured: 'json_schema',
    keyUrl: 'https://platform.kimi.ai',
  },
  qwen: {
    label: 'Qwen',
    // Model Studio is region-specific; override with ROLLCUT_QWEN_URL.
    endpoint: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions',
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    defaultModel: 'qwen-plus',
    // Model Studio does not document json_schema, so do not claim it.
    structured: 'json_object',
    keyUrl: 'https://bailian.console.alibabacloud.com',
    urlEnv: 'ROLLCUT_QWEN_URL',
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKeys: ['OPENROUTER_API_KEY'],
    defaultModel: 'openai/gpt-oss-120b',
    structured: 'json_schema',
    keyUrl: 'https://openrouter.ai/keys',
  },
  /** Anything else that speaks the dialect: set ROLLCUT_LLM_URL and _KEY. */
  custom: {
    label: 'custom endpoint',
    endpoint: '',
    envKeys: ['ROLLCUT_LLM_KEY'],
    defaultModel: '',
    structured: 'json_object',
    keyUrl: 'Set ROLLCUT_LLM_URL and ROLLCUT_LLM_KEY.',
    urlEnv: 'ROLLCUT_LLM_URL',
  },
};

function firstKey(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/** Build a provider from a preset, with env overrides applied. */
export function presetPlanner(name: string, preset: Preset): PlanProvider {
  return {
    name,
    async propose(request: ProposeRequest): Promise<unknown> {
      const endpoint = (preset.urlEnv ? process.env[preset.urlEnv] : undefined) || preset.endpoint;
      if (!endpoint) {
        throw new Error(
          `\`--llm ${name}\` needs an endpoint. Set ${preset.urlEnv ?? 'the endpoint'} to an OpenAI-compatible chat completions URL.`,
        );
      }
      const model = process.env.ROLLCUT_PLAN_MODEL || preset.defaultModel;
      if (!model) {
        throw new Error(`\`--llm ${name}\` needs a model. Set ROLLCUT_PLAN_MODEL.`);
      }
      return await chatCompletion(
        {
          label: preset.label,
          endpoint,
          model,
          apiKey: firstKey(preset.envKeys),
          keyHint: `Set ${preset.envKeys[0]} — ${preset.keyUrl}`,
          structured: preset.structured,
        },
        request,
      );
    },
  };
}
