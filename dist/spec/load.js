import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import yaml from 'js-yaml';
import { specSchema } from './schema.js';
/** Turn a zod issue path into something a human can find in the YAML. */
function locate(path) {
    if (path.length === 0)
        return 'the spec root';
    const [head, index, ...rest] = path;
    if (head === 'steps' && typeof index === 'number') {
        const where = rest.length ? ` (field \`${rest.join('.')}\`)` : '';
        return `step ${index + 1}${where}`;
    }
    return `\`${path.join('.')}\``;
}
function explain(err, file) {
    const lines = err.issues.map((issue) => {
        const at = locate(issue.path);
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
export async function loadSpec(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch {
        throw new Error(`Cannot read spec \`${path}\` — check the path. Example: rollcut record demos/excalidraw.yaml`);
    }
    let doc;
    try {
        doc = yaml.load(raw);
    }
    catch (e) {
        throw new Error(`${path} is not valid YAML — ${e.message}`, { cause: e });
    }
    const parsed = specSchema.safeParse(doc);
    if (!parsed.success) {
        throw new Error(explain(parsed.error, relative(process.cwd(), path) || path));
    }
    return parsed.data;
}
//# sourceMappingURL=load.js.map