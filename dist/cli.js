#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { DEFAULT_PROVIDER, PROVIDERS, runPipeline } from './pipeline.js';
import { plan } from './plan/planner.js';
import { DEFAULT_PLAN_PROVIDER, PLAN_PROVIDERS, loadPlanProvider } from './plan/provider.js';
const USAGE = `rollcut record <spec.yaml> [options]
rollcut plan <url> [options]

  --url <baseUrl>   Override the spec's baseUrl (preview deployments).
  --out <dir>       Output directory (default: out).
  --voice <name>    Override the spec's voice (names are provider-specific).
  --tts <name>      TTS provider: ${Object.keys(PROVIDERS).join(' | ')} (default: ${DEFAULT_PROVIDER}).
  --no-narration    Record silently; skip TTS and subtitles.
  --no-subtitles    Narrate, but do not burn subtitles.

Plan options:
  --readme <path>   Give the planner your README for context.
  --pages <n>       Pages to observe, landing page included (default: 4).
  --llm <name>      Planner backend: ${PLAN_PROVIDERS.join(' | ')} (default: ${DEFAULT_PLAN_PROVIDER}).
  --no-verify       Skip replaying the proposed spec in a browser.
  --out <file>      Write the proposed spec here instead of stdout.

Examples:
  pnpm rollcut record demos/excalidraw.yaml
  pnpm rollcut plan https://excalidraw.com --readme README.md`;
function parseArgs(argv) {
    const [command, spec, ...rest] = argv;
    const args = {
        command,
        spec,
        out: 'out',
        tts: process.env.ROLLCUT_TTS || DEFAULT_PROVIDER,
        llm: process.env.ROLLCUT_LLM || DEFAULT_PLAN_PROVIDER,
        verify: true,
        narration: true,
        subtitles: true,
    };
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === '--no-narration') {
            args.narration = false;
            continue;
        }
        if (flag === '--no-verify') {
            args.verify = false;
            continue;
        }
        if (flag === '--no-subtitles') {
            args.subtitles = false;
            continue;
        }
        const value = rest[++i];
        if (!value)
            throw new Error(`Flag ${flag} needs a value.\n\n${USAGE}`);
        if (flag === '--url')
            args.url = value;
        else if (flag === '--out') {
            args.out = value;
            args.planOut = value;
        }
        else if (flag === '--voice')
            args.voice = value;
        else if (flag === '--tts')
            args.tts = value;
        else if (flag === '--readme')
            args.readme = value;
        else if (flag === '--llm')
            args.llm = value;
        else if (flag === '--pages')
            args.pages = Number(value);
        else
            throw new Error(`Unknown flag ${flag}.\n\n${USAGE}`);
    }
    return args;
}
function human(bytes) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
/** Propose a spec from a URL. Writes a file; never records anything. */
async function runPlan(args) {
    const url = args.spec;
    if (!url) {
        console.error(USAGE);
        process.exit(1);
    }
    const readme = args.readme ? await readFile(args.readme, 'utf8') : undefined;
    const result = await plan({
        url,
        readme,
        provider: await loadPlanProvider(args.llm),
        maxPages: args.pages,
        verify: args.verify,
        log: (m) => console.error(m),
    });
    if (result.failures.length > 0) {
        console.error(`\nDropped ${result.failures.length} step(s) that failed when run:\n` +
            result.failures.map((f) => `  step ${f.step} (${f.kind}): ${f.reason}`).join('\n'));
    }
    if (result.rejected.length > 0) {
        console.error(`\nDropped ${result.rejected.length} step(s) using selectors that are not on the page:\n` +
            result.rejected.map((r) => `  ${r}`).join('\n'));
    }
    if (args.planOut) {
        await writeFile(args.planOut, result.yaml, 'utf8');
        console.error(`\nwrote ${args.planOut} — read it, edit it, then:`);
        console.error(`  pnpm rollcut record ${args.planOut}`);
    }
    else {
        console.log(result.yaml);
        console.error('\nReview this, save it, then run `rollcut record` on it.');
    }
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'plan') {
        await runPlan(args);
        return;
    }
    if (args.command !== 'record' || !args.spec) {
        console.error(USAGE);
        process.exit(1);
    }
    const started = Date.now();
    const result = await runPipeline({
        specPath: args.spec,
        outDir: args.out,
        url: args.url,
        voice: args.voice,
        tts: args.tts,
        narration: args.narration,
        subtitles: args.subtitles,
        log: (m) => console.log(m),
    });
    const [m, g] = await Promise.all([stat(result.mp4), stat(result.gif)]);
    console.log(`\n${result.mp4}  ${human(m.size)}  ${result.durationSeconds.toFixed(1)}s  ` +
        `${result.narrated ? `narrated (${result.lines} lines)` : 'silent'}`);
    console.log(`${result.gif}  ${human(g.size)}  silent${result.gifOversize ? '  ⚠ over 8 MB — too large to embed in a README' : ''}`);
    if (result.srt)
        console.log(`${result.srt}`);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
main().catch((err) => {
    console.error(`\nrollcut: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map