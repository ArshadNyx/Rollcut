import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import yaml from 'js-yaml';
import { ZodError } from 'zod';
import { isWebTarget, specSchema, type Spec } from './schema.js';

export const MAX_SPEC_BYTES = 256 * 1024;

/** Turn a zod issue path into something a human can find in the YAML. */
function locate(path: (string | number)[]): string {
  if (path.length === 0) return 'the spec root';
  const [head, index, ...rest] = path;
  if (head === 'steps' && typeof index === 'number') {
    const where = rest.length ? ` (field \`${rest.join('.')}\`)` : '';
    return `step ${index + 1}${where}`;
  }
  return `\`${path.join('.')}\``;
}

function explain(err: ZodError, file: string): string {
  const lines = err.issues.map((issue) => {
    const at = locate(issue.path as (string | number)[]);
    if (issue.code === 'invalid_union') {
      return `  - ${at}: not a valid step. Use one of: navigate, click, clickAt, drag, type, press, wait, scroll, hover, waitFor — one per step, plus an optional \`note\`.`;
    }
    if (issue.code === 'unrecognized_keys') {
      return `  - ${at}: unknown key(s) ${issue.keys.map((k) => `\`${k}\``).join(', ')}. Check the spelling against demos/excalidraw.yaml.`;
    }
    return `  - ${at}: ${issue.message}`;
  });
  return `${file} is not a valid Rollcut spec:\n${lines.join('\n')}`;
}

/** Public-only mode: the browser opens web addresses only, never a local file. */
export function checkPublicOnly(spec: Spec, path: string) {
  const bad = [
    spec.baseUrl,
    ...spec.steps.flatMap((s) => ('navigate' in s ? [s.navigate] : [])),
  ].find((t) => !isWebTarget(t, false));
  if (bad) throw new Error(`${path}: public-only mode opens web addresses only, not ${bad}`);
}

export async function loadSpec(path: string): Promise<Spec> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `Cannot read spec \`${path}\` — check the path. Example: rollcut record demos/excalidraw.yaml`,
    );
  }

  // Specs are a few KB; a cap keeps a hostile one from tying up the parser.
  if (Buffer.byteLength(raw) > MAX_SPEC_BYTES) {
    throw new Error(
      `${path} is ${Math.round(Buffer.byteLength(raw) / 1024)} KB; a spec can be at most ${MAX_SPEC_BYTES / 1024} KB.`,
    );
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    throw new Error(`${path} is not valid YAML — ${(e as Error).message}`, { cause: e });
  }

  const parsed = specSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(explain(parsed.error, relative(process.cwd(), path) || path));
  }
  if (process.env.ROLLCUT_PUBLIC_ONLY === '1') checkPublicOnly(parsed.data, path);
  return parsed.data;
}
